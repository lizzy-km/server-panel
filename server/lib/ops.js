'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { run } = require('./exec');
const { httpError } = require('./auth');

// ======================= systemd services =======================

const UNIT_RE = /^[a-zA-Z0-9@._:\\-]{1,200}\.(service|socket|timer)$/;
const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'];

function parseUnits(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    return m ? { unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5] } : null;
  }).filter(Boolean);
}

async function listServices() {
  const r = await run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend']);
  if (r.missing || (!r.stdout && !r.ok)) return { available: false, error: r.stderr.trim() || 'systemd not available', list: [] };
  const enabled = await run('systemctl', ['list-unit-files', '--type=service', '--no-pager', '--plain', '--no-legend']);
  const map = {};
  for (const line of enabled.stdout.trim().split('\n')) {
    const [u, st] = line.trim().split(/\s+/);
    if (u) map[u] = st;
  }
  return { available: true, list: parseUnits(r.stdout).map((u) => ({ ...u, enabled: map[u.unit] || 'unknown' })) };
}

async function serviceAction(unit, action) {
  if (!UNIT_RE.test(unit)) throw httpError(400, 'Invalid unit name');
  if (!SERVICE_ACTIONS.includes(action)) throw httpError(400, 'Invalid action');
  const r = await run('systemctl', [action, unit], { timeout: 60000 });
  if (!r.ok) throw httpError(500, (r.stderr || r.stdout || 'systemctl failed').trim());
  return { ok: true };
}

async function serviceStatus(unit) {
  if (!UNIT_RE.test(unit)) throw httpError(400, 'Invalid unit name');
  const r = await run('systemctl', ['status', unit, '--no-pager', '-n', '30']);
  return { output: r.stdout || r.stderr };
}

// ======================= Docker =======================

const DOCKER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const DOCKER_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'rm'];

const jsonLines = (text) => text.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

async function dockerOverview() {
  const ps = await run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 15000 });
  if (ps.missing) return { available: false, error: 'Docker CLI not installed', containers: [], images: [] };
  if (!ps.ok) return { available: false, error: ps.stderr.trim() || 'Docker daemon not reachable', containers: [], images: [] };
  const [stats, images] = await Promise.all([
    run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 15000 }),
    run('docker', ['images', '--format', '{{json .}}'], { timeout: 15000 }),
  ]);
  const statMap = {};
  for (const s of jsonLines(stats.stdout)) statMap[s.ID || s.Container] = s;
  return {
    available: true,
    containers: jsonLines(ps.stdout).map((c) => {
      const s = statMap[c.ID] || {};
      return {
        id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports, created: c.RunningFor,
        cpu: s.CPUPerc || '', mem: s.MemUsage || '',
      };
    }),
    images: jsonLines(images.stdout).map((i) => ({ id: i.ID, repo: i.Repository, tag: i.Tag, size: i.Size, created: i.CreatedSince })),
  };
}

async function dockerAction(id, action) {
  if (!DOCKER_ID_RE.test(id)) throw httpError(400, 'Invalid container id');
  if (!DOCKER_ACTIONS.includes(action)) throw httpError(400, 'Invalid action');
  const args = action === 'rm' ? ['rm', id] : [action, id];
  const r = await run('docker', args, { timeout: 60000 });
  if (!r.ok) throw httpError(500, (r.stderr || 'docker failed').trim());
  return { ok: true };
}

async function dockerLogs(id, lines = 200) {
  if (!DOCKER_ID_RE.test(id)) throw httpError(400, 'Invalid container id');
  const n = Math.max(1, Math.min(2000, Number(lines) || 200));
  const r = await run('docker', ['logs', '--tail', String(n), '--timestamps', id], { timeout: 15000 });
  return { output: (r.stdout + r.stderr).slice(-500_000) };
}

// ======================= Files =======================

class FileManager {
  constructor(root) {
    this.root = path.resolve(root);
    this.rootSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
  }

  inside(abs) { return abs === this.root || abs.startsWith(this.rootSep); }

