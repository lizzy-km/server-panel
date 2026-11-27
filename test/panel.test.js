'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/index');
const { hashPassword, verifyPassword } = require('../server/lib/auth');
const sys = require('../server/lib/sys');
const ops = require('../server/lib/ops');
const pkg = require('../server/lib/pkg');

let app, base, dataDir, filesDir, outside;
let cookie = '';

const GLOBAL = /^\/api\/(session|setup|login|logout|account|users|audit|servers|alerts\/thresholds)/;
const scopedUrl = (url) => (GLOBAL.test(url) ? url : url + (url.includes('?') ? '&' : '?') + 'server=local');

async function call(method, url, body, { cookieOverride, headers = {} } = {}) {
  const res = await fetch(base + scopedUrl(url), {
    method,
    headers: { 'X-Panel-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookieOverride ?? cookie ? { Cookie: cookieOverride ?? cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json, setCookie: sc };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-data-'));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-files-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(filesDir, 'escape'));
  fs.writeFileSync(path.join(filesDir, 'hello.txt'), 'hello');
  app = createApp({ dataDir, filesRoot: filesDir, port: 0, host: '127.0.0.1', logDirs: [filesDir], enableLocal: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.servers.closeAll();
  app.server.close();
  for (const d of [dataDir, filesDir, outside]) fs.rmSync(d, { recursive: true, force: true });
});

test('password hashing round-trips and rejects wrong passwords', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', 'garbage'));
});

test('unauthenticated API access is rejected, static files are served', async () => {
  assert.equal((await call('GET', '/api/system')).status, 401);
  const html = await fetch(base + '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/..%2f..%2fpackage.json')).status, 404);
});

test('setup requires the console token and only works once', async () => {
  assert.equal((await call('GET', '/api/session')).json.setupRequired, true);
  const bad = await call('POST', '/api/setup', { username: 'admin', password: 'longenoughpass', setupToken: 'nope' });
  assert.equal(bad.status, 403);
  const weak = await call('POST', '/api/setup', { username: 'admin', password: 'short', setupToken: app.auth.setupToken });
  assert.equal(weak.status, 400);
  const ok = await call('POST', '/api/setup', { username: 'admin', password: 'longenoughpass', setupToken: app.auth.setupToken });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  cookie = ok.setCookie.split(';')[0];
  assert.equal((await call('POST', '/api/setup', { username: 'x2', password: 'longenoughpass', setupToken: 'a' })).status, 403);
});

test('CSRF protections: header and origin are enforced on writes', async () => {
  const noHeader = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(noHeader.status, 403);
  const crossOrigin = await call('POST', '/api/logout', {}, { headers: { Origin: 'http://evil.example' } });
  assert.equal(crossOrigin.status, 403);
});

test('system, metrics and alerts endpoints return data', async () => {
  const s = await call('GET', '/api/system');
  assert.equal(s.status, 200);
  assert.ok(s.json.info.hostname);
  const m = await call('GET', '/api/metrics');
  assert.ok(m.json.points.length >= 1);
  assert.ok(m.json.points[0].mem.total > 0);
  const a = await call('GET', '/api/alerts');
  assert.ok(Array.isArray(a.json.alerts));
  assert.equal((await call('PUT', '/api/alerts/thresholds', { cpu: 0, mem: 90, disk: 90 })).status, 400);
  assert.equal((await call('PUT', '/api/alerts/thresholds', { cpu: 80, mem: 85, disk: 95 })).status, 200);
});

test('files: CRUD works inside the root', async () => {
  const list = await call('GET', '/api/files/list?path=/');
  assert.ok(list.json.entries.some((e) => e.name === 'hello.txt'));
  assert.equal((await call('PUT', '/api/files/write', { path: '/notes.txt', content: 'abc' })).status, 200);
  assert.equal((await call('GET', '/api/files/read?path=/notes.txt')).json.content, 'abc');
  assert.equal((await call('POST', '/api/files/mkdir', { path: '/sub' })).status, 200);
  assert.equal((await call('POST', '/api/files/rename', { from: '/notes.txt', to: '/sub/n.txt' })).status, 200);
  assert.equal((await call('POST', '/api/files/chmod', { path: '/sub/n.txt', mode: '600' })).status, 200);
  assert.equal((await call('POST', '/api/files/delete', { path: '/sub' })).status, 200);
  assert.ok(!fs.existsSync(path.join(filesDir, 'sub')));
  const up = await fetch(base + '/api/files/upload?server=local&path=/&name=up.bin', { method: 'POST', headers: { 'X-Panel-Request': '1', Cookie: cookie }, body: Buffer.from([1, 2, 3, 0]) });
  assert.equal(up.status, 200);
  assert.equal(fs.statSync(path.join(filesDir, 'up.bin')).size, 4);
  const dl = await fetch(base + '/api/files/download?server=local&path=/up.bin', { headers: { Cookie: cookie } });
  assert.equal((await dl.arrayBuffer()).byteLength, 4);
  assert.equal((await call('GET', '/api/files/read?path=/up.bin')).status, 415);
});

