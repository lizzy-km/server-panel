'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/index');
const totp = require('../server/lib/totp');

let app, base, dataDir; let cookie = '';
async function call(method, url, body, { cookieOverride, ip } = {}) {
  const res = await fetch(base + url, { method, headers: { 'X-Panel-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...((cookieOverride ?? cookie) ? { Cookie: cookieOverride ?? cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-2fa-'));
  app = createApp({ dataDir, port: 0, host: '127.0.0.1', enableLocal: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const s = await call('POST', '/api/setup', { username: 'admin', password: 'adminpassword1', setupToken: app.auth.setupToken });
  cookie = s.setCookie.split(';')[0];
});
after(() => { app.servers.closeAll(); app.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('TOTP matches the RFC 6238 test vectors', () => {
  const secret = totp.base32(Buffer.from('12345678901234567890'));
  // RFC 6238 appendix B (SHA-1), last 6 digits of the 8-digit values
  assert.equal(totp.code(secret, 59 * 1000), '287082');
  assert.equal(totp.code(secret, 1111111109 * 1000), '081804');
  assert.equal(totp.code(secret, 2000000000 * 1000), '279037');
  assert.equal(totp.verify(secret, '287082', { now: 59000 }), 1);
  assert.equal(totp.verify(secret, '287082', { now: 59000, after: 1 }), null, 'a used step is refused');
  assert.equal(totp.verify(secret, '000000', { now: 59000 }), null);
  assert.equal(totp.verify(secret, 'abcdef', { now: 59000 }), null);
  assert.deepEqual(totp.unbase32(totp.base32(Buffer.from('hello'))), Buffer.from('hello'));
});

test('two-step verification: enrol, sign in with a code, replay and recovery codes', async () => {
  assert.equal((await call('POST', '/api/account/2fa/start', { password: 'wrong' })).status, 403);
  const st = await call('POST', '/api/account/2fa/start', { password: 'adminpassword1' });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.match(st.json.url, /^otpauth:\/\/totp\/Server%20Panel:admin\?secret=[A-Z2-7]+/);
  const secret = st.json.secret;
  // not on yet: password alone still works
  assert.ok((await call('POST', '/api/login', { username: 'admin', password: 'adminpassword1' }, { cookieOverride: '' })).setCookie);
  assert.equal((await call('POST', '/api/account/2fa/enable', { code: '000000' })).status, 400);
  const en = await call('POST', '/api/account/2fa/enable', { code: totp.code(secret) });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  assert.equal(en.json.recovery.length, 10);
  assert.match(en.json.recovery[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  const stored = fs.readFileSync(path.join(dataDir, 'panel.json'), 'utf8');
  assert.ok(!stored.includes(secret), 'secret is stored encrypted');
  assert.ok(!stored.includes(en.json.recovery[0]), 'recovery codes are stored hashed');

  const nc = { cookieOverride: '' };
  const first = await call('POST', '/api/login', { username: 'admin', password: 'adminpassword1' }, nc);
  assert.equal(first.status, 200); assert.equal(first.json.needs2fa, true); assert.equal(first.setCookie, null, 'no session before the code');
  assert.equal((await call('POST', '/api/login', { username: 'admin', password: 'adminpassword1', code: '123456' }, nc)).status, 401);
  // the enrolment code was already used, so a fresh login needs the NEXT step: advance the stored step via a legit drift code
  const now = Date.now();
  const next = totp.verify(secret, totp.code(secret, now + 30000), { now: now + 30000, after: app.auth.users[0].totp.lastStep });
  assert.ok(next, 'a code from the next time step exists');
  const ok = await call('POST', '/api/login', { username: 'admin', password: 'adminpassword1', code: totp.code(secret, now + 30000) }, nc);
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.ok(ok.setCookie);
  const again = await call('POST', '/api/login', { username: 'admin', password: 'adminpassword1', code: totp.code(secret, now + 30000) }, nc);
  assert.equal(again.status, 401, 'the same code cannot be used twice');
  // recovery code works once
  const rc = en.json.recovery[3];
  assert.equal((await call('POST', '/api/login', { username: 'admin', password: 'adminpassword1', code: rc }, nc)).status, 200);
  assert.equal((await call('POST', '/api/login', { username: 'admin', password: 'adminpassword1', code: rc }, nc)).status, 401, 'recovery code is single use');
  // wrong password never reveals whether 2FA is on
  const bad = await call('POST', '/api/login', { username: 'admin', password: 'nope-nope-nope' }, nc);
  assert.equal(bad.status, 401); assert.notEqual(bad.json && bad.json.needs2fa, true);
});

test('turning it off needs the password and a code; an admin can reset someone else', async () => {
  const u = app.auth.users[0]; const secret = app.auth.vault.decrypt(u.totp.secretEnc);
  assert.equal((await call('POST', '/api/account/2fa/disable', { password: 'adminpassword1', code: '111111' })).status, 403);
  assert.equal((await call('POST', '/api/account/2fa/disable', { password: 'wrong', code: u.totp ? '1' : '' })).status, 403);
  const mk = await call('POST', '/api/users', { username: 'bob', password: 'bobspassword1', role: 'viewer' });
  assert.equal(mk.status, 200);
  const bob = app.auth.users.find((x) => x.username === 'bob');
  const bc = (await call('POST', '/api/login', { username: 'bob', password: 'bobspassword1' }, { cookieOverride: '' })).setCookie.split(';')[0];
  const s2 = await call('POST', '/api/account/2fa/start', { password: 'bobspassword1' }, { cookieOverride: bc });
  assert.equal((await call('POST', '/api/account/2fa/enable', { code: totp.code(s2.json.secret) }, { cookieOverride: bc })).status, 200);
  assert.equal((await call('GET', '/api/users')).json.users.find((x) => x.username === 'bob').totp, true);
  assert.equal((await call('POST', '/api/users/2fa/reset', { id: bob.id })).status, 200);
  assert.equal(app.auth.users.find((x) => x.username === 'bob').totp, undefined);
  assert.equal((await call('GET', '/api/session', undefined, { cookieOverride: bc })).json.user, null, 'their sessions were ended');
  assert.ok((await call('POST', '/api/login', { username: 'bob', password: 'bobspassword1' }, { cookieOverride: '' })).setCookie, 'password alone works again');
  void secret;
});
