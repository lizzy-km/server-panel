'use strict';
/**
 * Host abstraction: everything the panel does to a machine goes through one of these.
 *   LocalHost - the machine the panel runs on
 *   SshHost   - a remote machine over SSH (exec + SFTP), host key pinned by SHA-256 fingerprint
 *
 * Common interface:
 *   run(cmd, args, {timeout, stdin, maxBuffer})  -> {ok, code, missing, timedOut, stdout, stderr}   (no shell on the target side of args: they are quoted)
 *   runPriv(...)                                  -> same, via `sudo -n` when not root (falls back to direct)
 *   runShell(command, {timeoutMs, cwd})           -> {output, code, signal, ms, timedOut, truncated}
 *   fs                                            -> readdir/stat/lstat/realpath/readFile/writeFile/mkdir/rename/rm/chmod/createReadStream/createWriteStream
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Client } = require('ssh2');
const { httpError } = require('./auth');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const buildCommand = (cmd, args) => `env LC_ALL=C ${[cmd, ...args].map(shq).join(' ')}`;

/** OpenSSH-style fingerprint of a raw public key blob: "SHA256:base64-without-padding". */
function fingerprint(blob) {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

function friendlySshError(err) {
  const m = String((err && err.message) || err);
  if (/All configured authentication methods failed/i.test(m)) return 'Authentication failed — check the username and that this is the key pair the server was launched with';
  if (/Host denied|verification failed/i.test(m)) return 'Host key does not match the pinned fingerprint (the server was rebuilt, or this is not the expected machine)';
  if (/ECONNREFUSED/.test(m)) return 'Connection refused (is SSH running, and is the port right?)';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Host name could not be resolved';
  if (/ETIMEDOUT|timed out|Timed out/i.test(m)) return 'Connection timed out (check the address and the security group / firewall for port 22)';
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return 'Host is unreachable from the panel';
  if (/ECONNRESET/.test(m)) return 'Connection was reset by the server';
  return m;
}

class BaseHost {
  async runPriv(cmd, args = [], opts = {}) {
    if (!this.useSudo) return this.run(cmd, args, opts);
    const r = await this.run('sudo', ['-n', cmd, ...args], opts);
    if (r.ok || !(r.missing || /^sudo: /m.test(r.stderr))) return r;
    return this.run(cmd, args, opts);
  }
}

// ---------------------------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------------------------

const localFs = {
  async readdir(dir) {
    const names = await fsp.readdir(dir);
    const out = await Promise.all(names.map(async (name) => {
      try {
        const s = await fsp.lstat(path.join(dir, name));
        return { name, type: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs, mode: (s.mode & 0o777).toString(8) };
      } catch { return null; }
    }));
    return out.filter(Boolean);
  },
  async stat(p) { const s = await fsp.stat(p); return { type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', size: s.size }; },
  async realpath(p) { return fsp.realpath(p); },
  async readFile(p) { return fsp.readFile(p); },
  async writeFile(p, data) { return fsp.writeFile(p, data); },
  async mkdir(p) { return fsp.mkdir(p); },
  async rename(a, b) { return fsp.rename(a, b); },
  async rm(p) { return fsp.rm(p, { recursive: true }); },
  async chmod(p, mode) { return fsp.chmod(p, mode); },
  createReadStream: (p) => fs.createReadStream(p),
  writeFrom: (p, readable) => pipeline(readable, fs.createWriteStream(p)),
};

class LocalHost extends BaseHost {
  constructor() {
    super();
    this.id = 'local';
    this.kind = 'local';
    this.name = 'This panel host';
    this.useSudo = typeof process.getuid === 'function' && process.getuid() !== 0 && process.env.PANEL_USE_SUDO !== 'false';
    this.fs = localFs;
  }

  async connect() { return this; }
  close() {}
  describe() { return { status: 'local', lastError: null }; }

  run(cmd, args = [], opts = {}) {
    return new Promise((resolve) => {
      const child = execFile(cmd, args, {
        timeout: opts.timeout ?? 10000,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          missing: !!err && err.code === 'ENOENT',
          timedOut: !!err && err.killed === true,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && err.code === 'ENOENT' ? `${cmd}: not found` : '')),
        });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin !== undefined ? opts.stdin : undefined);
    });
  }

  /** Long-running command with live output (deploys, installs). stdin may carry a script for `bash -s`. */
  stream(command, { stdin, timeout = 30 * 60 * 1000, onData } = {}) {
    return new Promise((resolve) => {
      const p = spawn('sh', ['-c', command], { env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeout);
      p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
      p.stdout.on('data', (d) => onData && onData(d));
      p.stderr.on('data', (d) => onData && onData(d));
      p.stdin.on('error', () => {});
      p.stdin.end(stdin !== undefined ? stdin : undefined);
      p.on('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, timedOut: false, error: e.message }); });
      p.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }); });
    });
  }

  runShell(command, { timeoutMs = 30000, cwd } = {}) {
    const limit = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);
    return new Promise((resolve) => {
      const started = Date.now();
      const p = spawn('bash', ['-c', command], { cwd, env: { ...process.env, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let truncated = false; let timedOut = false;
      const take = (d) => { if (out.length < 512 * 1024) out += d; else truncated = true; };
      p.stdout.on('data', take); p.stderr.on('data', take);
      const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, limit);
      p.on('error', (e) => { clearTimeout(timer); resolve({ output: e.message, code: null, ms: 0, timedOut: false, truncated: false }); });
      p.on('close', (code, signal) => { clearTimeout(timer); resolve({ output: out, code, signal, ms: Date.now() - started, timedOut, truncated }); });
    });
  }
}