test('files: traversal and symlink escapes are blocked', async () => {
  for (const p of ['/../', '/../../etc/passwd', '/escape/secret.txt', '/escape']) {
    const r = await call('GET', `/api/files/${p.endsWith('/') || p === '/escape' ? 'list' : 'read'}?path=${encodeURIComponent(p)}`);
    assert.ok([400, 404].includes(r.status) || (p === '/../' && r.status === 200), `${p} -> ${r.status}`);
    if (r.status === 200) assert.equal(r.json.path, '/'); // '..' clamps to root
  }
  assert.equal((await call('PUT', '/api/files/write', { path: '/escape/pwn.txt', content: 'x' })).status, 400);
  assert.ok(!fs.existsSync(path.join(outside, 'pwn.txt')));
  assert.equal((await call('POST', '/api/files/delete', { path: '/' })).status, 400);
  assert.equal((await call('POST', '/api/files/upload?path=/&name=..%2Fx', undefined)).status, 400);
  assert.equal((await call('GET', '/api/files/list?path=/')).status, 200);
  const noServer = await fetch(base + '/api/files/list?path=/', { headers: { Cookie: cookie } });
  assert.equal(noServer.status, 400); // scoped routes refuse to guess which server you meant
});

test('logs: only allow-listed directories', async () => {
  fs.writeFileSync(path.join(filesDir, 'app.log'), 'one\ntwo ERROR\nthree\n');
  const ok = await call('GET', `/api/logs/file?path=${encodeURIComponent(path.join(filesDir, 'app.log'))}&q=error`);
  assert.equal(ok.json.output.trim(), 'two ERROR');
  assert.equal((await call('GET', '/api/logs/file?path=/etc/passwd')).status, 403);
  assert.equal((await call('GET', '/api/logs/journal?unit=' + encodeURIComponent('x;rm -rf /'))).status, 400);
});

test('processes: parse, list and refuse dangerous signals', async () => {
  const p = await call('GET', '/api/processes');
  assert.equal(p.status, 200);
  if (p.json.available) assert.ok(p.json.list.some((x) => x.pid === process.pid));
  assert.equal((await call('POST', '/api/processes/kill', { pid: 1 })).status, 400);
  assert.equal((await call('POST', '/api/processes/kill', { pid: process.pid })).status, 400);
  assert.equal((await call('POST', '/api/processes/kill', { pid: 99999999, signal: 'SIGTERM' })).status, 404);
  assert.equal((await call('POST', '/api/processes/kill', { pid: 5, signal: 'SIGSEGV' })).status, 400);
});

test('exec runs commands, records them in the audit log, and enforces timeouts', async () => {
  const r = await call('POST', '/api/exec', { command: 'echo hi; echo err 1>&2; exit 3' });
  assert.equal(r.json.code, 3);
  assert.match(r.json.output, /hi/);
  const t = await call('POST', '/api/exec', { command: 'sleep 5', timeoutMs: 1000 });
  assert.ok(t.json.timedOut);
  await new Promise((r2) => setTimeout(r2, 100));
  const audit = await call('GET', '/api/audit');
  assert.ok(audit.json.entries.some((e) => e.action === 'exec' && /echo hi/.test(e.detail)));
});

test('service / docker inputs are validated before reaching a shell-out', async () => {
  assert.equal((await call('POST', '/api/services/action', { unit: 'x; reboot', action: 'start' })).status, 400);
  assert.equal((await call('POST', '/api/services/action', { unit: 'ssh.service', action: 'poweroff' })).status, 400);
  assert.equal((await call('POST', '/api/docker/action', { id: '--privileged', action: 'start' })).status, 400);
  assert.equal((await call('GET', '/api/docker/logs?id=' + encodeURIComponent('a b'))).status, 400);
});