  /** Resolve a client-supplied path under the root, rejecting traversal and symlink escapes. */
  async resolve(rel, { mustExist = true } = {}) {
    const clean = String(rel || '').replace(/\0/g, '');
    const abs = path.resolve(this.root, '.' + path.sep + clean);
    if (!this.inside(abs)) throw httpError(400, 'Path is outside the allowed root');
    const realRoot = await fsp.realpath(this.root);
    const check = mustExist ? abs : path.dirname(abs);
    let real;
    try { real = await fsp.realpath(check); } catch { throw httpError(404, 'Not found'); }
    if (real !== realRoot && !real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) {
      throw httpError(400, 'Path escapes the allowed root');
    }
    return abs;
  }

  rel(abs) { return '/' + path.relative(this.root, abs).split(path.sep).join('/'); }

  async list(rel) {
    const abs = await this.resolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) throw httpError(400, 'Not a directory');
    const names = await fsp.readdir(abs);
    const entries = (await Promise.all(names.map(async (name) => {
      try {
        const s = await fsp.lstat(path.join(abs, name));
        return {
          name, type: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file',
          size: s.size, mtime: s.mtimeMs, mode: (s.mode & 0o777).toString(8),
        };
      } catch { return null; }
    }))).filter(Boolean);
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: this.rel(abs), root: this.root, entries };
  }

  async read(rel, maxBytes = 2 * 1024 * 1024) {
    const abs = await this.resolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw httpError(400, 'Not a file');
    if (st.size > maxBytes) throw httpError(413, `File is larger than ${maxBytes / 1024 / 1024} MB; download it instead`);
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) throw httpError(415, 'Binary file; download it instead');
    return { path: this.rel(abs), size: st.size, content: buf.toString('utf8') };
  }

  async write(rel, content) {
    if (typeof content !== 'string') throw httpError(400, 'content must be a string');
    const abs = await this.resolve(rel, { mustExist: false });
    await fsp.writeFile(abs, content);
    return { ok: true };
  }

  async mkdir(rel) {
    const abs = await this.resolve(rel, { mustExist: false });
    await fsp.mkdir(abs);
    return { ok: true };
  }

  async rename(from, to) {
    const a = await this.resolve(from);
    const b = await this.resolve(to, { mustExist: false });
    if (a === this.root) throw httpError(400, 'Cannot move the root');
    await fsp.rename(a, b);
    return { ok: true };
  }

  async remove(rel) {
    const abs = await this.resolve(rel);
    if (abs === this.root) throw httpError(400, 'Cannot delete the root');
    await fsp.rm(abs, { recursive: true });
    return { ok: true };
  }

  async chmod(rel, mode) {
    if (!/^[0-7]{3,4}$/.test(String(mode))) throw httpError(400, 'Invalid mode');
    const abs = await this.resolve(rel);
    await fsp.chmod(abs, parseInt(mode, 8));
    return { ok: true };
  }

  async downloadStream(rel) {
    const abs = await this.resolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw httpError(400, 'Not a file');
    return { abs, size: st.size, name: path.basename(abs), stream: fs.createReadStream(abs) };
  }

  async upload(dirRel, name, req, limit) {
    if (!name || /[\\/\0]/.test(name) || name === '.' || name === '..') throw httpError(400, 'Invalid file name');
    const dir = await this.resolve(dirRel);
    if (!(await fsp.stat(dir)).isDirectory()) throw httpError(400, 'Target is not a directory');
    const target = path.join(dir, name);
    const tmp = `${target}.upload-${process.pid}`;
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { req.destroy(); out.destroy(); reject(httpError(413, 'Upload too large')); }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    }).catch(async (e) => { await fsp.rm(tmp, { force: true }); throw e; });
    await fsp.rename(tmp, target);
    return { ok: true, size };
  }
}

// ======================= Logs =======================

const UNIT_FILTER_RE = /^[a-zA-Z0-9@._:\\-]{1,200}$/;
const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug', '0', '1', '2', '3', '4', '5', '6', '7'];

function filterLines(text, q) {
  if (!q) return text;
  const needle = String(q).toLowerCase();
  return text.split('\n').filter((l) => l.toLowerCase().includes(needle)).join('\n');
}

class LogReader {
  constructor(dirs) { this.dirs = dirs.map((d) => path.resolve(d)); }