// ---------------------------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------------------------

const sftpError = (err) => {
  const e = new Error(err && err.message ? err.message : 'SFTP error');
  // SFTP status codes: 2 no such file, 3 permission denied
  e.code = err && err.code === 2 ? 'ENOENT' : err && err.code === 3 ? 'EACCES' : (err && err.code) || 'EIO';
  return e;
};

class SshHost extends BaseHost {
  /**
   * @param {object} rec    {id, name, host, port, username, hostKey, useSudo}
   * @param {object} creds  {privateKey, passphrase}  (already normalised for ssh2)
   */
  constructor(rec, creds) {
    super();
    this.id = rec.id;
    this.kind = 'ssh';
    this.name = rec.name;
    this.address = rec.host;
    this.port = rec.port || 22;
    this.username = rec.username;
    this.pinned = rec.hostKey;
    this.useSudo = rec.useSudo !== false && rec.username !== 'root';
    this.creds = creds;
    this.conn = null;
    this.ready = false;
    this.connecting = null;
    this.sftpSession = null;
    this.lastError = null;
    this.lastUsed = Date.now();
    this.active = 0;
    this.queue = [];
    this.fs = this.makeFs();
    this.reaper = setInterval(() => {
      if (this.ready && this.active === 0 && Date.now() - this.lastUsed > 10 * 60 * 1000) this.disconnect();
    }, 60 * 1000);
    this.reaper.unref();
  }

  describe() { return { status: this.ready ? 'connected' : this.lastError ? 'error' : 'idle', lastError: this.lastError }; }

  connect() {
    if (this.ready && this.conn) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.lastError = friendlySshError(err);
        this.ready = false;
        try { conn.destroy(); } catch { /* ignore */ }
        reject(httpError(502, `SSH to ${this.name}: ${this.lastError}`));
      };
      conn.on('ready', () => {
        if (settled) return;
        settled = true;
        this.conn = conn; this.ready = true; this.lastError = null;
        resolve(conn);
      });
      conn.on('error', fail);
      conn.on('close', () => { this.ready = false; this.conn = null; this.sftpSession = null; if (!settled) fail(new Error('Connection closed')); });
      conn.connect({
        host: this.address, port: this.port, username: this.username,
        privateKey: this.creds.privateKey, passphrase: this.creds.passphrase,
        readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        hostVerifier: (key) => fingerprint(key) === this.pinned,
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  disconnect() {
    if (this.conn) { try { this.conn.end(); } catch { /* ignore */ } }
    this.conn = null; this.ready = false; this.sftpSession = null;
  }

  close() { clearInterval(this.reaper); this.disconnect(); }

  // limit concurrent channels (sshd defaults to MaxSessions 10)
  async slot(fn) {
    if (this.active >= 6) await new Promise((r) => this.queue.push(r));
    this.active += 1;
    this.lastUsed = Date.now();
    try { return await fn(); } finally {
      this.active -= 1;
      this.lastUsed = Date.now();
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /** Execute a raw command string on the remote. */
  exec(command, { timeout = 10000, stdin, maxBuffer = 8 * 1024 * 1024 } = {}) {
    return this.slot(async () => {
      const conn = await this.connect();
      return new Promise((resolve) => {
        conn.exec(command, (err, stream) => {
          if (err) { resolve({ ok: false, code: null, missing: false, timedOut: false, stdout: '', stderr: err.message }); return; }
          let stdout = ''; let stderr = ''; let timedOut = false;
          stream.setEncoding('utf8'); stream.stderr.setEncoding('utf8');
          const timer = setTimeout(() => { timedOut = true; try { stream.close(); } catch { /* ignore */ } }, timeout);
          stream.on('data', (d) => { if (stdout.length < maxBuffer) stdout += d; });
          stream.stderr.on('data', (d) => { if (stderr.length < maxBuffer) stderr += d; });
          stream.on('close', (code, signal) => {
            clearTimeout(timer);
            const c = typeof code === 'number' ? code : null;
            resolve({ ok: c === 0, code: c, signal: signal || null, missing: c === 127, timedOut, stdout, stderr: stderr || (c === 127 ? 'command not found' : '') });
          });
          stream.on('error', () => {});
          if (stdin !== undefined) stream.end(stdin); else stream.end();
        });
      });
    });
  }

  run(cmd, args = [], opts = {}) { return this.exec(buildCommand(cmd, args), opts); }

  /** Long-running command with live output (deploys, installs). stdin may carry a script for `bash -s`. */
  stream(command, { stdin, timeout = 30 * 60 * 1000, onData } = {}) {
    return this.slot(async () => {
      const conn = await this.connect();
      return new Promise((resolve) => {
        conn.exec(command, (err, stream) => {
          if (err) { resolve({ code: null, signal: null, timedOut: false, error: err.message }); return; }
          let timedOut = false;
          const timer = setTimeout(() => { timedOut = true; try { stream.close(); } catch { /* ignore */ } }, timeout);
          stream.setEncoding('utf8'); stream.stderr.setEncoding('utf8');
          stream.on('data', (d) => onData && onData(d));
          stream.stderr.on('data', (d) => onData && onData(d));
          stream.on('error', () => {});
          stream.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: typeof code === 'number' ? code : null, signal: signal || null, timedOut }); });
          if (stdin !== undefined) stream.end(stdin); else stream.end();
        });
      });
    });
  }

