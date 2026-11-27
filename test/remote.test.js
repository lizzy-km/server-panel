'use strict';
/**
 * End-to-end tests for managing a REMOTE server over SSH, against a real throw-away sshd
 * (skipped automatically when sshd / ssh-keygen / sftp-server are not installed).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server/index');
const { hasBin, canSshd, tmp, genKey, toPpk, startSshd, os } = require('./helpers');

const skip = !canSshd();
const putty = hasBin('puttygen');

let app, base, dataDir, sshd, keys, root, outside, cookie = '', serverId;

const GLOBAL = /^\/api\/(session|setup|login|logout|account|users|audit|servers|alerts\/thresholds)/;
async function call(method, url, body, { server, cookieOverride } = {}) {
  const sid = server === undefined ? serverId : server;
  const u = GLOBAL.test(url) || !sid ? url : url + (url.includes('?') ? '&' : '?') + 'server=' + sid;
  const res = await fetch(base + u, {
    method,
    headers: { 'X-Panel-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookieOverride ?? cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie'), raw: JSON.stringify(json) };
}

const addServer = (over = {}) => call('POST', '/api/servers', {
  name: 'srv-' + Math.random().toString(36).slice(2, 7), host: '127.0.0.1', port: sshd.port, username: os.userInfo().username,
  privateKey: keys.ed.text, hostKey: sshd.hostKeyFp, fileRoot: root, ...over,
});

before(async () => {
  if (skip) return;
  const kdir = tmp('rkeys-');
  keys = {
    ed: genKey(kdir, 'ed', 'ed25519'),
    rsa: genKey(kdir, 'rsa', 'rsa', { pem: true, bits: 2048 }),
    pw: genKey(kdir, 'pw', 'ed25519', { pass: 'open-sesame' }),
    stranger: genKey(kdir, 'stranger', 'ed25519'), // NOT in authorized_keys
    dir: kdir,
  };
  sshd = await startSshd({ authorizedKeys: [keys.ed.pub, keys.rsa.pub, keys.pw.pub] });
  root = tmp('remote-root-');
  outside = tmp('remote-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello from the remote');
  dataDir = tmp('remote-data-');
  app = createApp({ dataDir, port: 0, host: '127.0.0.1', enableLocal: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await call('POST', '/api/setup', { username: 'admin', password: 'longenoughpass', setupToken: app.auth.setupToken });
  cookie = setup.setCookie.split(';')[0];
});

after(() => {
  if (skip) return;
  app.servers.closeAll(); app.server.close(); sshd.stop();
  for (const d of [dataDir, root, outside, keys.dir]) fs.rmSync(d, { recursive: true, force: true });
});

test('probe returns the real host key fingerprint', { skip }, async () => {
  const r = await call('POST', '/api/servers/probe', { host: '127.0.0.1', port: sshd.port });
  assert.equal(r.status, 200);
  assert.equal(r.json.fingerprint, sshd.hostKeyFp);
  assert.equal((await call('POST', '/api/servers/probe', { host: '--oProxyCommand=x', port: 22 })).status, 400);
  assert.equal((await call('POST', '/api/servers/probe', { host: '127.0.0.1', port: 1 })).status, 502);
});

test('adding a server verifies host key and credentials before saving anything', { skip }, async () => {
  const wrongPin = await addServer({ hostKey: 'SHA256:' + 'A'.repeat(43) });
  assert.equal(wrongPin.status, 502);
  assert.match(wrongPin.json.error, /Host key does not match/);
  const noPin = await addServer({ hostKey: '' });
  assert.equal(noPin.status, 400);
  const stranger = await addServer({ privateKey: keys.stranger.text });
  assert.equal(stranger.status, 502);
  assert.match(stranger.json.error, /Authentication failed/);
  const wrongUser = await addServer({ username: 'no-such-user-xyz' });
  assert.equal(wrongUser.status, 502);
  assert.equal((await call('GET', '/api/servers')).json.servers.length, 0, 'failed attempts must not be stored');
});

test('passphrase-protected key requires the passphrase', { skip }, async () => {
  const none = await addServer({ privateKey: keys.pw.text });
  assert.equal(none.status, 400);
  assert.match(none.json.error, /passphrase-protected/);
  assert.equal((await addServer({ privateKey: keys.pw.text, passphrase: 'wrong' })).status, 400);
  const ok = await addServer({ name: 'with-passphrase', privateKey: keys.pw.text, passphrase: 'open-sesame' });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal((await call('DELETE', '/api/servers?id=' + ok.json.server.id)).status, 200);
});

test('adds a server with an AWS-style .pem key; secrets are encrypted and never returned', { skip }, async () => {
  const r = await addServer({ name: 'aws-pem', privateKey: keys.rsa.text });
  assert.equal(r.status, 200, r.raw);
  serverId = r.json.server.id;
  assert.equal(r.json.info.user, os.userInfo().username);
  assert.equal(r.json.server.keyFingerprint, keys.rsa.fp);
  const body = [r.raw, (await call('GET', '/api/servers')).raw].join('');
  assert.ok(!/PRIVATE KEY/.test(body) && !body.includes(keys.rsa.text.split('\n')[1]), 'API must never expose key material');
  const stored = fs.readFileSync(path.join(dataDir, 'panel.json'), 'utf8');
  assert.ok(!/PRIVATE KEY/.test(stored) && !stored.includes(keys.rsa.text.split('\n')[1]), 'key must be encrypted at rest');
  assert.match(stored, /"keyEnc": "v1\./);
  assert.equal(fs.statSync(path.join(dataDir, 'master.key')).mode & 0o777, 0o600);
});

test('duplicate names are rejected and keys survive a panel restart', { skip }, async () => {
  assert.equal((await addServer({ name: 'AWS-PEM' })).status, 409);
  const app2 = createApp({ dataDir, port: 0, host: '127.0.0.1' }); // fresh process state, same data dir
  const e = app2.servers.entry(serverId);
  const r = await e.host.run('echo', ['reloaded']);
  assert.equal(r.stdout.trim(), 'reloaded');
  app2.servers.closeAll();
});

test('PuTTY .ppk keys work end to end', { skip: skip || !putty }, async () => {
  for (const version of [2, 3]) {
    const r = await addServer({ name: `ppk-v${version}`, privateKey: toPpk(keys.dir, keys.rsa, version) });
    assert.equal(r.status, 200, `v${version}: ${r.raw}`);
    assert.equal(r.json.server.keyFingerprint, keys.rsa.fp);
    await call('DELETE', '/api/servers?id=' + r.json.server.id);
  }
  const ed = await addServer({ name: 'ppk-ed', privateKey: toPpk(keys.dir, keys.ed, 3) });
  assert.equal(ed.status, 200, ed.raw);
  await call('DELETE', '/api/servers?id=' + ed.json.server.id);
});

test('passphrase-protected PuTTY v3 .ppk (what PuTTYgen saves by default) works end to end', { skip: skip || !putty }, async () => {
  const ppk = toPpk(keys.dir, keys.rsa, 3, 'open-sesame'); // unprotected source key, re-saved with a passphrase
  assert.equal((await addServer({ name: 'ppk3-pw', privateKey: ppk })).status, 400, 'passphrase required');
  assert.equal((await addServer({ name: 'ppk3-pw', privateKey: ppk, passphrase: 'nope' })).status, 400);
  const t0 = Date.now();
  const r = await addServer({ name: 'ppk3-pw', privateKey: ppk, passphrase: 'open-sesame' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.server.keyFingerprint, keys.rsa.fp);
  assert.ok(!/PuTTY-User|PRIVATE KEY|open-sesame/.test(fs.readFileSync(path.join(dataDir, 'panel.json'), 'utf8')), 'neither key nor passphrase stored in the clear');
  const ready = Date.now() - t0;
  // later connections reuse the converted key, so there is no second multi-second Argon2 run
  const t1 = Date.now();
  const e = app.servers.entry(r.json.server.id);
  assert.equal((await e.host.run('echo', ['again'])).stdout.trim(), 'again');
  assert.ok(Date.now() - t1 < Math.max(1500, ready / 2), `reconnect took ${Date.now() - t1} ms`);
  await call('DELETE', '/api/servers?id=' + r.json.server.id);
});

test('remote monitoring: system info, metrics, processes, ports', { skip }, async () => {
  const sys = await call('GET', '/api/system');
  assert.equal(sys.status, 200, sys.raw);
  assert.equal(sys.json.info.hostname, os.hostname());
  assert.equal(sys.json.info.user, os.userInfo().username);
  assert.ok(sys.json.disks.length > 0);
  const m = await call('GET', '/api/metrics');
  assert.ok(m.json.points.length >= 2);
  assert.ok(m.json.points.at(-1).mem.total > 0);
  const ps = await call('GET', '/api/processes');
  assert.ok(ps.json.list.some((p) => p.pid === sshd.pid), 'the sshd we started must appear in the REMOTE process list');
  const ports = await call('GET', '/api/network/ports');
  if (ports.json.available) assert.ok(ports.json.list.some((p) => p.local.endsWith(':' + sshd.port)));
});

test('remote exec, audit trail records which server', { skip }, async () => {
  const r = await call('POST', '/api/exec', { command: 'echo "$USER-ok"; echo err >&2; exit 4' });
  assert.equal(r.json.code, 4);
  assert.match(r.json.output, /-ok/);
  assert.match(r.json.output, /err/);
  const injected = await call('POST', '/api/exec', { command: "echo 'quoted'; echo \"$((6*7))\"" });
  assert.match(injected.json.output, /quoted\n42/);
  const t = await call('POST', '/api/exec', { command: 'sleep 20', timeoutMs: 1500 });
  assert.ok(t.json.timedOut, 'long command must be cut off');
  await new Promise((r2) => setTimeout(r2, 100));
  const audit = (await call('GET', '/api/audit')).json.entries;
  assert.ok(audit.some((e) => e.action === 'exec' && e.server === 'aws-pem'));
  assert.ok(audit.some((e) => e.action === 'server_add' && /aws-pem/.test(e.detail) && !/PRIVATE/.test(e.detail)));
});

test('remote file manager over SFTP: CRUD, upload, download', { skip }, async () => {
  const list = await call('GET', '/api/files/list?path=/');
  assert.ok(list.json.entries.some((e) => e.name === 'hello.txt' && e.type === 'file'));
  assert.ok(list.json.entries.some((e) => e.name === 'escape' && e.type === 'link'));
  assert.equal((await call('GET', '/api/files/read?path=/hello.txt')).json.content, 'hello from the remote');
  assert.equal((await call('PUT', '/api/files/write', { path: '/notes.txt', content: 'v1' })).status, 200);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'v1');
  assert.equal((await call('POST', '/api/files/mkdir', { path: '/sub' })).status, 200);
  assert.equal((await call('POST', '/api/files/rename', { from: '/notes.txt', to: '/sub/n.txt' })).status, 200);
  assert.equal((await call('PUT', '/api/files/write', { path: '/other.txt', content: 'v2' })).status, 200);
  assert.equal((await call('POST', '/api/files/rename', { from: '/other.txt', to: '/sub/n.txt' })).status, 200, 'rename overwrites like rename(2)');
  assert.equal(fs.readFileSync(path.join(root, 'sub/n.txt'), 'utf8'), 'v2');
  assert.equal((await call('POST', '/api/files/chmod', { path: '/sub/n.txt', mode: '600' })).status, 200);
  assert.equal(fs.statSync(path.join(root, 'sub/n.txt')).mode & 0o777, 0o600);

  const payload = Buffer.alloc(3 * 1024 * 1024 + 7, 0xab);
  const up = await fetch(`${base}/api/files/upload?server=${serverId}&path=/sub&name=big.bin`, { method: 'POST', headers: { 'X-Panel-Request': '1', Cookie: cookie }, body: payload });
  assert.equal(up.status, 200, await up.text());
  assert.equal(fs.statSync(path.join(root, 'sub/big.bin')).size, payload.length);
  assert.ok(fs.readFileSync(path.join(root, 'sub/big.bin')).equals(payload), 'uploaded bytes identical');
  assert.ok(!fs.readdirSync(path.join(root, 'sub')).some((f) => f.includes('.upload-')), 'temp upload file cleaned up');
  const dl = await fetch(`${base}/api/files/download?server=${serverId}&path=/sub/big.bin`, { headers: { Cookie: cookie } });
  assert.equal(dl.status, 200);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(payload), 'downloaded bytes identical');

  assert.equal((await call('GET', '/api/files/read?path=/sub/big.bin')).status, 413);
  assert.equal((await call('POST', '/api/files/delete', { path: '/sub' })).status, 200);
  assert.ok(!fs.existsSync(path.join(root, 'sub')), 'recursive delete worked');
});

test('remote file manager cannot escape its root', { skip }, async () => {
  for (const p of ['/../../etc/passwd', '/escape/secret.txt', '/escape']) {
    const r = await call('GET', `/api/files/${p === '/escape' ? 'list' : 'read'}?path=${encodeURIComponent(p)}`);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await call('PUT', '/api/files/write', { path: '/escape/pwn.txt', content: 'x' })).status, 400);
  assert.ok(!fs.existsSync(path.join(outside, 'pwn.txt')));
  assert.equal((await call('POST', '/api/files/delete', { path: '/' })).status, 400);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'top secret');
});

test('remote logs, cron and package endpoints behave on a non-AL2023 target', { skip }, async () => {
  fs.writeFileSync(path.join(root, 'app.log'), 'one\ntwo ERROR\nthree\n');
  const hostRoot = app.servers.entry(serverId).logs;
  hostRoot.dirs = [root];
  const src = await call('GET', '/api/logs/sources');
  assert.ok(src.json.files.some((f) => f.path.endsWith('/app.log')));
  const log = await call('GET', `/api/logs/file?path=${encodeURIComponent(path.join(root, 'app.log'))}&q=error`);
  assert.equal(log.json.output.trim(), 'two ERROR');
  assert.equal((await call('GET', '/api/logs/file?path=/etc/passwd')).status, 403);
  assert.equal((await call('GET', '/api/cron')).status, 200);
  assert.equal((await call('GET', '/api/packages')).status, 200);
  assert.equal((await call('POST', '/api/services/action', { unit: 'x; reboot', action: 'start' })).status, 400);
});

test('viewers can monitor but cannot manage servers or reach admin routes', { skip }, async () => {
  await call('POST', '/api/users', { username: 'viewer1', password: 'viewerpassword1', role: 'viewer' });
  const login = await call('POST', '/api/login', { username: 'viewer1', password: 'viewerpassword1' }, { cookieOverride: '' });
  const vc = login.setCookie.split(';')[0];
  assert.equal((await call('GET', '/api/servers', undefined, { cookieOverride: vc })).status, 200);
  assert.equal((await call('GET', '/api/processes', undefined, { cookieOverride: vc })).status, 200);
  for (const [m, u, b] of [
    ['POST', '/api/servers/probe', { host: '127.0.0.1', port: sshd.port }], ['POST', '/api/servers', {}], ['PUT', '/api/servers', {}],
    ['DELETE', '/api/servers?id=' + serverId], ['POST', '/api/servers/test', { id: serverId }], ['POST', '/api/exec', { command: 'id' }],
    ['GET', '/api/files/list?path=/'], ['POST', '/api/processes/kill', { pid: 2 }],
  ]) assert.equal((await call(m, u, b, { cookieOverride: vc })).status, 403, `${m} ${u}`);
  const noAuth = await call('GET', '/api/servers', undefined, { cookieOverride: '' });
  assert.equal(noAuth.status, 401);
});

test('scoped routes need a valid server id', { skip }, async () => {
  assert.equal((await call('GET', '/api/processes', undefined, { server: 'nope' })).status, 404);
  assert.equal((await call('GET', '/api/processes', undefined, { server: 'local' })).status, 404, 'local host management is off by default');
});

test('updating a server re-verifies connection details; test endpoint works', { skip }, async () => {
  const t = await call('POST', '/api/servers/test', { id: serverId });
  assert.equal(t.status, 200, t.raw);
  assert.equal(t.json.user, os.userInfo().username);
  const bad = await call('PUT', '/api/servers', { id: serverId, hostKey: 'SHA256:' + 'B'.repeat(43) });
  assert.equal(bad.status, 502);
  assert.equal((await call('GET', '/api/servers')).json.servers[0].hostKey, sshd.hostKeyFp, 'failed update must not be applied');
  const ok = await call('PUT', '/api/servers', { id: serverId, name: 'renamed', fileRoot: root });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.server.name, 'renamed');
  const swap = await call('PUT', '/api/servers', { id: serverId, privateKey: keys.ed.text });
  assert.equal(swap.status, 200, swap.raw);
  assert.equal(swap.json.server.keyFingerprint, keys.ed.fp);
  assert.equal((await call('GET', '/api/processes')).status, 200, 'works with the replaced key');
});

test('removing a server revokes access', { skip }, async () => {
  assert.equal((await call('DELETE', '/api/servers?id=' + serverId)).status, 200);
  assert.equal((await call('GET', '/api/processes')).status, 404);
  assert.equal((await call('GET', '/api/servers')).json.servers.length, 0);
});

test('an unreachable server reports a clear error instead of hanging', { skip }, async () => {
  const dead = 20000 + Math.floor(Math.random() * 10000);
  const probe = await call('POST', '/api/servers/probe', { host: '127.0.0.1', port: dead });
  assert.equal(probe.status, 502);
  assert.match(probe.json.error, /refused/i);
});
