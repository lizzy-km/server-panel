'use strict';
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const hasBin = (b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
const SFTP_SERVER = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find((p) => fs.existsSync(p));
const canSshd = () => hasBin('sshd') && hasBin('ssh-keygen') && !!SFTP_SERVER && fs.existsSync('/usr/sbin/sshd');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function genKey(dir, name, type = 'ed25519', { pass = '', pem = false, bits } = {}) {
  const file = path.join(dir, name);
  const args = ['-q', '-t', type, '-N', pass, '-f', file, '-C', name];
  if (pem) args.push('-m', 'PEM');
  if (bits) args.push('-b', String(bits));
  execFileSync('ssh-keygen', args);
  return { file, text: fs.readFileSync(file, 'utf8'), pub: fs.readFileSync(file + '.pub', 'utf8'), fp: execFileSync('ssh-keygen', ['-lf', file + '.pub']).toString().split(' ')[1] };
}

function toPpk(dir, key, version = 3, pass = '') {
  const out = key.file + `.v${version}.ppk`;
  const args = [key.file, '-o', out, '-O', 'private', '--ppk-param', `version=${version}`];
  if (pass) {
    const pf = path.join(dir, 'pp.txt');
    fs.writeFileSync(pf, pass + '\n');
    args.push('--new-passphrase', pf);
  }
  execFileSync('puttygen', args);
  return fs.readFileSync(out, 'utf8');
}

async function waitPort(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sshd did not start');
}

/** Start a throw-away sshd for the current user on a random loopback port. */
async function startSshd({ authorizedKeys, env = {} }) {
  const dir = tmp('sshd-');
  const hostKey = genKey(dir, 'host_ed25519');
  const port = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(dir, 'authorized_keys'), authorizedKeys.join('\n') + '\n');
  // sshd reads authorized_keys as the user who logs in, so non-root test users need to be able to read it
  fs.chmodSync(dir, 0o755); fs.chmodSync(path.join(dir, 'authorized_keys'), 0o644);
  fs.writeFileSync(path.join(dir, 'sshd_config'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey.file}`, `PidFile ${dir}/sshd.pid`,
    `AuthorizedKeysFile ${dir}/authorized_keys`, 'PermitRootLogin yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes', 'UsePAM no', 'StrictModes no', `Subsystem sftp ${SFTP_SERVER}`, 'LogLevel ERROR',
    ...(Object.keys(env).length ? [`SetEnv ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`] : []),
  ].join('\n') + '\n');
  fs.mkdirSync('/run/sshd', { recursive: true });
  const child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: 'ignore' });
  await waitPort(port);
  return { port, hostKeyFp: hostKey.fp, pid: child.pid, dir, stop() { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); } };
}

module.exports = { hasBin, canSshd, tmp, genKey, toPpk, startSshd, os };

// ---------------------------------------------------------------------------------------------
// Fake systemd / journald / certbot (test/shims/) for end-to-end deploy + domain tests.
// Everything else (git, npm, node, curl, nginx -t, openssl, bash) is the real thing.
// ---------------------------------------------------------------------------------------------

/**
 * Builds a throw-away "managed server": real sshd + shim systemctl/journalctl/certbot + temp dirs.
 * Returns the panel config overrides that point the panel at those dirs.
 */
async function makeTarget() {
  const dir = tmp('target-');
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  const dirs = {
    apps: path.join(dir, 'apps'), units: path.join(dir, 'units'), conf: path.join(dir, 'nginx/conf.d'), logs: path.join(dir, 'nginx/logs'),
    le: path.join(dir, 'letsencrypt'), acme: path.join(dir, 'acme'), tmp: path.join(dir, 'nginx/tmp'),
  };
  for (const d of [bin, state, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });
  for (const name of ['systemctl', 'journalctl', 'certbot', 'aws']) fs.copyFileSync(path.join(__dirname, 'shims', name), path.join(bin, name)), fs.chmodSync(path.join(bin, name), 0o755);
  const nginxConf = path.join(dir, 'nginx/nginx.conf');
  fs.writeFileSync(nginxConf, `pid ${dir}/nginx/nginx.pid;\nerror_log ${dirs.logs}/error.log;\nevents { worker_connections 16; }\nhttp {\n  access_log off;\n  client_body_temp_path ${dirs.tmp}/b; proxy_temp_path ${dirs.tmp}/p; fastcgi_temp_path ${dirs.tmp}/f; uwsgi_temp_path ${dirs.tmp}/u; scgi_temp_path ${dirs.tmp}/s;\n  include ${dirs.conf}/*.conf;\n}\n`);
  // `include fastcgi_params;` is resolved relative to the test nginx.conf
  for (const f of ['fastcgi_params', 'mime.types']) { try { fs.copyFileSync(`/etc/nginx/${f}`, path.join(dir, 'nginx', f)); } catch { /* not installed */ } }
  const key = genKey(dir, 'id_ed25519');
  const sshd = await startSshd({
    authorizedKeys: [key.pub],
    env: { PATH: `${bin}:${process.env.PATH}:/usr/sbin:/sbin`, SHIM_STATE: state, SHIM_UNIT_DIR: dirs.units },
  });
  const overrides = {
    appsBaseDir: dirs.apps, unitDir: dirs.units, nginxConfDir: dirs.conf, nginxLogDir: dirs.logs, nginxConf,
    letsencryptDir: dirs.le, acmeRoot: dirs.acme, allowLocalRepos: true, phpSocket: `unix:${dir}/php-fpm.sock`,
    exportDir: path.join(dir, 'exports'), backupRoot: path.join(dir, 'backups'), backupScriptDir: path.join(dir, 'backup-scripts'),
  };
  return { dir, dirs, state, key, sshd, overrides, stop() { sshd.stop(); try { for (const f of fs.readdirSync(state)) if (f.endsWith('.pid')) { try { process.kill(Number(fs.readFileSync(path.join(state, f), 'utf8')), 'SIGKILL'); } catch { /* gone */ } } } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); } };
}

