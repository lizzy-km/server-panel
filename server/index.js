'use strict';
const http = require('http');
const path = require('path');
const { loadConfig } = require('./config');
const { JsonStore, AuditLog } = require('./lib/store');
const { Auth, httpError, safeEq, verifyPassword } = require('./lib/auth');
const { Vault } = require('./lib/vault');
const { ServerRegistry } = require('./lib/servers');
const { sendJson, readJson, parseCookies, serveStatic, applyHeaders } = require('./lib/http');
const sys = require('./lib/sys');
const ops = require('./lib/ops');
const pkg = require('./lib/pkg');
const { DeployManager } = require('./lib/deploy');
const { DomainManager } = require('./lib/domains');
const { LaravelManager } = require('./lib/laravel');
const { summarizeFile } = require('./lib/nginxparse');
const { readBody } = require('./lib/http');

const COOKIE = 'panel_session';

function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = new JsonStore(path.join(config.dataDir, 'panel.json'), {
    users: [], sessions: {}, servers: [], apps: [], sites: [], deploys: [], laravel: [], settings: { alerts: { cpu: 90, mem: 90, disk: 90 } },
  });
  const audit = new AuditLog(path.join(config.dataDir, 'audit.log'));
  const auth = new Auth(store, { sessionHours: config.sessionHours });
  const vault = new Vault(config.dataDir, config.secret);
  const servers = new ServerRegistry({ store, vault, config });
  const deploy = new DeployManager({ store, vault, servers, config });
  const domains = new DomainManager({ store, servers, deploy, config });
  const laravel = new LaravelManager({ store, servers, config });
  // an app's port changed and a deploy has made the new port live: repoint nginx sites that proxy to it
  deploy.onPortChanged = async (app) => {
    for (const site of domains.sites.filter((x) => x.serverId === app.serverId && x.upstream.type === 'app' && x.upstream.appId === app.id)) {
      await domains.apply(site);
      audit.write({ user: 'system', action: 'site_apply', detail: `${site.domain} repointed to port ${app.port}`, server: servers.entry(app.serverId).host.name });
    }
  };
  auth.ensureSetupToken();

  // ---- route table ----
  // perm: 'public' | 'user' (any signed-in user) | 'admin'
  // scoped routes act on one managed server, chosen with ?server=<id>; they get ctx.srv
  const routes = [];
  const route = (method, p, perm, handler) => routes.push({ method, p, perm, handler, scoped: false });
  const scoped = (method, p, perm, handler) => routes.push({ method, p, perm, handler, scoped: true });

  const q = (ctx, k, d = '') => ctx.url.searchParams.get(k) ?? d;
  const note = (ctx, action, detail) => audit.write({
    user: ctx.user ? ctx.user.username : null, ip: ctx.ip, action, detail,
    server: ctx.srv ? ctx.srv.host.name : undefined,
  });

  // --- session / auth ---
  route('GET', '/api/session', 'public', async (ctx) => ({
    setupRequired: auth.needsSetup(),
    user: ctx.user ? auth.publicUser(ctx.user) : null,
    features: { exec: config.enableExec, local: config.enableLocal, vault: vault.source },
  }));

  route('POST', '/api/setup', 'public', async (ctx) => {
    if (!auth.needsSetup()) throw httpError(403, 'Setup already completed');
    auth.checkThrottle(ctx.ip);
    const b = await readJson(ctx.req);
    if (!auth.setupToken || !safeEq(b.setupToken || '', auth.setupToken)) {
      auth.recordFailure(ctx.ip);
      throw httpError(403, 'Invalid setup token (see the server console)');
    }
    const user = auth.createUser(b.username, b.password, 'admin');
    auth.setupToken = null;
    ctx.setCookie = auth.createSession(user.id);
    audit.write({ user: user.username, ip: ctx.ip, action: 'setup', detail: 'initial admin created' });
    return { user: auth.publicUser(user) };
  });

  route('POST', '/api/login', 'public', async (ctx) => {
    const b = await readJson(ctx.req);
    try {
      const { user, token } = auth.login(ctx.ip, b.username, b.password);
      ctx.setCookie = token;
      audit.write({ user: user.username, ip: ctx.ip, action: 'login' });
      return { user: auth.publicUser(user) };
    } catch (e) {
      audit.write({ user: String(b.username || '').slice(0, 64), ip: ctx.ip, action: 'login_failed' });
      throw e;
    }
  });

  route('POST', '/api/logout', 'user', async (ctx) => {
    auth.destroySession(ctx.token);
    ctx.clearCookie = true;
    note(ctx, 'logout');
    return { ok: true };
  });

  route('POST', '/api/account/password', 'user', async (ctx) => {
    const b = await readJson(ctx.req);
    if (!verifyPassword(String(b.current || ''), ctx.user.hash)) throw httpError(403, 'Current password is incorrect');
    auth.setPassword(ctx.user.id, b.password);
    ctx.setCookie = auth.createSession(ctx.user.id);
    note(ctx, 'password_change');
    return { ok: true };
  });

  // --- managed servers ---
  route('GET', '/api/servers', 'user', async () => ({ servers: servers.list() }));

  route('POST', '/api/servers/probe', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    return servers.probe(b.host, b.port);
  });

  route('POST', '/api/servers', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 256 * 1024);
    const r = await servers.create(b, ctx.user.username);
    note(ctx, 'server_add', `${r.server.name} (${r.server.username}@${r.server.host}:${r.server.port}, key ${r.server.keyFingerprint})`);
    return r;
  });

  route('PUT', '/api/servers', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 256 * 1024);
    const r = await servers.update(String(b.id || ''), b);
    note(ctx, 'server_update', `${r.server.name}${b.privateKey ? ' (key replaced)' : ''}${b.hostKey ? ' (host key re-pinned)' : ''}`);
    return r;
  });

  route('DELETE', '/api/servers', 'admin', async (ctx) => {
    const id = q(ctx, 'id');
    const rec = servers.records.find((r) => r.id === id);
    servers.remove(id);
    deploy.forgetServer(id);
    note(ctx, 'server_remove', rec ? rec.name : id);
    return { ok: true };
  });

  route('POST', '/api/servers/test', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    return servers.test(String(b.id || ''));
  });

  // --- overview / metrics (per server) ---
  scoped('GET', '/api/system', 'user', async (ctx) => {
    const e = ctx.srv;
    const [info, disks] = await Promise.all([servers.info(e), sys.disks(e.host)]);
    const aws = servers.awsMeta(e);
    const up = e.sampler.latest();
    return { info: { ...info, uptime: up ? up.uptime : 0, bootTime: up ? Date.now() - up.uptime * 1000 : 0 }, disks, aws };
  });

  scoped('GET', '/api/metrics', 'user', async (ctx) => {
    await ctx.srv.sampler.touch();
    const since = Number(q(ctx, 'since', 0));
    return { intervalMs: config.sampleIntervalMs, points: ctx.srv.sampler.history.filter((p) => p.t > since) };
  });

  scoped('GET', '/api/alerts', 'user', async (ctx) => {
    await ctx.srv.sampler.touch();
    const t = store.data.settings.alerts;
    const l = ctx.srv.sampler.latest();
    const out = [];
    if (l && l.cpu >= t.cpu) out.push({ level: 'warn', message: `CPU usage is ${l.cpu.toFixed(0)}% (threshold ${t.cpu}%)` });
    if (l && l.mem.percent >= t.mem) out.push({ level: 'warn', message: `Memory usage is ${l.mem.percent.toFixed(0)}% (threshold ${t.mem}%)` });
    for (const d of await sys.disks(ctx.srv.host)) {
      if (d.percent >= t.disk) out.push({ level: d.percent >= 97 ? 'crit' : 'warn', message: `Disk ${d.mount} is ${d.percent}% full (threshold ${t.disk}%)` });
    }
    return { alerts: out, thresholds: t };
  });

  route('PUT', '/api/alerts/thresholds', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const next = {};
    for (const k of ['cpu', 'mem', 'disk']) {
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < 1 || v > 100) throw httpError(400, `Invalid ${k} threshold`);
      next[k] = v;
    }
    store.data.settings.alerts = next;
    store.save();
    note(ctx, 'alert_thresholds', JSON.stringify(next));
    return { ok: true };
  });

  // --- processes ---
  scoped('GET', '/api/processes', 'user', async (ctx) => sys.processes(ctx.srv.host));
  scoped('POST', '/api/processes/kill', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    await sys.killProcess(ctx.srv.host, Number(b.pid), b.signal || 'SIGTERM');
    note(ctx, 'process_signal', `pid=${b.pid} ${b.signal || 'SIGTERM'}`);
    return { ok: true };
  });
  scoped('GET', '/api/network/ports', 'user', async (ctx) => sys.listeningPorts(ctx.srv.host));

  // --- services ---
  scoped('GET', '/api/services', 'user', async (ctx) => ops.listServices(ctx.srv.host));
  scoped('GET', '/api/services/status', 'user', async (ctx) => ops.serviceStatus(ctx.srv.host, q(ctx, 'unit')));
  scoped('POST', '/api/services/action', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ops.serviceAction(ctx.srv.host, String(b.unit || ''), String(b.action || ''));
    note(ctx, 'service_' + b.action, b.unit);
    return r;
  });

  // --- packages (dnf) ---
  scoped('GET', '/api/packages', 'user', async (ctx) => pkg.listUpdates(ctx.srv.host, { refresh: q(ctx, 'refresh') === '1' }));
  scoped('POST', '/api/packages/upgrade', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    note(ctx, 'package_upgrade', b.securityOnly ? 'security updates' : (Array.isArray(b.packages) && b.packages.length ? b.packages.slice(0, 20).map(String).join(' ') : 'all packages'));
    return pkg.upgrade(ctx.srv.host, { packages: b.packages || [], securityOnly: !!b.securityOnly });
  });

  // --- docker ---
  scoped('GET', '/api/docker', 'user', async (ctx) => ops.dockerOverview(ctx.srv.host));
  scoped('GET', '/api/docker/logs', 'admin', async (ctx) => ops.dockerLogs(ctx.srv.host, q(ctx, 'id'), q(ctx, 'lines', 200)));
  scoped('POST', '/api/docker/action', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ops.dockerAction(ctx.srv.host, String(b.id || ''), String(b.action || ''));
    note(ctx, 'docker_' + b.action, b.id);
    return r;
  });

  // --- files (admin only) ---
  scoped('GET', '/api/files/list', 'admin', async (ctx) => ctx.srv.files.list(q(ctx, 'path', '/')));
  scoped('GET', '/api/files/read', 'admin', async (ctx) => ctx.srv.files.read(q(ctx, 'path')));
  scoped('PUT', '/api/files/write', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 8 * 1024 * 1024);
    const r = await ctx.srv.files.write(b.path, b.content);
    note(ctx, 'file_write', b.path);
    return r;
  });
  scoped('POST', '/api/files/mkdir', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ctx.srv.files.mkdir(b.path);
    note(ctx, 'file_mkdir', b.path);
    return r;
  });
  scoped('POST', '/api/files/rename', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ctx.srv.files.rename(b.from, b.to);
    note(ctx, 'file_rename', `${b.from} -> ${b.to}`);
    return r;
  });
  scoped('POST', '/api/files/delete', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ctx.srv.files.remove(b.path);
    note(ctx, 'file_delete', b.path);
    return r;
  });
  scoped('POST', '/api/files/chmod', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ctx.srv.files.chmod(b.path, b.mode);
    note(ctx, 'file_chmod', `${b.path} ${b.mode}`);
    return r;
  });
  scoped('POST', '/api/files/upload', 'admin', async (ctx) => {
    const r = await ctx.srv.files.upload(q(ctx, 'path', '/'), q(ctx, 'name'), ctx.req, config.maxUploadBytes);
    note(ctx, 'file_upload', `${q(ctx, 'path', '/')}/${q(ctx, 'name')}`);
    return r;
  });
  scoped('GET', '/api/files/download', 'admin', async (ctx) => {
    const d = await ctx.srv.files.downloadStream(q(ctx, 'path'));
    note(ctx, 'file_download', q(ctx, 'path'));
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': d.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    });
    d.stream.on('error', () => ctx.res.destroy());
    d.stream.pipe(ctx.res);
    return undefined;
  });

  // --- logs (admin only; may contain secrets) ---
  scoped('GET', '/api/logs/sources', 'admin', async (ctx) => ctx.srv.logs.sources());
  scoped('GET', '/api/logs/file', 'admin', async (ctx) => ctx.srv.logs.file(q(ctx, 'path'), q(ctx, 'lines', 300), q(ctx, 'q')));
  scoped('GET', '/api/logs/journal', 'admin', async (ctx) => ctx.srv.logs.journal({
    unit: q(ctx, 'unit'), lines: q(ctx, 'lines', 300), priority: q(ctx, 'priority'), q: q(ctx, 'q'),
  }));

  // --- cron ---
  scoped('GET', '/api/cron', 'admin', async (ctx) => ops.readCrontab(ctx.srv.host));
  scoped('PUT', '/api/cron', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ops.writeCrontab(ctx.srv.host, b.content);
    note(ctx, 'crontab_write');
    return r;
  });

  // --- terminal ---
  scoped('POST', '/api/exec', 'admin', async (ctx) => {
    if (!config.enableExec) throw httpError(403, 'Command execution is disabled (PANEL_ENABLE_EXEC=false)');
    const b = await readJson(ctx.req);
    if (typeof b.command !== 'string' || !b.command.trim() || b.command.length > 10000) throw httpError(400, 'Invalid command');
    note(ctx, 'exec', b.command.slice(0, 500));
    const cwd = b.cwd ? await ctx.srv.files.resolve(b.cwd).catch(() => undefined) : undefined;
    return ctx.srv.host.runShell(b.command, { timeoutMs: b.timeoutMs, cwd });
  });


  // --- deploy: server readiness, apps, releases, history ---
  const inServer = (ctx, rec) => { if (rec.serverId !== ctx.srv.id) throw httpError(404, 'Unknown app on this server'); return rec; };
  const appOf = (ctx, id) => inServer(ctx, deploy.find(id));
  const isAdmin = (ctx) => ctx.user.role === 'admin';

  scoped('GET', '/api/provision/status', 'user', async (ctx) => deploy.toolsStatus(ctx.srv.host));
  scoped('POST', '/api/provision/install', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await deploy.install(ctx.srv.id, b.tools, ctx.user.username);
    note(ctx, 'provision_install', (b.tools || []).join(' '));
    return r;
  });
  route('GET', '/api/jobs/log', 'admin', async (ctx) => {
    const id = q(ctx, 'id');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw httpError(400, 'Invalid job id');
    return deploy.runner.read(id, Number(q(ctx, 'offset', 0)) || 0);
  });

  route('GET', '/api/presets', 'user', async () => ({ presets: require('./lib/presets').publicPresets() }));
  scoped('POST', '/api/apps/detect', 'admin', async (ctx) => deploy.detect(ctx.srv.id, await readJson(ctx.req)));
  scoped('GET', '/api/apps', 'user', async (ctx) => ({ apps: deploy.list(ctx.srv.id, { admin: isAdmin(ctx) }), defaults: { baseDir: config.appsBaseDir } }));
  scoped('POST', '/api/apps', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 256 * 1024);
    const app = deploy.create(ctx.srv.id, b, ctx.user.username);
    if (b.env && typeof b.env === 'object') deploy.setEnv(app.id, b.env);
    note(ctx, 'app_create', `${app.name} (${app.repoUrl}@${app.branch})`);
    return { app: deploy.publicApp(app, { admin: true }) };
  });
  scoped('GET', '/api/apps/detail', 'user', async (ctx) => {
    const app = appOf(ctx, q(ctx, 'id'));
    const [status, releases] = await Promise.all([deploy.status(app).catch((e) => ({ active: 'unknown', error: e.message })), deploy.releases(app).catch(() => [])]);
    const webhookUrl = isAdmin(ctx) && app.webhookEnabled ? `${config.publicUrl || `${ctx.req.headers['x-forwarded-proto'] || 'http'}://${ctx.req.headers.host}`}/api/hooks/${app.id}/${deploy.publicApp(app, { admin: true }).webhookToken}` : null;
    return { app: deploy.publicApp(app, { admin: isAdmin(ctx) }), status, releases, deploys: deploy.deploys(app.id, 30), webhookUrl, sites: domains.sites.filter((x) => x.serverId === ctx.srv.id && x.upstream.type === 'app' && x.upstream.appId === app.id).map((x) => ({ id: x.id, domain: x.domain, https: !!x.tls })) };
  });
  scoped('PUT', '/api/apps', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 256 * 1024);
    appOf(ctx, b.id);
    const app = deploy.update(b.id, b);
    note(ctx, 'app_update', app.name);
    return { app: deploy.publicApp(app, { admin: true }) };
  });
  scoped('DELETE', '/api/apps', 'admin', async (ctx) => {
    const app = appOf(ctx, q(ctx, 'id'));
    await deploy.remove(app.id, { deleteFiles: q(ctx, 'deleteFiles') === '1' });
    note(ctx, 'app_delete', `${app.name}${q(ctx, 'deleteFiles') === '1' ? ' (files deleted)' : ''}`);
    return { ok: true };
  });
  scoped('PUT', '/api/apps/env', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 512 * 1024);
    appOf(ctx, b.id);
    const names = deploy.setEnv(b.id, b.vars);
    note(ctx, 'app_env', `${deploy.find(b.id).name}: ${Object.keys(b.vars).filter((k) => b.vars[k] !== null).length} set, ${Object.keys(b.vars).filter((k) => b.vars[k] === null).length} removed`);
    return { names };
  });
  scoped('GET', '/api/apps/env', 'admin', async (ctx) => {
    const app = appOf(ctx, q(ctx, 'id'));
    note(ctx, 'env_view', `${app.name} (values revealed)`);
    return { vars: deploy.envOf(app) };
  });
  scoped('POST', '/api/apps/env/save', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 512 * 1024);
    const app = appOf(ctx, b.id);
    const names = deploy.replaceEnv(app.id, b.vars);
    note(ctx, 'env_save', `${app.name}: ${names.length} variables`);
    return { names };
  });
  scoped('POST', '/api/apps/env/apply', 'admin', async (ctx) => {
    const app = appOf(ctx, (await readJson(ctx.req)).id);
    note(ctx, 'env_apply', app.name);
    return deploy.applyEnv(app.id);
  });
  scoped('POST', '/api/apps/webhook', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const app = appOf(ctx, b.id);
    deploy.rotateWebhook(app.id, b.enabled !== false);
    note(ctx, b.enabled === false ? 'webhook_disable' : 'webhook_rotate', app.name);
    return { ok: true };
  });
  scoped('POST', '/api/apps/deploy', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const app = appOf(ctx, b.id);
    const rec = await deploy.deploy(app.id, { trigger: 'manual', user: ctx.user.username, ref: b.ref || undefined });
    note(ctx, 'deploy', `${app.name} @ ${rec.ref}`);
    return { deploy: rec };
  });
  scoped('POST', '/api/apps/rollback', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const app = appOf(ctx, b.id);
    const rec = await deploy.rollback(app.id, b.release, { user: ctx.user.username });
    note(ctx, 'rollback', `${app.name} -> ${b.release}`);
    return { deploy: rec };
  });
  scoped('POST', '/api/apps/service', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const app = appOf(ctx, b.id);
    const r = await deploy.service(app, b.action);
    note(ctx, 'app_' + b.action, app.name);
    return r;
  });
  scoped('GET', '/api/apps/logs', 'admin', async (ctx) => deploy.serviceLogs(appOf(ctx, q(ctx, 'id')), q(ctx, 'lines', 200)));
  scoped('GET', '/api/deploys/log', 'admin', async (ctx) => {
    const rec = deploy.findDeploy(q(ctx, 'id'));
    if (rec.serverId !== ctx.srv.id) throw httpError(404, 'Unknown deploy on this server');
    return { ...deploy.log(rec.id, Number(q(ctx, 'offset', 0)) || 0), deploy: rec };
  });

  // --- domains: nginx sites, certificates, DNS / HTTP checks ---
  const siteOf = (ctx, id) => { const s = domains.find(id); if (s.serverId !== ctx.srv.id) throw httpError(404, 'Unknown domain on this server'); return s; };
  scoped('GET', '/api/nginx/status', 'user', async (ctx) => domains.nginxStatus(ctx.srv.id));
  scoped('POST', '/api/nginx/reload', 'admin', async (ctx) => {
    const t = await domains.nginxTest(ctx.srv.host);
    if (!t.ok) throw httpError(400, `nginx configuration is invalid; not reloading:\n${t.output}`);
    await domains.reload(ctx.srv.host);
    note(ctx, 'nginx_reload');
    return { ok: true, output: t.output };
  });
  scoped('GET', '/api/nginx/files', 'admin', async (ctx) => ({ files: await domains.listFiles(ctx.srv.id), confDir: config.nginxConfDir }));
  scoped('GET', '/api/nginx/file', 'admin', async (ctx) => domains.readConfFile(ctx.srv.id, q(ctx, 'name')));
  scoped('PUT', '/api/nginx/file', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 1024 * 1024);
    const r = await domains.saveConfFile(ctx.srv.id, b.name, b.content);
    note(ctx, 'nginx_file_save', `${b.name} (${String(b.content).length} bytes${r.created ? ', new file' : ''})`);
    return r;
  });
  scoped('DELETE', '/api/nginx/file', 'admin', async (ctx) => {
    const r = await domains.deleteConfFile(ctx.srv.id, q(ctx, 'name'));
    note(ctx, 'nginx_file_delete', q(ctx, 'name'));
    return r;
  });
  scoped('GET', '/api/nginx/discover', 'admin', async (ctx) => ({ sites: await domains.discover(ctx.srv.id) }));
  scoped('POST', '/api/sites/adopt', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const site = await domains.adopt(ctx.srv.id, b.file, ctx.user.username);
    note(ctx, 'site_adopt', `${site.domain} (${site.confFile})`);
    return { site: domains.publicSite(site) };
  });
  scoped('GET', '/api/sites', 'user', async (ctx) => ({ sites: domains.list(ctx.srv.id, isAdmin(ctx)) }));
  scoped('POST', '/api/sites', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 256 * 1024);
    const site = await domains.create(ctx.srv.id, b, ctx.user.username);
    note(ctx, 'site_create', site.domain);
    return { site: domains.publicSite(site) };
  });
  scoped('PUT', '/api/sites', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 256 * 1024);
    siteOf(ctx, b.id);
    const site = await domains.update(b.id, b);
    note(ctx, 'site_update', site.domain);
    return { site: domains.publicSite(site) };
  });
  scoped('DELETE', '/api/sites', 'admin', async (ctx) => {
    const site = siteOf(ctx, q(ctx, 'id'));
    await domains.remove(site.id, { removeCert: q(ctx, 'removeCert') === '1', keepFile: q(ctx, 'deleteFile') === '1' ? false : undefined });
    note(ctx, 'site_delete', site.domain);
    return { ok: true };
  });
  scoped('GET', '/api/sites/detail', 'user', async (ctx) => {
    const site = siteOf(ctx, q(ctx, 'id'));
    return { site: domains.publicSite(site, isAdmin(ctx)), status: await domains.status(site).catch((e) => ({ error: e.message })) };
  });
  scoped('GET', '/api/sites/config', 'admin', async (ctx) => ({ config: await domains.preview(siteOf(ctx, q(ctx, 'id'))) }));
  scoped('POST', '/api/sites/apply', 'admin', async (ctx) => {
    const site = siteOf(ctx, (await readJson(ctx.req)).id);
    const r = await domains.apply(site);
    note(ctx, 'site_apply', site.domain);
    return r;
  });
  scoped('POST', '/api/sites/cert/issue', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const site = siteOf(ctx, b.id);
    note(ctx, 'cert_issue', `${site.domain}${b.staging ? ' (staging)' : ''}`);
    return domains.issue(site.id, { email: b.email, staging: !!b.staging });
  });
  scoped('POST', '/api/sites/cert/renew', 'admin', async (ctx) => {
    const site = siteOf(ctx, (await readJson(ctx.req)).id);
    note(ctx, 'cert_renew', site.domain);
    return domains.renew(site.id);
  });
  scoped('POST', '/api/sites/cert/remove', 'admin', async (ctx) => {
    const site = siteOf(ctx, (await readJson(ctx.req)).id);
    await domains.removeCert(site.id);
    note(ctx, 'cert_remove', site.domain);
    return { ok: true };
  });
  scoped('GET', '/api/sites/dns', 'user', async (ctx) => domains.dns(siteOf(ctx, q(ctx, 'id'))));
  scoped('GET', '/api/sites/http', 'user', async (ctx) => domains.http(siteOf(ctx, q(ctx, 'id'))));
  scoped('GET', '/api/sites/logs', 'admin', async (ctx) => domains.logs(siteOf(ctx, q(ctx, 'id')), q(ctx, 'kind', 'access'), q(ctx, 'lines', 200)));

  // --- Laravel (PHP) apps: adopt existing installs, artisan, logs, .env ---
  const lvOf = (ctx, id) => { const a = laravel.find(id); if (a.serverId !== ctx.srv.id) throw httpError(404, 'Unknown Laravel app on this server'); return a; };
  const lvSites = (ctx, app) => domains.sites.filter((x) => x.serverId === ctx.srv.id && x.rawConfig && (summarizeFile(x.rawConfig).root || '').replace(/\/+$/, '') === `${app.path}/public`).map((x) => ({ id: x.id, domain: x.domain, https: !!x.tls }));
  scoped('GET', '/api/laravel', 'user', async (ctx) => ({ apps: laravel.list(ctx.srv.id).map((a) => ({ ...a, sites: lvSites(ctx, a) })) }));
  scoped('POST', '/api/laravel/inspect', 'admin', async (ctx) => ({ info: await laravel.inspect(ctx.srv.host, String((await readJson(ctx.req)).path || '')) }));
  scoped('POST', '/api/laravel', 'admin', async (ctx) => {
    const r = await laravel.adopt(ctx.srv.id, await readJson(ctx.req), ctx.user.username);
    note(ctx, 'laravel_adopt', `${r.app.name} (${r.app.path})`);
    return r;
  });
  scoped('GET', '/api/laravel/detail', 'user', async (ctx) => {
    const app = lvOf(ctx, q(ctx, 'id'));
    return { app, info: await laravel.detail(app, { fresh: q(ctx, 'fresh') === '1' }), sites: lvSites(ctx, app), artisan: Object.fromEntries(Object.entries(require('./lib/laravel').ARTISAN).map(([k, v]) => [k, v.label || k])) };
  });
  scoped('DELETE', '/api/laravel', 'admin', async (ctx) => {
    const app = lvOf(ctx, q(ctx, 'id'));
    laravel.remove(app.id);
    note(ctx, 'laravel_forget', `${app.name} (server files untouched)`);
    return { ok: true };
  });
  scoped('POST', '/api/laravel/artisan', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const app = lvOf(ctx, b.id);
    note(ctx, 'artisan', `${app.name}: ${b.command}`);
    return laravel.artisan(app, String(b.command || ''));
  });
  scoped('POST', '/api/laravel/fpm', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const app = lvOf(ctx, b.id);
    note(ctx, 'phpfpm_' + b.action, app.fpmUnit);
    return laravel.fpm(app, b.action);
  });
  scoped('GET', '/api/laravel/logfiles', 'admin', async (ctx) => ({ files: await laravel.logFiles(lvOf(ctx, q(ctx, 'id'))) }));
  scoped('GET', '/api/laravel/logs', 'admin', async (ctx) => laravel.logs(lvOf(ctx, q(ctx, 'id')), q(ctx, 'file'), q(ctx, 'lines', 300), q(ctx, 'q')));
  scoped('GET', '/api/laravel/env', 'admin', async (ctx) => {
    const app = lvOf(ctx, q(ctx, 'id'));
    note(ctx, 'env_view', `${app.name} .env (values revealed)`);
    return laravel.readEnv(app);
  });
  scoped('PUT', '/api/laravel/env', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 512 * 1024);
    const app = lvOf(ctx, b.id);
    const r = await laravel.writeEnv(app, b.content, { apply: !!b.apply, force: !!b.force });
    note(ctx, 'env_save', `${app.name} .env (${String(b.content).length} bytes${b.apply ? ', applied' : ''}${b.force ? ', APP_KEY override' : ''})`);
    return r;
  });

  // --- users & audit ---
  route('GET', '/api/users', 'admin', async () => ({ users: auth.users.map((u) => auth.publicUser(u)) }));
  route('POST', '/api/users', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const u = auth.createUser(b.username, b.password, b.role || 'viewer');
    note(ctx, 'user_create', `${u.username} (${u.role})`);
    return { user: auth.publicUser(u) };
  });
  route('POST', '/api/users/password', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    auth.setPassword(String(b.id), b.password);
    note(ctx, 'user_password_reset', b.id);
    return { ok: true };
  });
  route('DELETE', '/api/users', 'admin', async (ctx) => {
    const id = q(ctx, 'id');
    if (id === ctx.user.id) throw httpError(400, 'You cannot delete your own account');
    auth.removeUser(id);
    note(ctx, 'user_delete', id);
    return { ok: true };
  });
  route('GET', '/api/audit', 'admin', async (ctx) => ({ entries: audit.tail(Math.min(1000, Number(q(ctx, 'limit', 200)) || 200)) }));

  // ---- request pipeline ----
  async function handle(req, res) {
    applyHeaders(res);
    const url = new URL(req.url, 'http://panel.local');
    const ip = req.socket.remoteAddress || 'unknown';
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const ctx = { req, res, url, ip, token, user: auth.userFromToken(token), srv: null, setCookie: null, clearCookie: false };

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!serveStatic(config.publicDir, url.pathname, res)) sendJson(res, 404, { error: 'Not found' });
      return undefined;
    }

    try {
      // Deploy webhooks authenticate by secret URL token or GitHub HMAC signature (no cookie, so no CSRF header).
      if (req.method === 'POST' && url.pathname.startsWith('/api/hooks/')) {
        const [appId, token] = url.pathname.slice('/api/hooks/'.length).split('/');
        const raw = await readBody(req, 1024 * 1024);
        const h = await deploy.webhook(appId, token, req.headers, raw, ip);
        audit.write({ user: 'webhook', ip, action: 'webhook', detail: `${appId}: ${JSON.stringify(h.body).slice(0, 200)}` });
        return sendJson(res, h.status, h.body);
      }
      const r = routes.find((x) => x.method === req.method && x.p === url.pathname);
      if (!r) throw httpError(routes.some((x) => x.p === url.pathname) ? 405 : 404, 'Not found');

      // CSRF: state-changing requests must be same-origin and carry our header.
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw httpError(403, 'Cross-origin request blocked');
        if (req.headers['x-panel-request'] !== '1') throw httpError(403, 'Missing X-Panel-Request header');
      }
      if (r.perm !== 'public' && !ctx.user) throw httpError(401, 'Authentication required');
      if (r.perm === 'admin' && ctx.user.role !== 'admin') throw httpError(403, 'Administrator access required');
      if (r.scoped) ctx.srv = servers.entry(url.searchParams.get('server'));

      const result = await r.handler(ctx);
      if (res.headersSent) return undefined; // streamed (download)

      const flags = `HttpOnly; SameSite=Strict; Path=/${config.secureCookies ? '; Secure' : ''}`;
      if (ctx.setCookie) res.setHeader('Set-Cookie', `${COOKIE}=${ctx.setCookie}; Max-Age=${config.sessionHours * 3600}; ${flags}`);
      if (ctx.clearCookie) res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${flags}`);
      return sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'EACCES' || err.code === 'EPERM' ? 403 : err.code === 'EEXIST' ? 409 : 500);
      if (status === 500) console.error('[panel] internal error:', err);
      if (res.headersSent) { res.destroy(); return undefined; }
      const msg = status === 500 ? 'Internal server error' : err.code === 'ENOENT' ? 'Not found' : err.code === 'EEXIST' ? 'Already exists' : err.code === 'EACCES' ? 'Permission denied' : err.message;
      return sendJson(res, status, { error: msg });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 0; // allow long uploads; body size is limited separately
  return { server, config, auth, store, audit, servers, vault, deploy, domains, laravel };
}

function main() {
  const app = createApp();
  app.main = true;
  app.server.listen(app.config.port, app.config.host, () => {
    const { host, port } = app.config;
    console.log(`Server Panel listening on http://${host}:${port}`);
    console.log(`Managing ${app.servers.records.length} remote server(s)${app.config.enableLocal ? ' + this host' : ''}; secrets encrypted with ${app.vault.source === 'env' ? 'PANEL_SECRET' : 'data/master.key'}`);
    if (app.auth.needsSetup()) {
      console.log('\nFirst run: open the panel and create the admin account.');
      console.log(`Setup token: ${app.auth.ensureSetupToken()}\n`);
    }
    if (host !== '127.0.0.1' && host !== 'localhost' && !app.config.secureCookies) {
      console.warn('WARNING: panel is network-exposed without HTTPS cookies. Put it behind a TLS reverse proxy and set PANEL_SECURE_COOKIES=true.');
    }
  });
  const shutdown = () => { app.servers.closeAll(); app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return app;
}

if (require.main === module) main();

module.exports = { createApp, main };
