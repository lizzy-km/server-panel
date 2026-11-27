'use strict';
/** Security tools against a real sshd with fake sshd -T/-t, firewall-cmd, fail2ban-client, dnf and systemd. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { canTarget, makeStack } = require('./helpers');

const skip = !canTarget();
let st; let S; let state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (m, p, b) => st.call(m, p, b);
const rd = (f) => { try { return fs.readFileSync(path.join(state, f), 'utf8'); } catch { return ''; } };

before(async () => {
  if (skip) return;
  st = await makeStack(); state = st.target.state; S = st.target;
  // the test user's authorized_keys (what makes password login safe to turn off)
  fs.mkdirSync('/root/.ssh', { recursive: true, mode: 0o700 });
});
after(() => { if (!skip) st.stop(); });

const check = (s, id) => s.checks.find((c) => c.id === id);

test('the security check reads SSH, firewall, fail2ban and update state', { skip }, async () => {
  const r = await api('GET', '/api/security');
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.ssh.known, true);
  assert.equal(r.json.ssh.permitRootLogin, 'yes'); assert.equal(r.json.ssh.passwordAuth, 'yes');
  assert.equal(check(r.json, 'ssh-root').status, 'bad'); assert.equal(check(r.json, 'ssh-root').fix, 'ssh-root');
  assert.equal(check(r.json, 'ssh-password').status, 'warn');
  assert.equal(r.json.firewall.installed, false);
  assert.equal(check(r.json, 'firewall').fix, 'firewall');
  assert.equal(check(r.json, 'fail2ban').status, 'warn');
  assert.equal(check(r.json, 'auto-updates').status, 'warn');
});

test('SSH hardening: guards stop lock-outs, valid changes apply, bad config is rolled back', { skip }, async () => {
  // the panel connects as root here, so disabling root login is refused
  const root = await api('POST', '/api/security/ssh', { permitRootLogin: 'no' });
  assert.equal(root.status, 400); assert.match(root.json.error, /connects as root/);
  assert.equal((await api('POST', '/api/security/ssh', { permitRootLogin: 'maybe' })).status, 400);
  // password auth off needs a key for the connected user
  const authKeys = '/root/.ssh/authorized_keys'; const had = fs.existsSync(authKeys) ? fs.readFileSync(authKeys) : null;
  fs.rmSync(authKeys, { force: true });
  const nokey = await api('POST', '/api/security/ssh', { passwordAuth: 'no' });
  assert.equal(nokey.status, 400); assert.match(nokey.json.error, /no key in/);
  assert.equal(fs.existsSync(path.join(state, 'sshd.d/00-panel-hardening.conf')), false, 'nothing written');
  fs.writeFileSync(authKeys, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample test@test\n', { mode: 0o600 });
  try {
    const ok = await api('POST', '/api/security/ssh', { passwordAuth: 'no' });
    assert.equal(ok.status, 200, ok.raw);
    assert.match(rd('sshd.d/00-panel-hardening.conf'), /^PasswordAuthentication no$/m);
    assert.match(rd('sshd.reloads'), /reload sshd/);
    assert.equal((await api('GET', '/api/security')).json.ssh.passwordAuth, 'no');
    await sleep(4500); // the server-side safety timer fired: it was confirmed, so nothing is undone
    assert.match(rd('sshd.d/00-panel-hardening.conf'), /PasswordAuthentication no/, 'a confirmed change stays');
    // "default" removes the line (and the file when nothing is left)
    assert.equal((await api('POST', '/api/security/ssh', { passwordAuth: 'default' })).status, 200);
    assert.equal(fs.existsSync(path.join(state, 'sshd.d/00-panel-hardening.conf')), false);
    // another config file that wins makes the change impossible: it is rolled back with an explanation
    fs.writeFileSync(path.join(state, 'sshd.force'), 'passwordauthentication yes\n');
    const forced = await api('POST', '/api/security/ssh', { passwordAuth: 'no' });
    assert.equal(forced.status, 400); assert.match(forced.json.error, /overridden by another SSH config file/);
    assert.equal(fs.existsSync(path.join(state, 'sshd.d/00-panel-hardening.conf')), false, 'rolled back');
    fs.rmSync(path.join(state, 'sshd.force'));
    // an invalid configuration is rejected by sshd -t and restored
    fs.mkdirSync(path.join(state, 'sshd.d'), { recursive: true }); fs.writeFileSync(path.join(state, 'sshd.d/10-other.conf'), 'Bogus yes\n');
    const bad = await api('POST', '/api/security/ssh', { passwordAuth: 'no' });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /NOT changed/);
    assert.equal(fs.existsSync(path.join(state, 'sshd.d/00-panel-hardening.conf')), false);
    fs.rmSync(path.join(state, 'sshd.d/10-other.conf'));
  } finally { if (had) fs.writeFileSync(authKeys, had); else fs.rmSync(authKeys, { force: true }); fs.rmSync(path.join(state, 'sshd.force'), { force: true }); }
});

test('SSH hardening undoes itself on the server when the panel never confirms', { skip }, async () => {
  const { SecurityManager } = require('../server/lib/security');
  const authKeys = '/root/.ssh/authorized_keys'; const had = fs.existsSync(authKeys) ? fs.readFileSync(authKeys) : null;
  fs.writeFileSync(authKeys, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample test@test\n', { mode: 0o600 });
  try {
    // simulate "the new connection failed": make the confirmation step fail by removing the ability to touch the file
    const sm = st.app.security || new SecurityManager({ servers: st.app.servers, config: st.app.config });
    const host = st.app.servers.entry(st.serverId).host;
    const origRunPriv = host.runPriv.bind(host);
    host.runPriv = async (cmd, args, o) => (cmd === 'touch' ? { ok: false, stdout: '', stderr: 'no' } : origRunPriv(cmd, args, o));
    const r = await api('POST', '/api/security/ssh', { passwordAuth: 'no' });
    host.runPriv = origRunPriv;
    assert.equal(r.status, 502, r.raw); assert.match(r.json.error, /undo the change by itself/);
    assert.match(rd('sshd.d/00-panel-hardening.conf'), /PasswordAuthentication no/, 'applied for now');
    await sleep(5000);
    assert.equal(fs.existsSync(path.join(state, 'sshd.d/00-panel-hardening.conf')), false, 'the server reverted it by itself');
    assert.ok((rd('sshd.reloads').match(/reload sshd/g) || []).length >= 2, 'and reloaded sshd');
    void sm;
  } finally { if (had) fs.writeFileSync(authKeys, had); else fs.rmSync(authKeys, { force: true }); }
});

test('firewall: installing opens SSH first, ports can be opened and closed, SSH cannot be closed', { skip }, async () => {
  assert.equal((await api('POST', '/api/security/firewall', { action: 'enable' })).status, 200);
  assert.match(rd('dnf.log'), /install firewalld/);
  const ports = rd('fw/ports').split('\n').filter(Boolean);
  assert.ok(ports.includes('22/tcp'), 'ssh port opened'); assert.ok(ports.includes(`${S.sshd.port}/tcp`), 'the panel connection port is opened too');
  assert.match(rd('fw/services'), /http/);
  const s = (await api('GET', '/api/security')).json;
  assert.equal(s.firewall.running, true); assert.ok(s.firewall.ports.includes('22/tcp')); assert.equal(check(s, 'firewall').status, 'ok');
  assert.equal((await api('POST', '/api/security/firewall', { action: 'open', port: 8443, proto: 'tcp' })).status, 200);
  assert.ok(rd('fw/ports').includes('8443/tcp'));
  assert.equal((await api('POST', '/api/security/firewall', { action: 'open', service: 'https' })).status, 200);
  assert.equal((await api('POST', '/api/security/firewall', { action: 'close', port: 8443 })).status, 200);
  assert.ok(!rd('fw/ports').includes('8443/tcp'));
  for (const body of [{ action: 'close', port: 22 }, { action: 'close', port: S.sshd.port }, { action: 'close', service: 'ssh' }]) {
    const r = await api('POST', '/api/security/firewall', body);
    assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.json.error, /lock you out|cannot be closed/);
  }
  assert.ok(rd('fw/ports').includes('22/tcp'));
  for (const bad of [{ action: 'open', port: 70000 }, { action: 'open', port: 80, proto: 'icmp' }, { action: 'open', service: 'telnet' }, { action: 'nuke' }]) assert.equal((await api('POST', '/api/security/firewall', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await api('POST', '/api/security/firewall', { action: 'disable' })).status, 200);
  assert.equal((await api('GET', '/api/security')).json.firewall.running, false);
});

test('fail2ban: install, jail with the panel whitelisted, unban, and a clear message when the package is missing', { skip }, async () => {
  fs.writeFileSync(path.join(state, 'dnf.unavailable'), '');
  const miss = await api('POST', '/api/security/fail2ban', { action: 'enable' });
  assert.equal(miss.status, 400); assert.match(miss.json.error, /not available in this server's package repositories/);
  fs.rmSync(path.join(state, 'dnf.unavailable'));
  assert.equal((await api('POST', '/api/security/fail2ban', { action: 'enable', maxRetry: 3, banMinutes: 120 })).status, 200);
  const jail = rd('jail.d/panel.local');
  assert.match(jail, /\[sshd\]/); assert.match(jail, /enabled = true/); assert.match(jail, /maxretry = 3/); assert.match(jail, /bantime = 120m/);
  assert.match(jail, /ignoreip = 127\.0\.0\.1\/8 ::1 127\.0\.0\.1/, 'the panel address is never banned');
  fs.writeFileSync(path.join(state, 'f2b.banned'), '203.0.113.7\n198.51.100.9\n');
  const s = (await api('GET', '/api/security')).json;
  assert.equal(s.fail2ban.active, true); assert.deepEqual(s.fail2ban.banned, ['203.0.113.7', '198.51.100.9']);
  assert.equal(check(s, 'fail2ban').status, 'ok');
  assert.equal((await api('POST', '/api/security/fail2ban', { action: 'unban', ip: '203.0.113.7' })).status, 200);
  assert.deepEqual((await api('GET', '/api/security')).json.fail2ban.banned, ['198.51.100.9']);
  assert.equal((await api('POST', '/api/security/fail2ban', { action: 'unban', ip: 'x; rm -rf /' })).status, 400);
  assert.equal((await api('POST', '/api/security/fail2ban', { action: 'enable', maxRetry: 1 })).status, 400);
});

test('automatic security updates: enable and disable', { skip }, async () => {
  assert.equal((await api('POST', '/api/security/auto-updates', { action: 'enable' })).status, 200);
  assert.match(rd('automatic.conf'), /upgrade_type = security/); assert.match(rd('automatic.conf'), /apply_updates = yes/);
  let s = (await api('GET', '/api/security')).json;
  assert.equal(s.autoUpdates.enabled, true); assert.equal(check(s, 'auto-updates').status, 'ok');
  assert.equal((await api('POST', '/api/security/auto-updates', { action: 'disable' })).status, 200);
  assert.equal((await api('GET', '/api/security')).json.autoUpdates.enabled, false);
  assert.equal((await api('POST', '/api/security/auto-updates', { action: 'enable', type: 'evil' })).status, 400);
});

test('only admins can use the security tools', { skip }, async () => {
  const mk = await api('POST', '/api/users', { username: 'viewer1', password: 'viewerpassword1', role: 'viewer' });
  assert.equal(mk.status, 200);
  const login = await fetch(`${st.base}/api/login`, { method: 'POST', headers: { 'X-Panel-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'viewer1', password: 'viewerpassword1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const [m, p] of [['GET', '/api/security'], ['POST', '/api/security/firewall'], ['POST', '/api/security/ssh']]) {
    const r = await fetch(`${st.base}${p}?server=${st.serverId}`, { method: m, headers: { 'X-Panel-Request': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: m === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 403, p);
  }
});
