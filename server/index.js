'use strict';
const http = require('http');
const path = require('path');
const { loadConfig } = require('./config');
const { JsonStore, AuditLog } = require('./lib/store');
const { Auth, httpError, safeEq } = require('./lib/auth');
const { sendJson, readJson, parseCookies, serveStatic, applyHeaders } = require('./lib/http');
const sys = require('./lib/sys');
const ops = require('./lib/ops');

const COOKIE = 'panel_session';

function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = new JsonStore(path.join(config.dataDir, 'panel.json'), { users: [], sessions: {}, settings: { alerts: { cpu: 90, mem: 90, disk: 90 } } });
  const audit = new AuditLog(path.join(config.dataDir, 'audit.log'));
  const auth = new Auth(store, { sessionHours: config.sessionHours });
  const sampler = new sys.Sampler({ intervalMs: config.sampleIntervalMs, length: config.historyLength });
  auth.ensureSetupToken();
  const files = new ops.FileManager(config.filesRoot);
  const logs = new ops.LogReader(config.logDirs);

  // ---- route table: [method, path, permission, handler] ----
  // permission: 'public' | 'user' (any signed-in) | 'admin'
  const routes = [];
  const route = (method, p, perm, handler) => routes.push({ method, p, perm, handler });

  const q = (ctx, k, d = '') => ctx.url.searchParams.get(k) ?? d;
  const note = (ctx, action, detail) => audit.write({ user: ctx.user ? ctx.user.username : null, ip: ctx.ip, action, detail });

  // --- session / auth ---
  route('GET', '/api/session', 'public', async (ctx) => ({
    setupRequired: auth.needsSetup(),
    user: ctx.user ? auth.publicUser(ctx.user) : null,
    features: { exec: config.enableExec },
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
    const token = auth.createSession(user.id);
    audit.write({ user: user.username, ip: ctx.ip, action: 'setup', detail: 'initial admin created' });
    ctx.setCookie = token;
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
    const { verifyPassword } = require('./lib/auth');
    if (!verifyPassword(String(b.current || ''), ctx.user.hash)) throw httpError(403, 'Current password is incorrect');
    auth.setPassword(ctx.user.id, b.password);
    const token = auth.createSession(ctx.user.id);
    ctx.setCookie = token;
    note(ctx, 'password_change');
    return { ok: true };
  });

  // --- overview / metrics ---
  route('GET', '/api/system', 'user', async () => ({ info: sys.systemInfo(), disks: await sys.disks(), latest: sampler.latest() }));
  route('GET', '/api/metrics', 'user', async (ctx) => {
    const since = Number(q(ctx, 'since', 0));
    const h = sampler.history.filter((p) => p.t > since).map(({ netTotals, ...rest }) => rest);
    return { intervalMs: config.sampleIntervalMs, points: h };
  });
  route('GET', '/api/alerts', 'user', async () => {
    const t = store.data.settings.alerts;
    const l = sampler.latest();
    const out = [];
    if (l.cpu >= t.cpu) out.push({ level: 'warn', message: `CPU usage is ${l.cpu.toFixed(0)}% (threshold ${t.cpu}%)` });
    if (l.mem.percent >= t.mem) out.push({ level: 'warn', message: `Memory usage is ${l.mem.percent.toFixed(0)}% (threshold ${t.mem}%)` });
    for (const d of await sys.disks()) {
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
  route('GET', '/api/processes', 'user', async () => sys.processes());
  route('POST', '/api/processes/kill', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    sys.killProcess(Number(b.pid), b.signal || 'SIGTERM');
    note(ctx, 'process_signal', `pid=${b.pid} ${b.signal || 'SIGTERM'}`);
    return { ok: true };
  });
  route('GET', '/api/network/ports', 'user', async () => sys.listeningPorts());

  // --- services ---
  route('GET', '/api/services', 'user', async () => ops.listServices());
  route('GET', '/api/services/status', 'user', async (ctx) => ops.serviceStatus(q(ctx, 'unit')));
  route('POST', '/api/services/action', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ops.serviceAction(String(b.unit || ''), String(b.action || ''));
    note(ctx, 'service_' + b.action, b.unit);
    return r;
  });

  // --- docker ---
  route('GET', '/api/docker', 'user', async () => ops.dockerOverview());
  route('GET', '/api/docker/logs', 'admin', async (ctx) => ops.dockerLogs(q(ctx, 'id'), q(ctx, 'lines', 200)));
  route('POST', '/api/docker/action', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ops.dockerAction(String(b.id || ''), String(b.action || ''));
    note(ctx, 'docker_' + b.action, b.id);
    return r;
  });

  // --- files (admin only) ---
  route('GET', '/api/files/list', 'admin', async (ctx) => files.list(q(ctx, 'path', '/')));
  route('GET', '/api/files/read', 'admin', async (ctx) => files.read(q(ctx, 'path')));
  route('PUT', '/api/files/write', 'admin', async (ctx) => {
    const b = await readJson(ctx.req, 8 * 1024 * 1024);
    const r = await files.write(b.path, b.content);
    note(ctx, 'file_write', b.path);
    return r;
  });
  route('POST', '/api/files/mkdir', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await files.mkdir(b.path);
    note(ctx, 'file_mkdir', b.path);
    return r;
  });
  route('POST', '/api/files/rename', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await files.rename(b.from, b.to);
    note(ctx, 'file_rename', `${b.from} -> ${b.to}`);
    return r;
  });
  route('POST', '/api/files/delete', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await files.remove(b.path);
    note(ctx, 'file_delete', b.path);
    return r;
  });
  route('POST', '/api/files/chmod', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await files.chmod(b.path, b.mode);
    note(ctx, 'file_chmod', `${b.path} ${b.mode}`);
    return r;
  });
  route('POST', '/api/files/upload', 'admin', async (ctx) => {
    const r = await files.upload(q(ctx, 'path', '/'), q(ctx, 'name'), ctx.req, config.maxUploadBytes);
    note(ctx, 'file_upload', `${q(ctx, 'path', '/')}/${q(ctx, 'name')}`);
    return r;
  });
  route('GET', '/api/files/download', 'admin', async (ctx) => {
    const d = await files.downloadStream(q(ctx, 'path'));
    note(ctx, 'file_download', q(ctx, 'path'));
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': d.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    });
    d.stream.pipe(ctx.res);
    return undefined;
  });

  // --- logs (admin only; may contain secrets) ---
  route('GET', '/api/logs/sources', 'admin', async () => logs.sources());
  route('GET', '/api/logs/file', 'admin', async (ctx) => logs.file(q(ctx, 'path'), q(ctx, 'lines', 300), q(ctx, 'q')));
  route('GET', '/api/logs/journal', 'admin', async (ctx) => logs.journal({
    unit: q(ctx, 'unit'), lines: q(ctx, 'lines', 300), priority: q(ctx, 'priority'), q: q(ctx, 'q'),
  }));

  // --- cron ---
  route('GET', '/api/cron', 'admin', async () => ops.readCrontab());
  route('PUT', '/api/cron', 'admin', async (ctx) => {
    const b = await readJson(ctx.req);
    const r = await ops.writeCrontab(b.content);
    note(ctx, 'crontab_write');
    return r;
  });

  // --- terminal ---
  route('POST', '/api/exec', 'admin', async (ctx) => {
    if (!config.enableExec) throw httpError(403, 'Command execution is disabled (PANEL_ENABLE_EXEC=false)');
    const b = await readJson(ctx.req);
    if (typeof b.command !== 'string' || !b.command.trim() || b.command.length > 10000) throw httpError(400, 'Invalid command');
    note(ctx, 'exec', b.command.slice(0, 500));
    return ops.runCommand(b.command, { timeoutMs: b.timeoutMs, cwd: b.cwd ? await files.resolve(b.cwd).catch(() => undefined) : undefined });
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
    const ctx = { req, res, url, ip, token, user: auth.userFromToken(token), setCookie: null, clearCookie: false };

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

      const result = await r.handler(ctx);
      if (res.headersSent) return undefined; // streamed (download)

      const headers = {};
      const flags = `HttpOnly; SameSite=Strict; Path=/${config.secureCookies ? '; Secure' : ''}`;
      if (ctx.setCookie) headers['Set-Cookie'] = `${COOKIE}=${ctx.setCookie}; Max-Age=${config.sessionHours * 3600}; ${flags}`;
      if (ctx.clearCookie) headers['Set-Cookie'] = `${COOKIE}=; Max-Age=0; ${flags}`;
      if (headers['Set-Cookie']) res.setHeader('Set-Cookie', headers['Set-Cookie']);
      return sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'EACCES' || err.code === 'EPERM' ? 403 : err.code === 'EEXIST' ? 409 : 500);
      if (status === 500) console.error('[panel] internal error:', err);
      if (res.headersSent) { res.destroy(); return undefined; }
      const msg = status === 500 ? 'Internal server error' : err.code === 'ENOENT' ? 'Not found' : err.code === 'EEXIST' ? 'Already exists' : err.message;
      return sendJson(res, status, { error: msg });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 0; // allow long uploads; body size is limited separately
  return { server, config, sampler, auth, store, audit };
}

function main() {
  const app = createApp();
  app.sampler.start();
  app.server.listen(app.config.port, app.config.host, () => {
    const { host, port } = app.config;
    console.log(`Server Panel listening on http://${host}:${port}`);
    if (app.auth.needsSetup()) {
      console.log('\nFirst run: open the panel and create the admin account.');
      console.log(`Setup token: ${app.auth.ensureSetupToken()}\n`);
    }
    if (host !== '127.0.0.1' && host !== 'localhost' && !app.config.secureCookies) {
      console.warn('WARNING: panel is network-exposed without HTTPS cookies. Put it behind a TLS reverse proxy and set PANEL_SECURE_COOKIES=true.');
    }
  });
  const shutdown = () => { app.sampler.stop(); app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApp };
