'use strict';
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { httpError, safeEq } = require('./auth');
const { shq } = require('./host');
const { Runner } = require('./runner');
const S = require('./scripts');
const P = require('./presets');

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_ENV = new Set(['PORT', 'NODE_ENV', 'PATH', 'HOME', 'USER', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);
const RELEASE_RE = /^[0-9]{14}-[0-9a-f]{4}$/;

function checkRepo(url, allowLocal) {
  const u = String(url || '').trim();
  if (!u || u.length > 300 || /[\s\0-\x1f'"`\\$;|&<>]/.test(u) || u.startsWith('-') || /^ext::/i.test(u)) throw httpError(400, 'Invalid repository URL');
  const https = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~/%+-]+$/;
  const ssh = /^(ssh:\/\/)?[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(:\d+)?[:/][A-Za-z0-9._~/%+-]+$/;
  const file = /^file:\/\/\/[A-Za-z0-9._~/%+-]+$/;
  if (!(https.test(u) || ssh.test(u) || (allowLocal && file.test(u)))) throw httpError(400, 'Repository URL must be https://host/path or git@host:path (ssh)');
  return u;
}

const cmd = (v, label) => {
  const s = String(v ?? '');
  if (s.length > 2000 || s.includes('\0')) throw httpError(400, `${label} is too long or invalid`);
  return s.trim();
};

class DeployManager {
  constructor({ store, vault, servers, config }) {
    Object.assign(this, { store, vault, servers, config });
    this.runner = new Runner(path.join(config.dataDir, 'jobs'));
    this.running = new Map(); // appId -> deployId
    this.hookHits = new Map();
    const d = store.data;
    for (const rec of d.deploys) if (rec.status === 'running') { rec.status = 'interrupted'; rec.finishedAt = new Date().toISOString(); }
    store.save();
    this.pruneJobLogs();
  }

  /** Provisioning-job logs are not tied to a deploy record: drop those older than 14 days. */
  pruneJobLogs() {
    const fs = require('fs');
    const known = new Set(this.store.data.deploys.map((d) => d.id));
    try {
      for (const f of fs.readdirSync(this.runner.dir)) {
        const id = f.replace(/\.log$/, '');
        const p = path.join(this.runner.dir, f);
        if (!known.has(id) && Date.now() - fs.statSync(p).mtimeMs > 14 * 86400000) fs.rmSync(p, { force: true });
      }
    } catch { /* ignore */ }
  }

  get apps() { return this.store.data.apps; }

  // ------------------------------------------------------------------ app CRUD

  find(id) {
    const a = this.apps.find((x) => x.id === id);
    if (!a) throw httpError(404, 'Unknown app');
    return a;
  }

  appDir(app) { return `${app.baseDir}/${app.name}`; }

  clean(input, { partial = false, serverId, selfId } = {}) {
    const out = {};
    const has = (k) => input[k] !== undefined;
    if (!partial || has('name')) {
      const name = String(input.name || '').trim();
      if (!NAME_RE.test(name)) throw httpError(400, 'App name: 2-32 characters, lowercase letters, digits and dashes, starting with a letter');
      out.name = name;
    }
    if (!partial || has('repoUrl')) out.repoUrl = checkRepo(input.repoUrl, this.config.allowLocalRepos);
    if (!partial || has('branch')) {
      const b = String(input.branch || 'main').trim();
      if (!REF_RE.test(b) || b.includes('..')) throw httpError(400, 'Invalid branch or tag name');
      out.branch = b;
    }
    if (!partial || has('authType')) {
      const t = input.authType || 'none';
      if (!['none', 'token', 'key'].includes(t)) throw httpError(400, 'authType must be none, token or key');
      out.authType = t;
    }
    if (has('tokenUser')) {
      if (!/^[A-Za-z0-9._@-]{1,64}$/.test(String(input.tokenUser))) throw httpError(400, 'Invalid token username');
      out.tokenUser = String(input.tokenUser);
    }
    if (!partial || has('framework')) {
      const f = String(input.framework || 'node');
      if (!P.BY_ID[f]) throw httpError(400, `Unknown framework "${f}"`);
      out.framework = f;
    }
    for (const [k, label] of [['installCmd', 'Install command'], ['buildCmd', 'Build command'], ['startCmd', 'Start command'], ['releaseCmd', 'Release command'], ['afterCmd', 'After-deploy command']]) {
      if (has(k)) out[k] = cmd(input[k], label);
    }
    if (has('outputDir')) {
      const o = String(input.outputDir || '').trim();
      if (o && o !== 'auto' && (!/^[A-Za-z0-9._/@-]{1,120}$/.test(o) || o.includes('..') || o.startsWith('/'))) throw httpError(400, 'Output folder must be a relative path such as dist or build/web');
      out.outputDir = o;
    }
    if (has('sharedPaths')) {
      const list = (Array.isArray(input.sharedPaths) ? input.sharedPaths : String(input.sharedPaths || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
      for (const x of list) if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,100}$/.test(x) || x.split('/').includes('..') || x.startsWith('/') || x === '.') throw httpError(400, `Invalid shared folder: ${x}`);
      out.sharedPaths = list.slice(0, 20);
    }
    if (has('healthHost')) {
      const hh = String(input.healthHost || '').trim();
      if (hh && !/^[A-Za-z0-9.-]{1,253}$/.test(hh)) throw httpError(400, 'Invalid health check host name');
      out.healthHost = hh;
    }
    if (has('spa')) out.spa = !!input.spa;
    // the framework decides whether this app is a service on a port (service) or served by nginx (static, php)
    const framework = out.framework || (partial && selfId ? (this.apps.find((a) => a.id === selfId) || {}).framework : 'node') || 'node';
    const mode = (P.BY_ID[framework] || P.BY_ID.node).mode;
    if (mode === 'service' && (!partial || has('port'))) {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(400, 'Port must be between 1024 and 65535');
      if (this.apps.some((a) => a.serverId === serverId && a.id !== selfId && a.port === port)) throw httpError(409, `Port ${port} is already used by another app on this server`);
      out.port = port;
    }
    if (has('healthPath')) {
      const p = String(input.healthPath || '/');
      if (!/^\/[^\s'"`\\$;|&<>]{0,199}$/.test(p)) throw httpError(400, 'Health check path must start with / and contain no spaces or shell characters');
      out.healthPath = p;
    }
    if (has('healthTimeout')) {
      const t = Number(input.healthTimeout);
      if (!Number.isInteger(t) || t < 5 || t > 300) throw httpError(400, 'Health check timeout must be 5-300 seconds');
      out.healthTimeout = t;
    }
    if (has('healthStrict')) out.healthStrict = !!input.healthStrict;
    if (has('keepReleases')) {
      const k = Number(input.keepReleases);
      if (!Number.isInteger(k) || k < 2 || k > 30) throw httpError(400, 'Keep between 2 and 30 releases');
      out.keepReleases = k;
    }
    if (!partial || has('baseDir')) {
      const b = String(input.baseDir || this.config.appsBaseDir).replace(/\/+$/, '');
      if (!/^\/[A-Za-z0-9._/-]{1,100}$/.test(b) || b.includes('..')) throw httpError(400, 'Apps directory must be an absolute path like /srv/apps');
      out.baseDir = b;
    }
    if (has('runAs')) {
      const r = String(input.runAs || '').trim();
      if (r && !/^[a-z_][a-z0-9_-]{0,31}$/.test(r)) throw httpError(400, 'Invalid service user');
      out.runAs = r;
    }
    if (has('extraPath')) {
      const e = String(input.extraPath || '').trim();
      if (!/^[A-Za-z0-9._/:-]{0,300}$/.test(e)) throw httpError(400, 'Invalid extra PATH');
      out.extraPath = e;
    }
    if (has('webhookEnabled')) out.webhookEnabled = !!input.webhookEnabled;
    return out;
  }

  publicApp(app, { admin = false } = {}) {
    const env = this.envOf(app);
    const last = this.store.data.deploys.find((d) => d.appId === app.id);
    const o = {
      id: app.id, serverId: app.serverId, name: app.name, unit: app.unit, repoUrl: app.repoUrl, branch: app.branch,
      framework: app.framework || 'node', mode: P.resolve(app).mode, outputDir: app.outputDir || '', sharedPaths: app.sharedPaths || null, releaseCmd: app.releaseCmd ?? null, afterCmd: app.afterCmd ?? null, healthHost: app.healthHost || '', spa: P.resolve(app).spa,
      effective: (() => { const c = P.resolve(app); return { install: c.install, build: c.build, start: c.start, outputDir: c.outputDir, sharedPaths: c.sharedPaths, releaseCmd: c.releaseCmd, afterCmd: c.afterCmd }; })(),
      authType: app.authType, tokenUser: app.tokenUser || 'x-access-token', hasGitSecret: !!app.secretEnc,
      installCmd: app.installCmd || '', buildCmd: app.buildCmd || '', startCmd: app.startCmd || '', port: app.port,
      healthPath: app.healthPath || '/', healthTimeout: app.healthTimeout || 30, healthStrict: !!app.healthStrict,
      keepReleases: app.keepReleases || 5, baseDir: app.baseDir, runAs: app.runAs || '', extraPath: app.extraPath || '',
      envNames: Object.keys(env), webhookEnabled: !!app.webhookEnabled, created: app.created,
      deploying: this.running.has(app.id), lastDeploy: last || null,
    };
    if (admin && app.webhookEnc) o.webhookToken = this.vault.decrypt(app.webhookEnc);
    return o;
  }

  list(serverId, opts) { return this.apps.filter((a) => a.serverId === serverId).map((a) => this.publicApp(a, opts)); }

  create(serverId, input, user) {
    const v = this.clean(input, { serverId });
    if (this.apps.some((a) => a.serverId === serverId && a.name === v.name)) throw httpError(409, 'An app with that name already exists on this server');
    const app = {
      id: crypto.randomUUID(), serverId, ...v, framework: v.framework || 'node',
      unit: P.BY_ID[v.framework || 'node'].mode === 'service' ? `panel-app-${v.name}.service` : '',
      healthTimeout: v.healthTimeout || 30, keepReleases: v.keepReleases || 5,
      envEnc: null, secretEnc: null, webhookEnabled: false, webhookEnc: null,
      created: new Date().toISOString(), createdBy: user,
    };
    if (v.authType !== 'none') {
      if (!input.gitSecret) throw httpError(400, v.authType === 'token' ? 'An access token is required' : 'A deploy key (private key) is required');
      app.secretEnc = this.vault.encrypt(String(input.gitSecret));
    }
    this.apps.push(app);
    this.store.save();
    return app;
  }

  update(id, input) {
    const app = this.find(id);
    if (this.running.has(id)) throw httpError(409, 'A deploy is running for this app');
    const v = this.clean(input, { partial: true, serverId: app.serverId, selfId: id });
    if (v.framework && P.BY_ID[v.framework].mode !== P.resolve(app).mode) throw httpError(400, 'The framework type cannot change between service, static and PHP apps after creation. Create a new app instead.');
    if (v.name && v.name !== app.name) throw httpError(400, 'An app cannot be renamed (its service and folders are named after it); create a new app instead');
    if (v.baseDir && v.baseDir !== app.baseDir) throw httpError(400, 'The apps directory cannot be changed after creation');
    Object.assign(app, v);
    if (input.gitSecret) app.secretEnc = this.vault.encrypt(String(input.gitSecret));
    if (app.authType === 'none') app.secretEnc = null;
    if (app.authType !== 'none' && !app.secretEnc) throw httpError(400, 'Provide the access token / deploy key for this authentication type');
    this.store.save();
    return app;
  }

  envOf(app) { return app.envEnc ? JSON.parse(this.vault.decrypt(app.envEnc)) : {}; }

  /** vars: {NAME: value|null}; null removes. Names not mentioned are kept. */
  setEnv(id, vars) {
    const app = this.find(id);
    const env = this.envOf(app);
    if (typeof vars !== 'object' || !vars || Array.isArray(vars)) throw httpError(400, 'vars must be an object');
    for (const [k, v] of Object.entries(vars)) {
      if (!ENV_NAME_RE.test(k)) throw httpError(400, `Invalid variable name: ${k}`);
      if (RESERVED_ENV.has(k.toUpperCase())) throw httpError(400, `${k} is managed by the panel and cannot be set`);
      if (v === null) delete env[k];
      else {
        if (typeof v !== 'string' || v.length > 8000 || v.includes('\0')) throw httpError(400, `Invalid value for ${k}`);
        env[k] = v;
      }
    }
    if (Object.keys(env).length > 200) throw httpError(400, 'Too many variables (max 200)');
    app.envEnc = Object.keys(env).length ? this.vault.encrypt(JSON.stringify(env)) : null;
    this.store.save();
    return Object.keys(env);
  }

  /** Admin editor: the submitted set becomes the whole environment (names not submitted are removed). */
  replaceEnv(id, vars) {
    const app = this.find(id);
    if (typeof vars !== 'object' || !vars || Array.isArray(vars)) throw httpError(400, 'vars must be an object');
    const next = {};
    for (const [k, v] of Object.entries(vars)) {
      if (!ENV_NAME_RE.test(k)) throw httpError(400, `Invalid variable name: ${k}`);
      if (RESERVED_ENV.has(k.toUpperCase())) throw httpError(400, `${k} is managed by the panel (PORT, NODE_ENV, PATH...) and cannot be set here`);
      if (typeof v !== 'string' || v.length > 8000 || v.includes('\0')) throw httpError(400, `Invalid value for ${k}`);
      next[k] = v;
    }
    if (Object.keys(next).length > 200) throw httpError(400, 'Too many variables (max 200)');
    app.envEnc = Object.keys(next).length ? this.vault.encrypt(JSON.stringify(next)) : null;
    this.store.save();
    return Object.keys(next);
  }

  /** Push the stored environment to the server and restart the service (no rebuild). */
  async applyEnv(id) {
    const app = this.find(id);
    if (this.running.has(id)) throw httpError(409, 'A deploy is running for this app; its environment is applied by that deploy');
    const host = this.hostFor(app);
    await host.connect();
    const env = this.envOf(app);
    const { cfg, ctx } = this.ctxFor(app, host, { envFile: S.envFileText(env), envShell: S.envShellText(env) });
    const script = S.envApplyScript(app, cfg, ctx);
    const r = await host.run('bash', ['-s'], { stdin: script, timeout: 180000 });
    const output = (r.stdout + r.stderr).split('\n').filter((l) => !l.startsWith('@@')).join('\n').trim();
    if (!/@@STATE ok/.test(r.stdout)) throw Object.assign(httpError(400, output.split('\n').slice(-4).join('\n') || 'Applying the environment failed'), { output });
    return { ok: true, output };
  }

  rotateWebhook(id, enable = true) {
    const app = this.find(id);
    app.webhookEnabled = enable;
    if (enable) app.webhookEnc = this.vault.encrypt(crypto.randomBytes(24).toString('base64url'));
    this.store.save();
    return app;
  }

  async remove(id, { deleteFiles = false } = {}) {
    const app = this.find(id);
    if (this.running.has(id)) throw httpError(409, 'A deploy is running for this app');
    try {
      const e = this.servers.entry(app.serverId);
      await e.host.run('bash', ['-c', S.removeAppScript(app, { useSudo: e.host.useSudo, unitDir: this.config.unitDir, appDir: this.appDir(app), deleteFiles })], { timeout: 60000, stdin: '' });
    } catch { /* server unreachable: still forget the app */ }
    const d = this.store.data;
    for (const rec of d.deploys.filter((x) => x.appId === id)) this.runner.remove(rec.id);
    d.deploys = d.deploys.filter((x) => x.appId !== id);
    d.apps = d.apps.filter((x) => x.id !== id);
    for (const s of d.sites) if (s.upstream && s.upstream.appId === id) s.upstream = { type: 'url', url: `http://127.0.0.1:${app.port}` };
    this.store.save();
  }

  forgetServer(serverId) {
    const d = this.store.data;
    for (const rec of d.deploys.filter((x) => x.serverId === serverId)) this.runner.remove(rec.id);
    d.deploys = d.deploys.filter((x) => x.serverId !== serverId);
    d.apps = d.apps.filter((x) => x.serverId !== serverId);
    d.sites = d.sites.filter((x) => x.serverId !== serverId);
    d.laravel = (d.laravel || []).filter((x) => x.serverId !== serverId);
    this.store.save();
  }

  // ------------------------------------------------------------------ deploy / rollback

  hostFor(app) { return this.servers.entry(app.serverId).host; }

  /** Everything the scripts need besides the app itself. */
  ctxFor(app, host, extra = {}) {
    const cfg = P.resolve(app);
    return {
      cfg,
      ctx: {
        appDir: this.appDir(app), useSudo: host.useSudo, unitDir: this.config.unitDir, allowLocalRepos: this.config.allowLocalRepos,
        appUser: app.runAs || (cfg.mode === 'php' ? 'nginx' : ''), fpmUnit: app.fpmUnit || 'php-fpm.service', ...extra,
      },
    };
  }
  serviceUser(app, host) { return app.runAs || host.username || os.userInfo().username; }

  record(rec) {
    const d = this.store.data.deploys;
    d.unshift(rec);
    while (d.length > 300) { const old = d.pop(); this.runner.remove(old.id); }
    this.store.save();
    return rec;
  }

  async finish(rec, r) {
    const st = r.markers.STATE;
    let status = st === 'ok' ? 'success' : st === 'rolled_back' ? 'rolled_back' : 'failed';
    if (r.code !== 0 && status === 'success') status = 'failed';
    if (r.markers.COMMIT && r.markers.COMMIT !== 'unknown') rec.commit = r.markers.COMMIT;
    if (r.markers.MSG) rec.message = r.markers.MSG;
    if (r.markers.HINT) rec.hint = String(r.markers.HINT).slice(0, 40);
    if (status === 'success') {
      // The new port is live now: repoint nginx sites BEFORE reporting success, so "success" means everything is consistent.
      const app = this.apps.find((a) => a.id === rec.appId);
      if (app) {
        const moved = P.resolve(app).mode === 'service' && app.livePort !== undefined && app.livePort !== app.port;
        app.livePort = app.port;
        if (moved && this.onPortChanged) {
          try { await this.onPortChanged(app); this.runner.append(rec.id, `\n==> Domains repointed to port ${app.port}\n`); } catch (e) { this.runner.append(rec.id, `\n!! Could not repoint domains to port ${app.port}: ${e.message}\n`); }
        }
      }
    }
    rec.status = status;
    rec.finishedAt = new Date().toISOString();
    this.running.delete(rec.appId);
    this.store.save();
  }

  async deploy(appId, { trigger = 'manual', user = null, ref } = {}) {
    const app = this.find(appId);
    if (this.running.has(appId)) throw httpError(409, 'A deploy is already running for this app');
    const refName = ref || app.branch;
    if (!REF_RE.test(refName) || refName.includes('..')) throw httpError(400, 'Invalid branch or tag name');
    const host = this.hostFor(app);
    await host.connect(); // fail fast (502) before creating any record
    const env = this.envOf(app);
    const id = crypto.randomUUID();
    const relId = new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
    const appDir = this.appDir(app);
    const { cfg, ctx } = this.ctxFor(app, host, {
      relId, ref: refName, secrets: { gitSecret: app.secretEnc ? this.vault.decrypt(app.secretEnc) : '' },
      envFile: S.envFileText(env), envShell: S.envShellText(env), repoLabel: app.repoUrl.replace(/\/\/[^@/]*@/, '//'),
    });
    if (cfg.mode === 'service') { ctx.startSh = S.startScript(app, cfg, appDir); ctx.unit = S.unitText(app, appDir, this.serviceUser(app, host)); }
    const script = S.deployScript(app, cfg, ctx);
    const rec = this.record({ id, kind: 'deploy', appId, appName: app.name, serverId: app.serverId, status: 'running', trigger, user, ref: refName, release: relId, commit: null, message: null, startedAt: new Date().toISOString(), finishedAt: null });
    this.running.set(appId, id);
    this.runner.run({ id, host, script, timeout: 30 * 60 * 1000 }).then((r) => this.finish(rec, r), (e) => { console.error('[deploy] runner error', e); return this.finish(rec, { code: 1, markers: {} }); });
    return rec;
  }

  async rollback(appId, release, { user = null } = {}) {
    const app = this.find(appId);
    if (!RELEASE_RE.test(String(release))) throw httpError(400, 'Invalid release id');
    if (this.running.has(appId)) throw httpError(409, 'A deploy is already running for this app');
    const host = this.hostFor(app);
    await host.connect();
    const id = crypto.randomUUID();
    const { cfg, ctx } = this.ctxFor(app, host, { release });
    const script = S.rollbackScript(app, cfg, ctx);
    const rec = this.record({ id, kind: 'rollback', appId, appName: app.name, serverId: app.serverId, status: 'running', trigger: 'manual', user, ref: null, release, commit: null, message: `Rollback to ${release}`, startedAt: new Date().toISOString(), finishedAt: null });
    this.running.set(appId, id);
    this.runner.run({ id, host, script, timeout: 10 * 60 * 1000 }).then((r) => this.finish(rec, r), () => this.finish(rec, { code: 1, markers: {} }));
    return rec;
  }

  deploys(appId, limit = 50) { return this.store.data.deploys.filter((d) => d.appId === appId).slice(0, limit); }
  findDeploy(id) {
    const rec = this.store.data.deploys.find((d) => d.id === id);
    if (!rec) throw httpError(404, 'Unknown deploy');
    return rec;
  }
  log(id, offset) { this.findDeploy(id); return this.runner.read(id, offset); }

  // ------------------------------------------------------------------ live state on the server

  async releases(app) {
    const host = this.hostFor(app);
    const dir = this.appDir(app);
    const r = await host.run('sh', ['-c', `cd ${shq(dir + '/releases')} 2>/dev/null || exit 0
cur=$(readlink ${shq(dir + '/current')} 2>/dev/null)
for d in $(ls -1t); do
  [ -d "$d" ] || continue
  printf '%s|%s|%s|%s\\n' "$d" "$(cat "$d/.release-commit" 2>/dev/null)" "$(stat -c %Y "$d")" "$([ "$cur" = ${shq(dir)}/releases/"$d" ] && echo 1 || echo 0)"
done`], { timeout: 15000 });
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const [id, commit, mtime, cur] = l.split('|');
      return { id, commit, time: Number(mtime) * 1000, current: cur === '1' };
    }).filter((x) => RELEASE_RE.test(x.id));
  }

  async status(app) {
    const host = this.hostFor(app);
    const cfg = P.resolve(app);
    const dir = this.appDir(app);
    const u = shq(app.unit || 'none');
    const r = await host.run('sh', ['-c', `${cfg.mode === 'service' ? `echo "active=$(systemctl is-active ${u} 2>/dev/null)"
echo "enabled=$(systemctl is-enabled ${u} 2>/dev/null)"
echo "since=$(systemctl show -p ActiveEnterTimestamp --value ${u} 2>/dev/null)"
echo "pid=$(systemctl show -p MainPID --value ${u} 2>/dev/null)"
echo "memory=$(systemctl show -p MemoryCurrent --value ${u} 2>/dev/null)"
echo "restarts=$(systemctl show -p NRestarts --value ${u} 2>/dev/null)"` : ''}
echo "current=$(readlink ${shq(dir + '/current')} 2>/dev/null)"
echo "live=$(readlink ${shq(dir + '/live')} 2>/dev/null)"
echo "indexOk=$([ -f ${shq(dir + '/live/index.html')} ] || [ -f ${shq(dir + '/live/index.php')} ] && echo 1 || echo 0)"`], { timeout: 15000 });
    const o = {};
    for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1).trim(); }
    const deployed = !!o.current;
    return {
      mode: cfg.mode,
      active: cfg.mode === 'service' ? (o.active || 'unknown') : (deployed ? (o.indexOk === '1' ? 'serving' : 'broken') : 'not deployed'),
      enabled: o.enabled || '', since: o.since || '', pid: Number(o.pid) || null,
      memory: /^\d+$/.test(o.memory || '') ? Number(o.memory) : null, restarts: Number(o.restarts) || 0,
      currentRelease: o.current ? path.posix.basename(o.current) : null, serving: o.live || null,
    };
  }

  async service(app, action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw httpError(400, 'Invalid action');
    if (P.resolve(app).mode !== 'service') throw httpError(400, 'This app has no process of its own: it is served directly by nginx / PHP-FPM.');
    const host = this.hostFor(app);
    const r = await host.runPriv('systemctl', [action, app.unit], { timeout: 60000 });
    if (!r.ok) throw httpError(500, (r.stderr || r.stdout || 'systemctl failed').trim());
    return { ok: true };
  }

  async serviceLogs(app, lines = 200) {
    if (P.resolve(app).mode !== 'service') throw httpError(400, 'Static and PHP apps have no service log; see the domain\'s access and error logs instead.');
    const host = this.hostFor(app);
    const n = Math.max(1, Math.min(2000, Number(lines) || 200));
    const r = await host.runPriv('journalctl', ['-u', app.unit, '-n', String(n), '--no-pager', '-o', 'short-iso'], { timeout: 20000 });
    return { output: r.stdout || r.stderr };
  }

  // ------------------------------------------------------------------ webhook

  /** GitHub-compatible: HMAC-SHA256 signature (secret = webhook token) or the token in the URL. */
  async webhook(appId, urlToken, headers, raw, ip) {
    const app = this.apps.find((a) => a.id === appId);
    if (!app || !app.webhookEnabled || !app.webhookEnc) throw httpError(404, 'Not found'); // unknown ids are never recorded below
    const key = `${ip}|${appId}`;
    const now = Date.now();
    const hits = (this.hookHits.get(key) || []).filter((t) => now - t < 60000);
    if (hits.length >= 30) throw httpError(429, 'Too many webhook calls');
    hits.push(now); this.hookHits.set(key, hits);
    if (this.hookHits.size > 5000) for (const [k, v] of this.hookHits) if (!v.some((t) => now - t < 60000)) this.hookHits.delete(k);
    const secret = this.vault.decrypt(app.webhookEnc);
    const sig = headers['x-hub-signature-256'];
    let ok = false;
    if (sig) ok = safeEq(sig, 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'));
    else ok = safeEq(urlToken || '', secret);
    if (!ok) throw httpError(403, 'Invalid webhook token or signature');

    const event = headers['x-github-event'];
    if (event === 'ping') return { status: 200, body: { ok: true, message: 'pong' } };
    let ref = app.branch;
    if (event) {
      if (event !== 'push') return { status: 202, body: { ok: true, ignored: `event ${event}` } };
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch { throw httpError(400, 'Invalid JSON payload'); }
      if (payload.deleted) return { status: 202, body: { ok: true, ignored: 'branch deleted' } };
      if (payload.ref !== `refs/heads/${app.branch}` && payload.ref !== `refs/tags/${app.branch}`) return { status: 202, body: { ok: true, ignored: `push to ${payload.ref}` } };
      ref = app.branch;
    }
    try {
      const rec = await this.deploy(app.id, { trigger: 'webhook', user: 'webhook', ref });
      return { status: 202, body: { ok: true, deployId: rec.id } };
    } catch (e) {
      if (e.status === 409) return { status: 202, body: { ok: true, ignored: 'a deploy is already running' } };
      throw e;
    }
  }

  // ------------------------------------------------------------------ server provisioning

  async toolsStatus(host) {
    const r = await host.run('sh', ['-c', S.TOOLS_CHECK], { timeout: 25000 });
    const o = {};
    for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1).trim(); }
    const tool = (n) => ({ installed: !!o[n] && o[n] !== 'missing', version: o[n] && o[n] !== 'missing' ? o[n] : '' });
    return {
      tools: { git: tool('git'), node: tool('node'), npm: tool('npm'), nginx: tool('nginx'), certbot: tool('certbot'), curl: tool('curl'), openssl: tool('openssl'),
        java: tool('java'), maven: tool('mvn'), dotnet: tool('dotnet'), php: tool('php'), composer: tool('composer'), go: tool('go'), python: tool('python3') },
      nginxActive: o.nginx_active === 'active', certbotTimer: o.certbot_timer === 'active', fpmUnit: o.fpm_unit || '', fpmUser: o.fpm_user || '',
      user: o.user || '', sudo: o.sudo || 'no',
    };
  }

  static get INSTALLABLE() { return ['git', 'node', 'java', 'maven', 'dotnet', 'go', 'python', 'php', 'php82', 'php84', 'composer', 'nginx', 'certbot', 'mariadb', 'postgresql', 'awscli']; }

  async install(serverId, tools, user, { replacePhp = false } = {}) {
    const allowed = DeployManager.INSTALLABLE;
    if (!Array.isArray(tools) || !tools.length || !tools.every((t) => allowed.includes(t))) throw httpError(400, `tools must be a non-empty subset of ${allowed.join(', ')}`);
    const e = this.servers.entry(serverId);
    await e.host.connect();
    const id = crypto.randomUUID();
    // composer needs PHP, and PHP-FPM needs nginx's user: keep a sensible order
    const order = allowed.filter((t) => tools.includes(t));
    const script = S.installScript(order, { useSudo: e.host.useSudo, acmeRoot: this.config.acmeRoot, unitDir: this.config.unitDir, replacePhp: !!replacePhp });
    this.runner.run({ id, host: e.host, script, timeout: 30 * 60 * 1000 }).catch(() => {});
    return { id, user };
  }

  /** Clone the repository on the server (shallow, temp folder) and say which framework preset fits. */
  async detect(serverId, input) {
    const e = this.servers.entry(serverId);
    const host = e.host;
    await host.connect();
    const v = this.clean({ ...input, name: 'detect', framework: 'static-html' }, { serverId }); // a portless type: only the repository details are validated here
    const secrets = { gitSecret: v.authType !== 'none' && input.gitSecret ? String(input.gitSecret) : '' };
    if (v.authType !== 'none' && !secrets.gitSecret) throw httpError(400, 'Provide the token / deploy key to look inside a private repository');
    const script = S.detectRepoScript({ repoUrl: v.repoUrl, authType: v.authType, tokenUser: v.tokenUser }, { ref: v.branch, secrets, allowLocalRepos: this.config.allowLocalRepos });
    const r = await host.run('bash', ['-s'], { stdin: script, timeout: 120000 });
    const err = (r.stdout.match(/@@ERROR (.*)/) || [])[1];
    if (err) throw httpError(400, `Could not read the repository: ${err}`);
    const id = (r.stdout.match(/@@PRESET (\S+)/) || [])[1];
    if (!id || !P.BY_ID[id]) throw httpError(500, 'Detection failed: ' + (r.stderr || r.stdout).slice(-200));
    const out = { preset: id, label: P.BY_ID[id].label, mode: P.BY_ID[id].mode };
    const have = (r.stdout.match(/@@PHPHAVE (\S+)/) || [])[1];
    if (P.BY_ID[id].phpCheck) {
      out.php = { installed: have || null, problems: [], needs: null };
      try {
        const j = JSON.parse((r.stdout.match(/@@PHPCHECK (.*)/) || [])[1] || '[]');
        for (const x of Array.isArray(j) ? j : []) {
          if (x.status !== 'failed' && x.status !== 'missing') continue;
          const c = x.failed_requirement && x.failed_requirement.constraint || '';
          if (x.name === 'php') { out.php.needs = (c.match(/(\d+\.\d+)/) || [])[1] || null; out.php.problems.push(`PHP ${c} is required but this server has PHP ${x.version || have || '?'}`); }
          else out.php.problems.push(`The PHP extension ${String(x.name).replace(/^ext-/, '')} is required but is not installed`);
        }
      } catch { /* an unreadable check is not a problem report */ }
    }
    return out;
  }
}

module.exports = { DeployManager, checkRepo, NAME_RE, RELEASE_RE };