test('users: roles, permissions, and last-admin protection', async () => {
  assert.equal((await call('POST', '/api/users', { username: 'bob', password: 'bobspassword1', role: 'viewer' })).status, 200);
  assert.equal((await call('POST', '/api/users', { username: 'BOB', password: 'bobspassword1' })).status, 409);
  const login = await call('POST', '/api/login', { username: 'bob', password: 'bobspassword1' });
  const bobCookie = login.setCookie.split(';')[0];
  assert.equal((await call('GET', '/api/system', undefined, { cookieOverride: bobCookie })).status, 200);
  for (const [m, u] of [['GET', '/api/files/list'], ['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/logs/sources'], ['GET', '/api/cron']]) {
    assert.equal((await call(m, u, undefined, { cookieOverride: bobCookie })).status, 403, u);
  }
  assert.equal((await call('POST', '/api/exec', { command: 'id' }, { cookieOverride: bobCookie })).status, 403);
  const users = (await call('GET', '/api/users')).json.users;
  const admin = users.find((u) => u.username === 'admin');
  assert.equal((await call('DELETE', '/api/users?id=' + admin.id)).status, 400);
  const bob = users.find((u) => u.username === 'bob');
  assert.equal((await call('POST', '/api/users/password', { id: bob.id, password: 'newbobpassword' })).status, 200);
  // password reset revokes bob's sessions
  assert.equal((await call('GET', '/api/system', undefined, { cookieOverride: bobCookie })).status, 401);
  assert.equal((await call('DELETE', '/api/users?id=' + bob.id)).status, 200);
});

test('login throttling locks out repeated failures', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/login', { username: 'admin', password: 'wrong-password' }, { cookieOverride: '' });
  assert.equal(last.status, 429);
  app.auth.failures.clear();
});

test('logout invalidates the session', async () => {
  const l = await call('POST', '/api/login', { username: 'admin', password: 'longenoughpass' }, { cookieOverride: '' });
  const c = l.setCookie.split(';')[0];
  assert.equal((await call('POST', '/api/logout', {}, { cookieOverride: c })).status, 200);
  assert.equal((await call('GET', '/api/system', undefined, { cookieOverride: c })).status, 401);
});

test('crontab validation', () => {
  assert.deepEqual(ops.validateCrontab('# c\nMAILTO=a@b.c\n*/5 * * * * /bin/true\n@reboot /bin/x\n'), []);
  assert.equal(ops.validateCrontab('not a cron line').length, 1);
});

test('parsers: df, ps, ss, systemd units', () => {
  const df = sys.parseDf('Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 400 600 40% /\ntmpfs tmpfs 10 1 9 10% /run\n');
  assert.equal(df.length, 1);
  assert.equal(df[0].used, 400 * 1024);
  const ps = sys.parsePs('  PID  PPID USER %CPU %MEM RSS ELAPSED STAT COMMAND COMMAND\n  12     1 root  1.5  0.2 2048 01:02 Ss sshd sshd -D\n');
  assert.deepEqual([ps[0].pid, ps[0].cpu, ps[0].rss, ps[0].command], [12, 1.5, 2048 * 1024, 'sshd -D']);
  assert.equal(sys.parseSs('tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=7,fd=3))')[0].pid, 7);
  assert.equal(ops.parseUnits('ssh.service loaded active running OpenBSD Secure Shell server\n')[0].description, 'OpenBSD Secure Shell server');
});

test('dnf parsers handle Amazon Linux 2023 output', () => {
  const upd = pkg.parseCheckUpdate('\nkernel.x86_64                6.1.79-99.167.amzn2023   amazonlinux\nopenssl-libs.x86_64   1:3.0.8-1.amzn2023.0.4  amazonlinux\n\nObsoleting Packages\nfoo.x86_64 1.0 amazonlinux\n    old.x86_64 0.9 @amazonlinux\n');
  assert.deepEqual(upd.map((u) => u.name), ['kernel', 'openssl-libs']);
  assert.equal(upd[1].version, '1:3.0.8-1.amzn2023.0.4');
  const sec = pkg.parseSecurity('ALAS2023-2024-533 Important/Sec. kernel-6.1.79-99.167.amzn2023.x86_64\nALAS2023-2024-001 low/Sec. openssl-libs-1:3.0.8-1.amzn2023.0.4.x86_64\n');
  assert.equal(sec.kernel.severity, 'Important');
  assert.equal(sec['openssl-libs'].severity, 'Low');
});

test('packages API: listing works without dnf and upgrade input is validated', async () => {
  const l = await call('GET', '/api/packages');
  assert.equal(l.status, 200);
  assert.ok(Array.isArray(l.json.updates));
  for (const bad of [['--installroot=/x'], ['/tmp/evil.rpm'], ['a b'], 'notalist']) {
    assert.equal((await call('POST', '/api/packages/upgrade', { packages: bad })).status, 400, JSON.stringify(bad));
  }
});

test('cron endpoint explains how to install cronie when missing', async () => {
  const r = await call('GET', '/api/cron');
  assert.equal(r.status, 200);
  if (!r.json.available) assert.match(r.json.hint, /dnf install -y cronie/);
});
