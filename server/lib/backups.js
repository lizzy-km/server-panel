'use strict';
/**
 * Backups: scheduled or on-demand copies of databases and folders, kept on the server (and optionally in S3).
 *
 * The backup itself is a plain bash script stored ON the server and started by a systemd timer, so backups keep
 * running when the panel is closed. The panel only creates/edits the script, shows the results (each run writes a
 * manifest.json next to its files, so the server is the source of truth) and drives restores.
 *
 * Safety rules:
 *  - a database restore replaces the database only after a safety dump, and puts the old contents back on failure;
 *  - a folder restore goes to a staging folder unless "in place" is chosen, which first saves the current files;
 *  - S3 secrets are stored encrypted by the panel and live on the server only in a root-only (0600) env file.
 */
const crypto = require('crypto');
const { httpError } = require('./auth');
const { shq } = require('./host');
const { DatabaseManager, ENGINES } = require('./databases');

const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const PATH_RE = /^\/[A-Za-z0-9._/@+-]{1,300}$/;
const DB_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const RUN_RE = /^\d{14}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,120}$/;
const EXCLUDE_RE = /^[A-Za-z0-9._*/-]{1,80}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{2,62}$/;
const KEY_RE = /^[A-Za-z0-9/+=_-]{8,128}$/;
const FORBIDDEN_PATHS = ['/', '/proc', '/sys', '/dev', '/run', '/boot', '/tmp'];