  async runShell(command, { timeoutMs = 30000, cwd } = {}) {
    const limit = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);
    const started = Date.now();
    // `timeout` kills the remote process tree on expiry; the client-side deadline is a backstop.
    const inner = `${cwd ? `cd ${shq(cwd)} 2>/dev/null; ` : ''}exec bash -c ${shq(command)} 2>&1`;
    const r = await this.exec(`TERM=dumb timeout -s KILL ${Math.ceil(limit / 1000)} bash -c ${shq(inner)}`, { timeout: limit + 5000, maxBuffer: 512 * 1024 });
    const timedOut = r.timedOut || r.code === 137 || r.code === 124 || /KILL/.test(r.signal || '');
    return { output: r.stdout + (r.stdout ? '' : r.stderr), code: timedOut ? null : r.code, signal: timedOut ? 'SIGKILL' : null, ms: Date.now() - started, timedOut, truncated: r.stdout.length >= 512 * 1024 };
  }

  async sftp() {
    if (this.sftpSession) return this.sftpSession;
    const conn = await this.connect();
    this.sftpSession = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => {
        if (err) return reject(httpError(502, `SFTP unavailable on ${this.name}: ${err.message}`));
        s.on('close', () => { if (this.sftpSession === s) this.sftpSession = null; });
        s.on('error', () => { if (this.sftpSession === s) this.sftpSession = null; });
        resolve(s);
      });
    });
    return this.sftpSession;
  }

  makeFs() {
    const self = this;
    const call = async (fn) => {
      const s = await self.sftp();
      self.lastUsed = Date.now();
      return new Promise((resolve, reject) => fn(s, (err, v) => (err ? reject(sftpError(err)) : resolve(v))));
    };
    const kind = (st) => (st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other');
    return {
      async readdir(dir) {
        const list = await call((s, cb) => s.readdir(dir, cb));
        return list.filter((e) => e.filename !== '.' && e.filename !== '..').map((e) => ({
          name: e.filename, type: kind(e.attrs) === 'other' ? 'file' : kind(e.attrs), size: e.attrs.size,
          mtime: e.attrs.mtime * 1000, mode: (e.attrs.mode & 0o777).toString(8),
        }));
      },
      async stat(p) { const st = await call((s, cb) => s.stat(p, cb)); return { type: kind(st), size: st.size }; },
      async realpath(p) { return call((s, cb) => s.realpath(p, cb)); },
      async readFile(p) { return call((s, cb) => s.readFile(p, cb)); },
      async writeFile(p, data) { return call((s, cb) => s.writeFile(p, data, cb)); },
      async mkdir(p) { return call((s, cb) => s.mkdir(p, cb)); },
      async rename(a, b) {
        // posix-rename overwrites like rename(2); plain SFTP rename refuses to replace an existing target
        const s = await self.sftp();
        if (typeof s.ext_openssh_rename === 'function') {
          try { return await new Promise((resolve, reject) => s.ext_openssh_rename(a, b, (e) => (e ? reject(e) : resolve()))); } catch { /* fall back */ }
        }
        return call((x, cb) => x.rename(a, b, cb));
      },
      async rm(p) {
        const r = await self.run('rm', ['-rf', '--', p], { timeout: 120000 });
        if (!r.ok) { const e = new Error(r.stderr.trim() || 'rm failed'); e.code = /denied/i.test(r.stderr) ? 'EACCES' : 'EIO'; throw e; }
      },
      async chmod(p, mode) { return call((s, cb) => s.chmod(p, mode, cb)); },
      createReadStream: (p) => {
        const { PassThrough } = require('stream');
        const out = new PassThrough();
        self.sftp().then((s) => { const rs = s.createReadStream(p); rs.on('error', (e) => out.destroy(sftpError(e))); rs.pipe(out); }, (e) => out.destroy(e));
        return out;
      },
      async writeFrom(p, readable) {
        const sftp = await self.sftp();
        await pipeline(readable, sftp.createWriteStream(p));
      },
    };
  }
}

/**
 * Connect without authenticating just to learn the server's host key fingerprint
 * (the user then confirms it out-of-band before it is pinned).
 */
function probeHostKey(address, port = 22, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let fp = null;
    const done = (err) => {
      try { conn.destroy(); } catch { /* ignore */ }
      if (fp) resolve(fp); else reject(httpError(502, friendlySshError(err)));
    };
    conn.on('error', done);
    conn.on('close', () => done(new Error('Connection closed')));
    conn.connect({
      host: address, port, username: 'probe', readyTimeout: timeout,
      hostVerifier: (key) => { fp = fingerprint(key); return false; },
    });
  });
}

module.exports = { LocalHost, SshHost, probeHostKey, fingerprint, shq, friendlySshError };