  async sources() {
    const files = [];
    for (const dir of this.dirs) {
      let names;
      try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of names) {
        const p = path.join(dir, d.name);
        try {
          if (d.isFile()) { const s = await fsp.stat(p); files.push({ path: p, size: s.size, mtime: s.mtimeMs }); }
          else if (d.isDirectory()) {
            for (const sub of await fsp.readdir(p, { withFileTypes: true })) {
              if (sub.isFile()) { const sp = path.join(p, sub.name); const s = await fsp.stat(sp); files.push({ path: sp, size: s.size, mtime: s.mtimeMs }); }
            }
          }
        } catch { /* unreadable */ }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const j = await run('journalctl', ['--version']);
    return { journal: !j.missing && j.ok, files };
  }

  async file(p, lines = 300, q = '') {
    const abs = path.resolve(String(p || ''));
    let real;
    try { real = await fsp.realpath(abs); } catch { throw httpError(404, 'Not found'); }
    const allowed = this.dirs.some((d) => real.startsWith(d + path.sep));
    if (!allowed) throw httpError(403, 'File is outside the allowed log directories');
    const st = await fsp.stat(real);
    if (!st.isFile()) throw httpError(400, 'Not a file');
    if (/\.(gz|xz|bz2|zip|zst)$/.test(real)) throw httpError(415, 'Compressed logs are not supported');
    const n = Math.max(1, Math.min(5000, Number(lines) || 300));
    const chunk = Math.min(st.size, 2 * 1024 * 1024);
    const fh = await fsp.open(real, 'r');
    try {
      const buf = Buffer.alloc(chunk);
      await fh.read(buf, 0, chunk, st.size - chunk);
      let text = buf.toString('utf8');
      text = filterLines(text, q);
      return { output: text.split('\n').slice(-n).join('\n') };
    } finally { await fh.close(); }
  }

  async journal({ unit, lines = 300, priority, q } = {}) {
    const n = Math.max(1, Math.min(5000, Number(lines) || 300));
    const args = ['--no-pager', '-o', 'short-iso', '-n', String(n)];
    if (unit) {
      if (!UNIT_FILTER_RE.test(unit)) throw httpError(400, 'Invalid unit');
      args.push('-u', unit);
    }
    if (priority) {
      if (!PRIORITIES.includes(String(priority))) throw httpError(400, 'Invalid priority');
      args.push('-p', String(priority));
    }
    const r = await run('journalctl', args, { timeout: 15000 });
    if (r.missing) throw httpError(501, 'journalctl is not available on this host');
    return { output: filterLines(r.stdout || r.stderr, q) };
  }
}

// ======================= Cron =======================

async function readCrontab() {
  const r = await run('crontab', ['-l']);
  if (r.missing) return { available: false, content: '' };
  return { available: true, content: r.ok ? r.stdout : '' };
}

function validateCrontab(content) {
  const errors = [];
  const lines = String(content).split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t)) return; // env assignment
    if (/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s+\S+/.test(t)) return;
    const parts = t.split(/\s+/);
    if (parts.length < 6 || !parts.slice(0, 5).every((f) => /^[\d*,/\-A-Za-z?LW#]+$/.test(f))) {
      errors.push(`Line ${i + 1}: expected "m h dom mon dow command"`);
    }
  });
  return errors;
}

async function writeCrontab(content) {
  const errors = validateCrontab(content);
  if (errors.length) throw httpError(400, errors.join('\n'));
  const body = String(content).replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  const { spawn } = require('child_process');
  await new Promise((resolve, reject) => {
    const p = spawn('crontab', ['-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(httpError(501, e.code === 'ENOENT' ? 'crontab is not available' : e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(httpError(400, err.trim() || 'crontab rejected the file'))));
    p.stdin.end(body);
  });
  return { ok: true };
}

// ======================= Terminal (one-shot commands) =======================

function runCommand(command, { timeoutMs = 30000, cwd } = {}) {
  const { spawn } = require('child_process');
  const limit = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn('bash', ['-c', command], { cwd, env: { ...process.env, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let truncated = false;
    let timedOut = false;
    const take = (d) => {
      if (out.length < 512 * 1024) out += d; else truncated = true;
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, limit);
    p.on('error', (e) => { clearTimeout(timer); resolve({ output: e.message, code: null, ms: 0, timedOut: false, truncated: false }); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ output: out, code, signal, ms: Date.now() - started, timedOut, truncated });
    });
  });
}

module.exports = {
  listServices, serviceAction, serviceStatus, parseUnits, UNIT_RE,
  dockerOverview, dockerAction, dockerLogs,
  FileManager, LogReader, filterLines,
  readCrontab, writeCrontab, validateCrontab,
  runCommand,
};
