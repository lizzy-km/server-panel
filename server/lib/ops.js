'use strict';
/** Operations on a target machine (services, Docker, files, logs, cron). Every function takes a Host. */
const path = require('path');
const { Transform } = require('stream');
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

async function listServices(host) {
  const r = await host.run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend']);
  if (r.missing || (!r.stdout && !r.ok)) return { available: false, error: r.stderr.trim() || 'systemd not available', list: [] };
  const enabled = await host.run('systemctl', ['list-unit-files', '--type=service', '--no-pager', '--plain', '--no-legend']);
  const map = {};
  for (const line of enabled.stdout.trim().split('\n')) {
    const [u, st] = line.trim().split(/\s+/);
    if (u) map[u] = st;
  }
  return { available: true, list: parseUnits(r.stdout).map((u) => ({ ...u, enabled: map[u.unit] || 'unknown' })) };
}

async function serviceAction(host, unit, action) {
  if (!UNIT_RE.test(unit)) throw httpError(400, 'Invalid unit name');
  if (!SERVICE_ACTIONS.includes(action)) throw httpError(400, 'Invalid action');
  const r = await host.runPriv('systemctl', [action, unit], { timeout: 60000 });
  if (!r.ok) throw httpError(500, (r.stderr || r.stdout || 'systemctl failed').trim());
  return { ok: true };
}

async function serviceStatus(host, unit) {
  if (!UNIT_RE.test(unit)) throw httpError(400, 'Invalid unit name');
  const r = await host.run('systemctl', ['status', unit, '--no-pager', '-n', '30']);
  return { output: r.stdout || r.stderr };
}

// ======================= Docker =======================

const DOCKER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const DOCKER_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'rm'];

const jsonLines = (text) => text.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