function onCalendar(s) {
  const hh = String(s.hour ?? 2).padStart(2, '0'); const mm = String(s.minute ?? 30).padStart(2, '0');
  if (s.kind === 'hourly') return `*-*-* *:${mm}:00`;
  if (s.kind === 'daily') return `*-*-* ${hh}:${mm}:00`;
  if (s.kind === 'weekly') return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.weekday ?? 0]} *-*-* ${hh}:${mm}:00`;
  return '';
}

function slug(p) { return p.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '').slice(0, 60) || 'root'; }

class BackupManager {
  constructor({ store, vault, servers, config, databases, deploy }) {
    Object.assign(this, { store, vault, servers, config, databases, deploy });
    if (!store.data.backups) store.data.backups = [];
    this.runner = deploy.runner;
    this.running = new Map(); // jobId -> run id
  }

  get jobs() { return this.store.data.backups; }
  find(id) { const j = this.jobs.find((x) => x.id === id); if (!j) throw httpError(404, 'Unknown backup job'); return j; }
  forServer(serverId) { return this.jobs.filter((j) => j.serverId === serverId); }
  hostOf(job) { return this.servers.entry(job.serverId).host; }
  jobDir(job) { return `${this.config.backupRoot}/${job.id}`; }
  scriptPath(job) { return `${this.config.backupScriptDir}/${job.id}.sh`; }
  envPath(job) { return `${this.config.backupScriptDir}/${job.id}.env`; }
  unitName(job) { return `panel-backup-${job.id}`; }

  // ------------------------------------------------------------------ validation / public view

  clean(input, { serverId, partial = false, selfId = null } = {}) {
    const has = (k) => !partial || input[k] !== undefined;
    const out = {};
    if (has('name')) {
      const n = String(input.name || '').trim().toLowerCase();
      if (!NAME_RE.test(n)) throw httpError(400, 'Name: lowercase letters, digits and dashes, starting with a letter (max 31)');
      if (this.jobs.some((j) => j.serverId === serverId && j.name === n && j.id !== selfId)) throw httpError(409, 'A backup job with that name already exists on this server');
      out.name = n;
    }
    if (has('sources')) {
      const src = input.sources;
      if (!Array.isArray(src) || !src.length || src.length > 20) throw httpError(400, 'Choose what to back up (1 to 20 items)');
      out.sources = src.map((s) => {
        if (s && s.type === 'db') {
          if (!ENGINES[s.engine]) throw httpError(400, 'Unknown database engine');
          if (!DB_RE.test(String(s.name || ''))) throw httpError(400, 'Invalid database name');
          if (ENGINES[s.engine].systemDbs.includes(String(s.name).toLowerCase())) throw httpError(400, 'System databases are not backed up here');
          return { type: 'db', engine: s.engine, name: String(s.name) };
        }
        if (s && s.type === 'path') {
          const p = String(s.path || '').trim().replace(/\/+$/, '');
          if (!PATH_RE.test(p) || p.includes('..') || FORBIDDEN_PATHS.includes(p)) throw httpError(400, `Invalid folder: ${p || '(empty)'}. Use an absolute path with letters, digits and . _ - / @ + only`);
          return { type: 'path', path: p };
        }
        if (s && s.type === 'app') {
          const app = this.deploy.apps.find((a) => a.id === s.appId && a.serverId === serverId);
          if (!app) throw httpError(400, 'Unknown app');
          return { type: 'app', appId: app.id };
        }
        throw httpError(400, 'Each item must be a database, a folder or an app');
      });
    }
    if (has('excludes')) {
      const ex = input.excludes === undefined ? [] : input.excludes;
      if (!Array.isArray(ex) || ex.length > 20 || !ex.every((e) => EXCLUDE_RE.test(String(e)))) throw httpError(400, 'Excludes: up to 20 simple patterns like node_modules or *.log');
      out.excludes = ex.map(String);
    }
    if (has('keep')) {
      const k = Number(input.keep === undefined ? 7 : input.keep);
      if (!Number.isInteger(k) || k < 1 || k > 365) throw httpError(400, 'Keep between 1 and 365 backups');
      out.keep = k;
    }
    if (has('schedule')) {
      const s = input.schedule || { kind: 'manual' };
      if (!['manual', 'hourly', 'daily', 'weekly'].includes(s.kind)) throw httpError(400, 'Schedule must be manual, hourly, daily or weekly');
      const hour = Number(s.hour ?? 2); const minute = Number(s.minute ?? 30); const weekday = Number(s.weekday ?? 0);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59 || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw httpError(400, 'Invalid schedule time');
      out.schedule = { kind: s.kind, hour, minute, weekday };
    }
    if (has('s3')) {
      const s = input.s3;
      if (!s || !s.enabled) out.s3 = null;
      else {
        if (!BUCKET_RE.test(String(s.bucket || ''))) throw httpError(400, 'S3 bucket name is not valid');
        const prefix = String(s.prefix || '').replace(/^\/+|\/+$/g, '');
        if (prefix && !/^[A-Za-z0-9._/-]{1,100}$/.test(prefix)) throw httpError(400, 'S3 folder: letters, digits and . _ - / only');
        const region = String(s.region || 'us-east-1');
        if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw httpError(400, 'S3 region looks wrong (e.g. eu-west-1)');
        const endpoint = String(s.endpoint || '');
        if (endpoint && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(endpoint)) throw httpError(400, 'S3 endpoint must be an https:// address (leave empty for AWS)');
        out.s3 = { bucket: String(s.bucket), prefix, region, endpoint, accessKey: String(s.accessKey || '') };
        if (out.s3.accessKey && !KEY_RE.test(out.s3.accessKey)) throw httpError(400, 'S3 access key looks wrong');
        if (s.secretKey && !KEY_RE.test(String(s.secretKey))) throw httpError(400, 'S3 secret key looks wrong');
        out._s3secret = s.secretKey ? String(s.secretKey) : null;
      }
    }
    return out;
  }

  publicJob(job) {
    return {
      id: job.id, serverId: job.serverId, name: job.name, sources: job.sources, excludes: job.excludes || [], keep: job.keep, schedule: job.schedule,
      s3: job.s3 ? { enabled: true, bucket: job.s3.bucket, prefix: job.s3.prefix, region: job.s3.region, endpoint: job.s3.endpoint, accessKey: job.s3.accessKey, hasSecret: !!job.s3SecretEnc } : { enabled: false },
      running: this.running.has(job.id), runningId: this.running.get(job.id) || null, lastRunId: job.lastRunId || null, created: job.created, installed: !!job.installed,
    };
  }

  async create(serverId, input, user) {
    const v = this.clean(input, { serverId });
    const job = { id: crypto.randomBytes(6).toString('hex'), serverId, ...v, created: new Date().toISOString(), createdBy: user, installed: false };
    if (job.s3) { if (!input.s3.secretKey || !job.s3.accessKey) throw httpError(400, 'Enter the S3 access key and secret key'); job.s3SecretEnc = this.vault.encrypt(String(input.s3.secretKey)); }
    delete job._s3secret;
    this.jobs.push(job);
    try { await this.install(job); } catch (e) { this.jobs.splice(this.jobs.indexOf(job), 1); throw e; }
    this.store.save();
    return job;
  }

  async update(id, input) {
    const job = this.find(id);
    if (this.running.has(id)) throw httpError(409, 'This backup is running right now');
    const v = this.clean(input, { partial: true, serverId: job.serverId, selfId: id });
    const secret = v._s3secret; delete v._s3secret;
    const before = structuredClone(job);
    Object.assign(job, v);
    if (v.s3 === null) job.s3SecretEnc = null;
    if (v.s3 && secret) job.s3SecretEnc = this.vault.encrypt(secret);
    if (job.s3 && !job.s3SecretEnc) { Object.assign(job, before); throw httpError(400, 'Enter the S3 secret key'); }
    try { await this.install(job); } catch (e) { Object.assign(job, before); throw e; }
    this.store.save();
    return job;
  }

  async remove(id, { deleteFiles = false } = {}) {
    const job = this.find(id);
    if (this.running.has(id)) throw httpError(409, 'This backup is running right now');
    const host = this.hostOf(job);
    await host.connect();
    const u = this.unitName(job);
    await host.runPriv('systemctl', ['stop', `${u}.timer`]).catch(() => {});
    await host.runPriv('systemctl', ['disable', `${u}.timer`]).catch(() => {});
    await host.runPriv('rm', ['-f', `${this.config.unitDir}/${u}.timer`, `${this.config.unitDir}/${u}.service`, this.scriptPath(job), this.envPath(job)]);
    await host.runPriv('systemctl', ['daemon-reload']).catch(() => {});
    if (deleteFiles) await host.runPriv('rm', ['-rf', '--', this.jobDir(job)]);
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.store.save();
  }

  // ------------------------------------------------------------------ the script that runs on the server

  resolveSources(job) {
    return job.sources.map((s) => {
      if (s.type !== 'app') return s;
      const app = this.deploy.apps.find((a) => a.id === s.appId);
      if (!app) throw httpError(400, 'A backed-up app no longer exists; edit the job to remove it');
      return { type: 'path', path: `${this.deploy.appDir(app)}/shared`, label: `${app.name} data` };
    });
  }

  script(job, owner) {
    const jobDir = this.jobDir(job);
    const sources = this.resolveSources(job);
    const parts = [];
    sources.forEach((s, i) => {
      if (s.type === 'db') {
        const file = `db-${s.engine}-${s.name}.sql.gz`;
        parts.push(`item db ${shq(file)} ${shq(`${s.engine}:${s.name}`)} <<'DUMP'\n${DatabaseManager.dumpCommand(s.engine, s.name)}\nDUMP`);
      } else {
        const file = `files-${i + 1}-${slug(s.path)}.tar.gz`;
        const ex = (job.excludes || []).map((e) => `--exclude=${shq(e)}`).join(' ');
        parts.push(`item path ${shq(file)} ${shq(s.path)} <<'TAR'\nif [ ! -e ${shq(s.path)} ]; then echo "missing: ${s.path}" >&2; exit 3; fi\ntar -czf "$1" -C / ${ex} -- ${shq(s.path.replace(/^\//, ''))}\nrc=$?; [ $rc -le 1 ] && tar -tzf "$1" >/dev/null\nTAR`);
      }
    });
    const s3 = job.s3;
    return `#!/bin/bash
# Generated by the panel for backup job "${job.name}". Editing this file is pointless: the panel rewrites it.
set -uo pipefail
umask 077
ID=${shq(job.id)}; ROOT=${shq(jobDir)}; KEEP=${job.keep}; OWNER=${shq(owner)}; ENVF=${shq(this.envPath(job))}
TS=$(date +%Y%m%d%H%M%S); OUT="$ROOT/$TS"
priv() { "$@"; }
mkdir -p "$OUT"
echo "@@RUN $TS"
ITEMS=""; FAILED=0; TOTAL=0
esc() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr -d '\\n'; }
# item <type> <file> <source>  (the command that creates "$1" is read from stdin)
item() {
  local type="$1" file="$2" src="$3" cmd st=ok err="" bytes=0
  cmd=$(cat)
  echo "==> $type: $src"
  if ! err=$( (set -- "$OUT/$file"; eval "$cmd") 2>&1 >/dev/null ); then st=failed; FAILED=1; echo "!! failed: $err" | tail -3; rm -f "$OUT/$file"
  else
    if [[ "$file" == *.sql.gz ]]; then gzip -t "$OUT/$file" 2>/dev/null || { st=failed; FAILED=1; err="the dump is not a valid gzip file"; rm -f "$OUT/$file"; }; fi
    [ -f "$OUT/$file" ] && bytes=$(stat -c %s "$OUT/$file") && TOTAL=$((TOTAL + bytes)) && echo "    $file ($bytes bytes)"
  fi
  [ -n "$ITEMS" ] && ITEMS="$ITEMS,"
  ITEMS="$ITEMS{\\"type\\":\\"$type\\",\\"file\\":\\"$(esc "$file")\\",\\"source\\":\\"$(esc "$src")\\",\\"bytes\\":$bytes,\\"status\\":\\"$st\\",\\"error\\":\\"$(esc "$(printf '%s' "$err" | tail -1)")\\"}"
}
${parts.join('\n')}
UPLOADED=n/a
if [ "$FAILED" = 0 ]${s3 ? ` ; then
  UPLOADED=failed
  if [ -f "$ENVF" ]; then set -a; . "$ENVF"; set +a; fi
  if command -v aws >/dev/null 2>&1; then
    echo "==> Uploading to s3://${s3.bucket}/${s3.prefix ? s3.prefix + '/' : ''}$ID/$TS/"
    if aws s3 cp "$OUT" "s3://${s3.bucket}/${s3.prefix ? s3.prefix + '/' : ''}$ID/$TS/" --recursive --only-show-errors ${s3.endpoint ? `--endpoint-url ${shq(s3.endpoint)}` : ''}; then UPLOADED=yes; else echo "!! Upload to S3 failed (the local copy is kept)"; fi
  else echo "!! The AWS CLI is not installed on this server (Backups → Install AWS CLI); the local copy is kept"; fi