module.exports.makeTarget = makeTarget;
module.exports.canTarget = () => canSshd() && process.getuid && process.getuid() === 0 && hasBin('git') && hasBin('curl') && hasBin('openssl');

// ---------------------------------------------------------------------------------------------
// A running panel + one managed (fake-systemd) server, driven through the real HTTP API.
// ---------------------------------------------------------------------------------------------

const GLOBAL = /^\/api\/(session|setup|login|logout|account|users|audit|servers|alerts\/thresholds|hooks|jobs)/;

async function makeStack(opts = {}) {
  const { createApp } = require('../server/index');
  const target = await makeTarget();
  // optionally connect as a normal (non-root) user, like ec2-user: root hides every permission problem
  if (opts.sshUser) {
    fs.chmodSync(target.dir, 0o755);
    require('child_process').execFileSync('chown', ['-R', opts.sshUser, target.dirs.apps]);
  }
  const dataDir = tmp('stack-data-');
  const app = createApp({ dataDir, port: 0, host: '127.0.0.1', enableLocal: false, ...target.overrides });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const stack = { target, app, base, dataDir, cookie: '', serverId: null };

  stack.call = async (method, url, body, { server, cookieOverride, headers = {} } = {}) => {
    const sid = server === undefined ? stack.serverId : server;
    const u = GLOBAL.test(url) || !sid ? url : url + (url.includes('?') ? '&' : '?') + 'server=' + sid;
    const send = () => fetch(base + u, {
      method,
      headers: { 'X-Panel-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookieOverride ?? stack.cookie, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // a keep-alive socket the server already closed after 5 idle seconds fails with ECONNRESET before anything is sent: retry once
    const res = await send().catch((e) => { if (e && e.cause && e.cause.code === 'ECONNRESET') return send(); throw e; });
    let json = null; try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie'), raw: JSON.stringify(json) };
  };

  try {
  const setup = await stack.call('POST', '/api/setup', { username: 'admin', password: 'longenoughpass', setupToken: app.auth.setupToken });
  stack.cookie = setup.setCookie.split(';')[0];
  const add = await stack.call('POST', '/api/servers', {
    name: 'stack-server', host: '127.0.0.1', port: target.sshd.port, username: opts.sshUser || os.userInfo().username,
    privateKey: target.key.text, hostKey: target.sshd.hostKeyFp, fileRoot: target.dir,
  });
  if (add.status !== 200) throw new Error('could not add stack server: ' + add.raw);
  stack.serverId = add.json.server.id;
  } catch (e) { app.servers.closeAll(); app.server.close(); target.stop(); throw e; }

  stack.loginViewer = async () => {
    await stack.call('POST', '/api/users', { username: 'viewer1', password: 'viewerpassword1', role: 'viewer' });
    const l = await stack.call('POST', '/api/login', { username: 'viewer1', password: 'viewerpassword1' }, { cookieOverride: '' });
    return l.setCookie.split(';')[0];
  };
  stack.stop = () => { app.servers.closeAll(); app.server.close(); target.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return stack;
}

/** Wait until a deploy/rollback record leaves the "running" state; returns {deploy, log}. */
async function waitDeploy(stack, id, ms = 90000) {
  const end = Date.now() + ms;
  let offset = 0; let log = '';
  while (Date.now() < end) {
    const r = await stack.call('GET', `/api/deploys/log?id=${id}&offset=${offset}`);
    if (r.status !== 200) throw new Error('log poll failed: ' + r.raw);
    log += r.json.text; offset = r.json.offset;
    if (r.json.deploy.status !== 'running' && r.json.done) return { deploy: r.json.deploy, log };
    await new Promise((x) => setTimeout(x, 250));
  }
  throw new Error('deploy did not finish in time:\n' + log);
}

/** A tiny git repo containing a Node http server whose response shows its version. */
function makeRepo(dir) {
  const { execFileSync } = require('child_process');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  fs.mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'testapp', version: '1.0.0', scripts: { start: 'node server.js' } }));
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "const http = require('http');",
    "if (require('./version.json').broken) { console.error('boot failure'); process.exit(1); }",
    "const v = require('./version.json').v;",
    "http.createServer((q, r) => { if (q.url === '/env') return r.end(process.env.GREETING || ''); r.end('hello ' + v); }).listen(process.env.PORT, '127.0.0.1');",
  ].join('\n'));
  const commit = (v, opts = {}) => {
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ v, ...opts }));
    git('add', '-A'); git('commit', '-q', '-m', `version ${v}`);
    return git('rev-parse', 'HEAD');
  };
  return { dir, commit, git };
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const get = async (port, p = '/') => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`); return r.status === 200 ? await r.text() : `HTTP ${r.status}`; } catch { return null; } };

Object.assign(module.exports, { makeStack, waitDeploy, makeRepo, freePort, get });