async function dockerOverview(host) {
  const ps = await host.runPriv('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 20000 });
  if (ps.missing || /command not found|not found/i.test(ps.stderr)) return { available: false, error: 'Docker is not installed on this server', containers: [], images: [] };
  if (!ps.ok) return { available: false, error: ps.stderr.trim() || 'Docker daemon not reachable', containers: [], images: [] };
  const [stats, images] = await Promise.all([
    host.runPriv('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 20000 }),
    host.runPriv('docker', ['images', '--format', '{{json .}}'], { timeout: 20000 }),
  ]);
  const statMap = {};
  for (const s of jsonLines(stats.stdout)) statMap[s.ID || s.Container] = s;
  return {
    available: true,
    containers: jsonLines(ps.stdout).map((c) => {
      const s = statMap[c.ID] || {};
      return { id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports, created: c.RunningFor, cpu: s.CPUPerc || '', mem: s.MemUsage || '' };
    }),
    images: jsonLines(images.stdout).map((i) => ({ id: i.ID, repo: i.Repository, tag: i.Tag, size: i.Size, created: i.CreatedSince })),
  };
}

async function dockerAction(host, id, action) {
  if (!DOCKER_ID_RE.test(id)) throw httpError(400, 'Invalid container id');
  if (!DOCKER_ACTIONS.includes(action)) throw httpError(400, 'Invalid action');
  const r = await host.runPriv('docker', action === 'rm' ? ['rm', id] : [action, id], { timeout: 60000 });
  if (!r.ok) throw httpError(500, (r.stderr || 'docker failed').trim());
  return { ok: true };
}

async function dockerLogs(host, id, lines = 200) {
  if (!DOCKER_ID_RE.test(id)) throw httpError(400, 'Invalid container id');
  const n = Math.max(1, Math.min(2000, Number(lines) || 200));
  const r = await host.runPriv('docker', ['logs', '--tail', String(n), '--timestamps', id], { timeout: 20000 });
  return { output: (r.stdout + r.stderr).slice(-500_000) };
}

// ======================= Files =======================

class FileManager {
  constructor(host, root) {
    this.host = host;
    this.fs = host.fs;
    this.root = path.posix.resolve('/', root || '/');
    this.rootSep = this.root.endsWith('/') ? this.root : this.root + '/';
  }

  inside(abs) { return abs === this.root || abs.startsWith(this.rootSep); }

  /** Resolve a client-supplied path under the root, rejecting traversal and symlink escapes. */
  async resolve(rel, { mustExist = true } = {}) {
    const clean = String(rel || '').replace(/\0/g, '');
    const abs = path.posix.resolve(this.root, '.' + '/' + clean);
    if (!this.inside(abs)) throw httpError(400, 'Path is outside the allowed root');
    let realRoot;
    try { realRoot = await this.fs.realpath(this.root); } catch { throw httpError(404, `File manager root ${this.root} does not exist on this server`); }
    let real;
    try { real = await this.fs.realpath(mustExist ? abs : path.posix.dirname(abs)); } catch (e) {
      throw httpError(e.code === 'EACCES' ? 403 : 404, e.code === 'EACCES' ? 'Permission denied' : 'Not found');
    }
    const rr = realRoot.endsWith('/') ? realRoot : realRoot + '/';
    if (real !== realRoot && !real.startsWith(rr)) throw httpError(400, 'Path escapes the allowed root');
    return abs;
  }

  rel(abs) { return abs === this.root ? '/' : '/' + path.posix.relative(this.root, abs); }

  async list(rel) {
    const abs = await this.resolve(rel);
    const st = await this.fs.stat(abs);
    if (st.type !== 'dir') throw httpError(400, 'Not a directory');
    const entries = await this.fs.readdir(abs);
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: this.rel(abs), root: this.root, entries };
  }

  async read(rel, maxBytes = 2 * 1024 * 1024) {
    const abs = await this.resolve(rel);
    const st = await this.fs.stat(abs);
    if (st.type !== 'file') throw httpError(400, 'Not a file');
    if (st.size > maxBytes) throw httpError(413, `File is larger than ${maxBytes / 1024 / 1024} MB; download it instead`);
    const buf = await this.fs.readFile(abs);
    if (buf.includes(0)) throw httpError(415, 'Binary file; download it instead');
    return { path: this.rel(abs), size: st.size, content: buf.toString('utf8') };
  }

  async write(rel, content) {
    if (typeof content !== 'string') throw httpError(400, 'content must be a string');
    const abs = await this.resolve(rel, { mustExist: false });
    await this.fs.writeFile(abs, content);
    return { ok: true };
  }

  async mkdir(rel) {
    const abs = await this.resolve(rel, { mustExist: false });
    await this.fs.mkdir(abs);
    return { ok: true };
  }

  async rename(from, to) {
    const a = await this.resolve(from);
    const b = await this.resolve(to, { mustExist: false });
    if (a === this.root) throw httpError(400, 'Cannot move the root');
    await this.fs.rename(a, b);
    return { ok: true };
  }

  async remove(rel) {
    const abs = await this.resolve(rel);
    if (abs === this.root) throw httpError(400, 'Cannot delete the root');
    await this.fs.rm(abs);
    return { ok: true };
  }

  async chmod(rel, mode) {
    if (!/^[0-7]{3,4}$/.test(String(mode))) throw httpError(400, 'Invalid mode');
    const abs = await this.resolve(rel);
    await this.fs.chmod(abs, parseInt(mode, 8));
    return { ok: true };
  }

  async downloadStream(rel) {
    const abs = await this.resolve(rel);
    const st = await this.fs.stat(abs);
    if (st.type !== 'file') throw httpError(400, 'Not a file');
    return { abs, size: st.size, name: path.posix.basename(abs), stream: this.fs.createReadStream(abs) };
  }

  async upload(dirRel, name, req, limit) {
    if (!name || /[\\/\0]/.test(name) || name === '.' || name === '..') throw httpError(400, 'Invalid file name');
    const dir = await this.resolve(dirRel);
    if ((await this.fs.stat(dir)).type !== 'dir') throw httpError(400, 'Target is not a directory');
    const target = path.posix.join(dir, name);
    const tmp = `${target}.upload-${process.pid}-${Date.now()}`;
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > limit) cb(httpError(413, 'Upload too large')); else cb(null, chunk);
      },
    });
    req.on('error', (e) => counter.destroy(e));
    try {
      await this.fs.writeFrom(tmp, req.pipe(counter));
    } catch (e) {
      await this.fs.rm(tmp).catch(() => {});
      throw e;
    }
    await this.fs.rename(tmp, target);
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
  constructor(host, dirs) {
    this.host = host;
    this.dirs = dirs.map((d) => path.posix.resolve(d));
  }

  async sources() {
    const files = [];
    for (const dir of this.dirs) {
      const r = await this.host.runPriv('find', [dir, '-maxdepth', '2', '-type', 'f', '-printf', '%p\t%s\t%T@\n'], { timeout: 15000 });
      for (const line of r.stdout.split('\n')) {
        const [p, size, mtime] = line.split('\t');
        if (p && /^\d+$/.test(size)) files.push({ path: p, size: +size, mtime: Math.round(parseFloat(mtime) * 1000) });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const j = await this.host.run('journalctl', ['--version']);
    return { journal: !j.missing && j.ok, files: files.slice(0, 500) };
  }

  async file(p, lines = 300, q = '') {
    const rp = await this.host.runPriv('realpath', ['-e', '--', String(p || '')]);
    const real = rp.stdout.trim();
    if (!rp.ok || !real) throw httpError(404, 'Not found');
    if (!this.dirs.some((d) => real.startsWith(d + '/'))) throw httpError(403, 'File is outside the allowed log directories');
    if (/\.(gz|xz|bz2|zip|zst)$/.test(real)) throw httpError(415, 'Compressed logs are not supported');
    const n = Math.max(1, Math.min(5000, Number(lines) || 300));
    const r = await this.host.runPriv('tail', ['-c', String(2 * 1024 * 1024), '--', real], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    if (!r.ok) throw httpError(/denied/i.test(r.stderr) ? 403 : 500, r.stderr.trim() || 'Could not read log file');
    return { output: filterLines(r.stdout, q).split('\n').slice(-n).join('\n') };
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
    const r = await this.host.runPriv('journalctl', args, { timeout: 20000 });
    if (r.missing) throw httpError(501, 'journalctl is not available on this server');
    return { output: filterLines(r.stdout || r.stderr, q) };
  }
}

// ======================= Cron =======================

const CRON_HINT = 'cronie is not installed (Amazon Linux 2023 does not ship it). Install it: sudo dnf install -y cronie && sudo systemctl enable --now crond';

async function readCrontab(host) {
  const r = await host.run('crontab', ['-l']);
  if (r.missing) return { available: false, content: '', hint: CRON_HINT };
  return { available: true, content: r.ok ? r.stdout : '' };
}

function validateCrontab(content) {
  const errors = [];
  String(content).split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t)) return;
    if (/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s+\S+/.test(t)) return;
    const parts = t.split(/\s+/);
    if (parts.length < 6 || !parts.slice(0, 5).every((f) => /^[\d*,/\-A-Za-z?LW#]+$/.test(f))) {
      errors.push(`Line ${i + 1}: expected "m h dom mon dow command"`);
    }
  });
  return errors;
}

async function writeCrontab(host, content) {
  const errors = validateCrontab(content);
  if (errors.length) throw httpError(400, errors.join('\n'));
  const body = String(content).replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  const r = await host.run('crontab', ['-'], { stdin: body });
  if (r.missing) throw httpError(501, 'crontab is not available');
  if (!r.ok) throw httpError(400, r.stderr.trim() || 'crontab rejected the file');
  return { ok: true };
}

module.exports = {
  listServices, serviceAction, serviceStatus, parseUnits, UNIT_RE,
  dockerOverview, dockerAction, dockerLogs,
  FileManager, LogReader, filterLines,
  readCrontab, writeCrontab, validateCrontab,
};
