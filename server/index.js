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

const COOKIE = 'panel_session';

function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = new JsonStore(path.join(config.dataDir, 'panel.json'), {
    users: [], sessions: {}, servers: [], settings: { alerts: { cpu: 90, mem: 90, disk: 90 } },
  });
  const audit = new AuditLog(path.join(config.dataDir, 'audit.log'));
  const auth = new Auth(store, { sessionHours: config.sessionHours });
  const vault = new Vault(config.dataDir, config.secret);
  const servers = new ServerRegistry({ store, vault, config });
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
  return { server, config, auth, store, audit, servers, vault };
}

function main() {
  const app = createApp();
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
}

if (require.main === module) main();

module.exports = { createApp };
