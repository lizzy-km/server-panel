'use strict';
/**
 * Laravel (PHP) apps on a managed server: adopt an existing app as-is, inspect it, run a whitelist of
 * artisan commands, read logs, and edit its .env.
 *
 * Safety rules baked in:
 *  - artisan always runs as the user that OWNS storage/ (normally the PHP-FPM user). Running it as the SSH user
 *    would create root/ec2-user-owned cache and log files that the web server then cannot write (the classic
 *    "permission denied on laravel.log" outage).
 *  - the inspection never executes the app; it only reads files.
 *  - no destructive artisan commands (migrate:fresh / rollback / db:wipe / db:seed) are exposed.
 */
const crypto = require('crypto');
const { httpError } = require('./auth');
const { shq } = require('./host');

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** command id -> artisan arguments (+ timeout). Only these can be run. */
const ARTISAN = {
  down: { args: ['down'], label: 'Maintenance mode on' },
  up: { args: ['up'], label: 'Maintenance mode off' },
  optimize: { args: ['optimize'], label: 'Cache config, routes and views' },
  'optimize:clear': { args: ['optimize:clear'], label: 'Clear all caches' },
  'config:clear': { args: ['config:clear'] }, 'config:cache': { args: ['config:cache'] },
  'route:clear': { args: ['route:clear'] }, 'route:cache': { args: ['route:cache'] },
  'view:clear': { args: ['view:clear'] }, 'view:cache': { args: ['view:cache'] },
  'cache:clear': { args: ['cache:clear'] },
  'queue:restart': { args: ['queue:restart'], label: 'Restart queue workers' },
  'storage:link': { args: ['storage:link'] },
  'migrate:status': { args: ['migrate:status'], label: 'Show migration status' },
  migrate: { args: ['migrate', '--force'], label: 'Run pending migrations', timeout: 300000 },
  'schedule:list': { args: ['schedule:list'] },
  'queue:failed': { args: ['queue:failed'] },
  about: { args: ['about'] },
};

const INSPECT = (p) => `P=${shq(p)}
priv() { if [ "$USE_SUDO" = 1 ] && [ "$(id -u)" != 0 ]; then sudo -n "$@"; else "$@"; fi; }
[ -d "$P" ] || { echo "error=Folder not found on the server: $P"; exit 0; }
echo "me=$(id -un)"
echo "artisan=$([ -f "$P/artisan" ] && echo 1 || echo 0)"
echo "vendor=$([ -d "$P/vendor" ] && echo 1 || echo 0)"
echo "env=$([ -f "$P/.env" ] && echo 1 || echo 0)"
echo "owner=$(stat -c %U "$P/storage" 2>/dev/null)"
echo "group=$(stat -c %G "$P/storage" 2>/dev/null)"
echo "storageMode=$(stat -c %a "$P/storage" 2>/dev/null)"
echo "php=$(command -v php >/dev/null 2>&1 && php -r 'echo PHP_VERSION;' 2>/dev/null)"
echo "composer=$(command -v composer >/dev/null 2>&1 && echo 1 || echo 0)"
echo "node=$(command -v node >/dev/null 2>&1 && node --version 2>/dev/null)"
echo "laravel=$(grep -m1 "const VERSION" "$P/vendor/laravel/framework/src/Illuminate/Foundation/Application.php" 2>/dev/null | sed "s/.*'\\(.*\\)'.*/\\1/")"
echo "maintenance=$([ -f "$P/storage/framework/down" ] && echo 1 || echo 0)"
echo "configCached=$([ -f "$P/bootstrap/cache/config.php" ] && echo 1 || echo 0)"
echo "logFile=$(ls -1t "$P"/storage/logs/*.log 2>/dev/null | head -1 | xargs -r basename)"
echo "git=$([ -d "$P/.git" ] && echo 1 || echo 0)"
if [ -d "$P/.git" ]; then
  G="git -c safe.directory=* -C $P"
  echo "gitRemote=$($G config --get remote.origin.url 2>/dev/null | sed -E 's#(https?://)[^@/]*@#\\1#')"
  echo "gitBranch=$($G rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "gitCommit=$($G rev-parse HEAD 2>/dev/null)"
  echo "gitSubject=$($G log -1 --pretty=%s 2>/dev/null | head -c 200)"
  echo "gitDirty=$($G status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
fi
# non-secret settings only
priv grep -E '^(APP_ENV|APP_DEBUG|APP_URL|DB_CONNECTION|QUEUE_CONNECTION|CACHE_STORE|CACHE_DRIVER|SESSION_DRIVER)=' "$P/.env" 2>/dev/null | sed 's/^/envkey_/' | head -20
echo "fpmUnit=$(systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -E '^php.*fpm' | head -1)"
echo "fpmUser=$(ps -eo user:32,comm 2>/dev/null | awk '$2 ~ /php-fpm/ && $1 != "root" {print $1}' | sort -u | head -1)"
echo "workers=$(systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -iE 'queue|horizon|laravel|worker' | tr '\\n' ',')"
echo "scheduler=$(priv grep -rlE "schedule:run" /etc/cron.d /var/spool/cron /etc/crontab 2>/dev/null | tr '\\n' ',')"
echo "diskLogs=$(du -sk "$P/storage/logs" 2>/dev/null | cut -f1)"
`;