fi` : '; then :; fi'}
STATUS=ok; [ "$FAILED" = 0 ] || STATUS=failed
[ "$UPLOADED" = failed ] && STATUS=ok-not-uploaded
printf '{"job":"%s","run":"%s","time":"%s","status":"%s","uploaded":"%s","bytes":%s,"items":[%s]}\\n' "$ID" "$TS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STATUS" "$UPLOADED" "$TOTAL" "$ITEMS" > "$OUT/manifest.json"
[ "$FAILED" = 0 ] && touch "$OUT/.complete"
# retention: keep the newest $KEEP complete backups (older ones, and failed runs beyond 5, are removed)
n=0; f=0
for d in $(ls -1d "$ROOT"/[0-9]*/ 2>/dev/null | sort -r); do
  if [ -f "$d/.complete" ]; then n=$((n + 1)); [ $n -gt $KEEP ] && rm -rf "$d"; else f=$((f + 1)); [ $f -gt 5 ] && rm -rf "$d"; fi
done
cp "$OUT/manifest.json" "$ROOT/last.json" 2>/dev/null
chown -R "$OWNER" "$ROOT" 2>/dev/null || true
echo "@@STATE $STATUS"
[ "$FAILED" = 0 ] && echo "Backup finished: $TOTAL bytes in $OUT" || echo "!! Backup finished with errors. Nothing was deleted from your server."
exit $FAILED
`;
  }

  /** Write the script, its secrets and the systemd timer to the server. */
  async install(job) {
    const host = this.hostOf(job);
    await host.connect();
    const owner = host.username || 'root';
    const sd = this.config.backupScriptDir;
    const put = async (file, content, mode) => {
      const r = await host.runPriv('tee', [file], { stdin: content });
      if (!r.ok) throw httpError(500, `Could not write ${file}: ${(r.stderr || '').trim().split('\n').pop()}`);
      await host.runPriv('chmod', [mode, file]);
    };
    let r = await host.runPriv('mkdir', ['-p', sd, this.jobDir(job)]);
    if (!r.ok) throw httpError(400, `Could not create the backup folders (needs sudo): ${(r.stderr || '').trim()}`);
    await host.runPriv('chown', [owner, this.jobDir(job)]);
    await host.runPriv('chmod', ['700', sd, this.jobDir(job)]);
    await put(this.scriptPath(job), this.script(job, owner), '700');
    if (job.s3 && job.s3SecretEnc) {
      await put(this.envPath(job), `AWS_ACCESS_KEY_ID=${shq(job.s3.accessKey)}\nAWS_SECRET_ACCESS_KEY=${shq(this.vault.decrypt(job.s3SecretEnc))}\nAWS_DEFAULT_REGION=${shq(job.s3.region)}\n`, '600');
    } else await host.runPriv('rm', ['-f', this.envPath(job)]);
    const u = this.unitName(job);
    const unitDir = this.config.unitDir;
    if (job.schedule.kind === 'manual') {
      await host.runPriv('systemctl', ['stop', `${u}.timer`]).catch(() => {});
      await host.runPriv('systemctl', ['disable', `${u}.timer`]).catch(() => {});
      await host.runPriv('rm', ['-f', `${unitDir}/${u}.timer`, `${unitDir}/${u}.service`]);
    } else {
      await put(`${unitDir}/${u}.service`, `[Unit]\nDescription=Panel backup ${job.name}\n\n[Service]\nType=oneshot\nExecStart=/bin/bash ${this.scriptPath(job)}\nNice=10\nIOSchedulingClass=idle\n`, '644');
      await put(`${unitDir}/${u}.timer`, `[Unit]\nDescription=Panel backup ${job.name} schedule\n\n[Timer]\nOnCalendar=${onCalendar(job.schedule)}\nPersistent=true\nRandomizedDelaySec=60\n\n[Install]\nWantedBy=timers.target\n`, '644');
      await host.runPriv('systemctl', ['daemon-reload']);
      r = await host.runPriv('systemctl', ['enable', `${u}.timer`]);
      if (!r.ok) throw httpError(500, `Could not enable the schedule: ${(r.stderr || '').trim()}`);
      r = await host.runPriv('systemctl', ['start', `${u}.timer`]);
      if (!r.ok) throw httpError(500, `Could not start the schedule: ${(r.stderr || '').trim()}`);
    }
    job.installed = true;
  }

  async timerState(job) {
    if (job.schedule.kind === 'manual') return { scheduled: false };
    const host = this.hostOf(job);
    const r = await host.run('systemctl', ['is-active', `${this.unitName(job)}.timer`]);
    const out = { scheduled: true, active: r.stdout.trim() === 'active', when: onCalendar(job.schedule) };
    return out;
  }

  // ------------------------------------------------------------------ running and listing

  async run(id, user) {
    const job = this.find(id);
    if (this.running.has(id)) throw httpError(409, 'This backup is already running');
    const host = this.hostOf(job);
    await host.connect();
    await this.install(job); // make sure the server has the current version of the script
    const runId = crypto.randomUUID();
    this.running.set(id, runId);
    job.lastRunId = runId;
    this.store.save();
    const priv = host.useSudo && host.username !== 'root' ? 'sudo -n ' : '';
    this.runner.run({ id: runId, host, script: `${priv}bash ${shq(this.scriptPath(job))}\n`, timeout: 6 * 3600 * 1000 })
      .catch(() => {}).finally(() => this.running.delete(id));
    return { id: runId, user };
  }

  async runs(id) {
    const job = this.find(id);
    const host = this.hostOf(job);
    await host.connect();
    const dir = this.jobDir(job);
    const r = await host.run('bash', ['-s'], { stdin: `for d in $(ls -1d ${shq(dir)}/[0-9]*/ 2>/dev/null | sort -r); do cat "$d/manifest.json" 2>/dev/null || echo "{\\"run\\":\\"$(basename "$d")\\",\\"status\\":\\"incomplete\\",\\"items\\":[]}"; done\n`, timeout: 30000 });
    const out = [];
    for (const line of r.stdout.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* damaged manifest: skip */ } }
    return out;
  }

  async manifest(job, run) {
    if (!RUN_RE.test(String(run))) throw httpError(400, 'Invalid backup id');
    const m = (await this.runs(job.id)).find((x) => x.run === run);
    if (!m) throw httpError(404, 'That backup no longer exists (it may have been removed by the retention setting)');
    return m;
  }

  async download(id, run, file) {
    const job = this.find(id);
    if (!RUN_RE.test(String(run)) || !FILE_RE.test(String(file))) throw httpError(400, 'Invalid backup file');
    const host = this.hostOf(job);
    const p = `${this.jobDir(job)}/${run}/${file}`;
    const st = await host.fs.stat(p).catch(() => null);
    if (!st || st.type !== 'file') throw httpError(404, 'Backup file not found');
    return { size: st.size, name: `${job.name}-${run}-${file}`, stream: host.fs.createReadStream(p) };
  }

  async removeRun(id, run) {
    const job = this.find(id);
    if (!RUN_RE.test(String(run))) throw httpError(400, 'Invalid backup id');
    if (this.running.has(id)) throw httpError(409, 'This backup is running right now');
    const r = await this.hostOf(job).runPriv('rm', ['-rf', '--', `${this.jobDir(job)}/${run}`]);
    if (!r.ok) throw httpError(500, 'Could not delete that backup');
  }

  // ------------------------------------------------------------------ restore

  async restore(id, { run, file, confirm, inPlace = false }) {
    const job = this.find(id);
    if (this.running.has(id)) throw httpError(409, 'This backup is running right now');
    const m = await this.manifest(job, run);
    const it = m.items.find((x) => x.file === file && x.status === 'ok');
    if (!it) throw httpError(400, 'That file is not part of this backup');
    const host = this.hostOf(job);
    const full = `${this.jobDir(job)}/${run}/${file}`;
    if (it.type === 'db') {
      const [engine, name] = it.source.split(':');
      if (confirm !== name) throw httpError(400, `Type the database name (${name}) to confirm: restoring replaces its current contents`);
      const r = await this.databases.restoreFromFile(job.serverId, { engine, name, file: full, gz: true });
      return { ok: true, kind: 'db', database: name, safetyDump: r.safetyDump };
    }
    if (inPlace) {
      if (confirm !== it.source) throw httpError(400, `Type the folder (${it.source}) to confirm: files from the backup overwrite files that exist now`);
      const safe = `${this.jobDir(job)}/before-restore-${run}-${Date.now()}.tar.gz`;
      let r = await host.runPriv('tar', ['-czf', safe, '-C', '/', '--', it.source.replace(/^\//, '')]);
      if (!r.ok && !/Removing leading|file changed/.test(r.stderr || '')) throw httpError(500, `Could not save the current files first, so nothing was restored: ${(r.stderr || '').trim().split('\n').pop()}`);
      r = await host.runPriv('tar', ['-xzf', full, '-C', '/']);
      if (!r.ok) throw httpError(500, `Restore failed: ${(r.stderr || '').trim().split('\n').pop()}. The files from before are saved in ${safe}`);
      return { ok: true, kind: 'path', inPlace: true, path: it.source, savedAs: safe };
    }
    const dest = `${this.config.backupRoot}/_restored/${job.name}-${run}-${slug(it.source)}`;
    let r = await host.runPriv('mkdir', ['-p', dest]);
    if (!r.ok) throw httpError(500, 'Could not create the staging folder');
    r = await host.runPriv('tar', ['-xzf', full, '-C', dest]);
    if (!r.ok) throw httpError(500, `Could not unpack the backup: ${(r.stderr || '').trim().split('\n').pop()}`);
    return { ok: true, kind: 'path', inPlace: false, path: `${dest}${it.source}`, staging: dest };
  }

  // ------------------------------------------------------------------ tools check

  async s3Check(serverId) {
    const host = this.servers.entry(serverId).host;
    const r = await host.run('bash', ['-c', 'command -v aws >/dev/null 2>&1 && aws --version 2>&1 | head -1 || echo none']);
    const v = r.stdout.trim();
    return { installed: v !== 'none', version: v === 'none' ? '' : v };
  }
}

module.exports = { BackupManager, NAME_RE, onCalendar, slug };
