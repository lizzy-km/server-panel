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
async function startSshd({ authorizedKeys }) {
  const dir = tmp('sshd-');
  const hostKey = genKey(dir, 'host_ed25519');
  const port = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(dir, 'authorized_keys'), authorizedKeys.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'sshd_config'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey.file}`, `PidFile ${dir}/sshd.pid`,
    `AuthorizedKeysFile ${dir}/authorized_keys`, 'PermitRootLogin yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes', 'UsePAM no', 'StrictModes no', `Subsystem sftp ${SFTP_SERVER}`, 'LogLevel ERROR',
  ].join('\n') + '\n');
  fs.mkdirSync('/run/sshd', { recursive: true });
  const child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: 'ignore' });
  await waitPort(port);
  return { port, hostKeyFp: hostKey.fp, pid: child.pid, dir, stop() { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); } };
}

module.exports = { hasBin, canSshd, tmp, genKey, toPpk, startSshd, os };