class LaravelManager {
  constructor({ store, servers, config }) { Object.assign(this, { store, servers, config }); this.inspections = new Map(); }

  get apps() { return this.store.data.laravel; }

  find(id) {
    const a = this.apps.find((x) => x.id === id);
    if (!a) throw httpError(404, 'Unknown Laravel app');
    return a;
  }
  hostFor(app) { return this.servers.entry(app.serverId).host; }

  list(serverId) { return this.apps.filter((a) => a.serverId === serverId); }

  // ------------------------------------------------------------------ inspect + adopt

  async inspect(host, path) {
    if (!PATH_RE.test(String(path || '')) || path.includes('..')) throw httpError(400, 'Enter the absolute folder of the app, e.g. /var/www/q-app');
    const r = await host.run('bash', ['-s'], { stdin: `USE_SUDO=${host.useSudo ? 1 : 0}\n${INSPECT(path.replace(/\/+$/, ''))}`, timeout: 40000 });
    const o = { envKeys: {} };
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i < 1) continue;
      const k = line.slice(0, i); const v = line.slice(i + 1).trim();
      if (k.startsWith('envkey_')) o.envKeys[k.slice(7)] = v; else if (k === 'envkey') continue; else o[k] = v;
    }
    // envkey_APP_ENV=production lines were prefixed with "envkey_" and kept their own "KEY=VALUE"
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^envkey_([A-Z_]+)=(.*)$/);
      if (m) o.envKeys[m[1]] = m[2].trim();
    }
    if (o.error) throw httpError(404, o.error);
    return {
      path, isLaravel: o.artisan === '1', hasVendor: o.vendor === '1', hasEnv: o.env === '1', owner: o.owner || null, group: o.group || null, storageMode: o.storageMode || null,
      me: o.me, php: o.php || null, composer: o.composer === '1', node: o.node || null, laravel: o.laravel || null,
      maintenance: o.maintenance === '1', configCached: o.configCached === '1', logFile: o.logFile || null,
      git: o.git === '1' ? { remote: o.gitRemote || null, branch: o.gitBranch || null, commit: o.gitCommit || null, subject: o.gitSubject || null, dirty: Number(o.gitDirty) || 0 } : null,
      env: { appEnv: o.envKeys.APP_ENV || null, debug: o.envKeys.APP_DEBUG || null, url: o.envKeys.APP_URL || null, db: o.envKeys.DB_CONNECTION || null, queue: o.envKeys.QUEUE_CONNECTION || null, cache: o.envKeys.CACHE_STORE || o.envKeys.CACHE_DRIVER || null, session: o.envKeys.SESSION_DRIVER || null },
      fpmUnit: o.fpmUnit || null, fpmUser: o.fpmUser || null,
      workers: (o.workers || '').split(',').filter(Boolean), scheduler: (o.scheduler || '').split(',').filter(Boolean), logsKb: Number(o.diskLogs) || 0,
    };
  }

  async adopt(serverId, { name, path }, user) {
    const e = this.servers.entry(serverId);
    if (!NAME_RE.test(String(name || ''))) throw httpError(400, 'Name: 2-32 characters, lowercase letters, digits and dashes, starting with a letter');
    if (this.apps.some((a) => a.serverId === serverId && (a.name === name || a.path === path))) throw httpError(409, 'That app (name or folder) is already added on this server');
    const info = await this.inspect(e.host, path);
    if (!info.isLaravel) throw httpError(400, `${path} does not look like a Laravel app (no "artisan" file). Check the folder.`);
    const app = {
      id: crypto.randomUUID(), serverId, type: 'laravel', name, path: path.replace(/\/+$/, ''), adopted: true,
      // artisan runs as the owner of storage/ (the PHP-FPM user in a working install)
      runUser: info.owner && USER_RE.test(info.owner) ? info.owner : (info.fpmUser && USER_RE.test(info.fpmUser) ? info.fpmUser : null),
      fpmUnit: info.fpmUnit && /^[A-Za-z0-9@._-]+\.service$/.test(info.fpmUnit) ? info.fpmUnit : 'php-fpm.service',
      created: new Date().toISOString(), createdBy: user,
    };
    this.apps.push(app);
    this.store.save();
    return { app, info };
  }

  async detail(app, { fresh = false } = {}) {
    const hit = this.inspections.get(app.id);
    if (!fresh && hit && Date.now() - hit.at < 15000) return hit.info;
    const info = await this.inspect(this.hostFor(app), app.path);
    this.inspections.set(app.id, { at: Date.now(), info });
    return info;
  }

  remove(id) {
    this.find(id);
    this.store.data.laravel = this.apps.filter((a) => a.id !== id);
    this.inspections.delete(id);
    this.store.save();
  }

  // ------------------------------------------------------------------ artisan

  /** Run a whitelisted artisan command as the app's owner user. */
  async artisan(app, command) {
    const spec = ARTISAN[command];
    if (!spec) throw httpError(400, `Command not allowed: ${command}`);
    const host = this.hostFor(app);
    const me = host.username || require('os').userInfo().username;
    const as = app.runUser && app.runUser !== me;
    if (as && !host.useSudo && me !== 'root') throw httpError(400, `This app's files belong to "${app.runUser}"; the SSH user needs passwordless sudo to run artisan as that user.`);
    const inner = `cd ${shq(app.path)} && php artisan ${spec.args.map(shq).join(' ')} --no-interaction 2>&1`;
    const full = as ? `sudo -n -u ${shq(app.runUser)} sh -c ${shq(inner)}` : inner;
    const started = Date.now();
    const r = await host.run('sh', ['-c', full], { timeout: spec.timeout || 120000, maxBuffer: 4 * 1024 * 1024 });
    const output = (r.stdout + r.stderr).trim().slice(-20000);
    this.inspections.delete(app.id);
    return { ok: r.ok, code: r.code, output, ms: Date.now() - started, label: spec.label || command };
  }

  async fpm(app, action) {
    if (!['reload', 'restart'].includes(action)) throw httpError(400, 'Invalid action');
    const host = this.hostFor(app);
    const r = await host.runPriv('systemctl', [action, app.fpmUnit || 'php-fpm.service'], { timeout: 60000 });
    if (!r.ok) throw httpError(500, (r.stderr || r.stdout || 'systemctl failed').trim());
    return { ok: true, unit: app.fpmUnit };
  }

  // ------------------------------------------------------------------ logs

  async logFiles(app) {
    const host = this.hostFor(app);
    const r = await host.runPriv('find', [`${app.path}/storage/logs`, '-maxdepth', '1', '-type', 'f', '-name', '*.log', '-printf', '%f\t%s\t%T@\n']);
    return r.stdout.split('\n').map((l) => l.split('\t')).filter((p) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/.test(p[0] || '')).map(([name, size, m]) => ({ name, size: Number(size), mtime: Math.round(parseFloat(m) * 1000) })).sort((a, b) => b.mtime - a.mtime);
  }

  async logs(app, file, lines = 300, q = '') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/.test(String(file || ''))) throw httpError(400, 'Invalid log file name');
    const host = this.hostFor(app);
    const n = Math.max(1, Math.min(5000, Number(lines) || 300));
    const r = await host.runPriv('tail', ['-c', String(2 * 1024 * 1024), `${app.path}/storage/logs/${file}`], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    if (!r.ok) throw httpError(404, (r.stderr || 'Log file not found').trim());
    let text = r.stdout;
    if (q) { const needle = String(q).toLowerCase(); text = text.split('\n').filter((l) => l.toLowerCase().includes(needle)).join('\n'); }
    return { output: text.replace(/\n+$/, '').split('\n').slice(-n).join('\n') };
  }

  // ------------------------------------------------------------------ .env (raw text, comments and order preserved)

  envPath(app) { return `${app.path}/.env`; }

  async readEnv(app) {
    const r = await this.hostFor(app).runPriv('cat', [this.envPath(app)]);
    if (!r.ok) throw httpError(404, `No .env found at ${this.envPath(app)}`);
    return { content: r.stdout };
  }

  /**
   * Overwrite .env in place (ownership and mode are kept because the file is truncated, not replaced),
   * keeping a .env.panel-bak copy. With apply: clear/rebuild the config cache and restart queue workers.
   */
  async writeEnv(app, content, { apply = false, force = false } = {}) {
    if (typeof content !== 'string' || content.length > 200000 || content.includes('\0')) throw httpError(400, 'Invalid or too large .env content (max 200 KB)');
    const host = this.hostFor(app);
    const prev = await this.readEnv(app).catch(() => null);
    const had = (t) => /^APP_KEY=.+$/m.test(t || '');
    if (prev && had(prev.content) && !had(content) && !force) {
      throw httpError(400, 'APP_KEY is missing from the new content. Removing it breaks encrypted data and logs everyone out. If you really mean it, confirm the override.');
    }
    const body = content.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
    if (prev) await host.runPriv('cp', ['-p', this.envPath(app), `${this.envPath(app)}.panel-bak`]);
    const w = await host.runPriv('tee', [this.envPath(app)], { stdin: body });
    if (!w.ok) throw httpError(500, `Could not write ${this.envPath(app)}: ${(w.stderr || '').trim()}`);
    const out = { ok: true, backup: prev ? `${this.envPath(app)}.panel-bak` : null, applied: [] };
    if (apply) {
      const info = await this.detail(app, { fresh: true }).catch(() => null);
      out.applied.push(['config:clear', await this.artisan(app, 'config:clear')]);
      if (info && info.configCached) out.applied.push(['config:cache', await this.artisan(app, 'config:cache')]);
      out.applied.push(['queue:restart', await this.artisan(app, 'queue:restart')]);
      out.applied = out.applied.map(([c, r]) => ({ command: c, ok: r.ok, output: r.output.slice(0, 500) }));
      out.healthy = out.applied.every((a) => a.ok);
    }
    return out;
  }
}

module.exports = { LaravelManager, ARTISAN };
