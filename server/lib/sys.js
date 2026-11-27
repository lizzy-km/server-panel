'use strict';
const fs = require('fs');
const os = require('os');
const { run } = require('./exec');

const isLinux = process.platform === 'linux';

// ---------- CPU / memory / network sampling ----------

function readCpuTimes() {
  if (isLinux) {
    try {
      return fs.readFileSync('/proc/stat', 'utf8').split('\n').filter((l) => /^cpu\d*\s/.test(l)).map((line) => {
        const n = line.trim().split(/\s+/).slice(1).map(Number);
        return { idle: n[3] + (n[4] || 0), total: n.reduce((a, b) => a + b, 0) };
      });
    } catch { /* fall through */ }
  }
  const cpus = os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
  const sum = cpus.reduce((a, c) => ({ idle: a.idle + c.idle, total: a.total + c.total }), { idle: 0, total: 0 });
  return [sum, ...cpus];
}

function readMemory() {
  if (isLinux) {
    try {
      const m = {};
      for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
        const [k, v] = line.split(':');
        if (v) m[k] = parseInt(v, 10) * 1024;
      }
      const total = m.MemTotal;
      const available = m.MemAvailable ?? (m.MemFree + (m.Buffers || 0) + (m.Cached || 0));
      return {
        total, available, used: total - available,
        cached: (m.Cached || 0) + (m.Buffers || 0),
        swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
      };
    } catch { /* fall through */ }
  }
  const total = os.totalmem(), free = os.freemem();
  return { total, available: free, used: total - free, cached: 0, swapTotal: 0, swapUsed: 0 };
}

function readNet() {
  const out = {};
  if (!isLinux) return out;
  try {
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest) continue;
      const f = rest.trim().split(/\s+/).map(Number);
      out[name.trim()] = { rx: f[0], tx: f[8] };
    }
  } catch { /* ignore */ }
  return out;
}

class Sampler {
  constructor({ intervalMs = 3000, length = 200 } = {}) {
    this.intervalMs = intervalMs;
    this.length = length;
    this.history = [];
    this.prevCpu = null;
    this.prevNet = null;
    this.prevAt = 0;
    this.timer = null;
  }

  start() {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
    return this;
  }

  stop() { clearInterval(this.timer); }

  sample() {
    const now = Date.now();
    const cpu = readCpuTimes();
    const net = readNet();
    const mem = readMemory();
    const point = {
      t: now,
      cpu: 0,
      cores: [],
      mem: { used: mem.used, total: mem.total, percent: mem.total ? (mem.used / mem.total) * 100 : 0 },
      swap: { used: mem.swapUsed, total: mem.swapTotal },
      load: os.loadavg(),
      rx: 0,
      tx: 0,
    };
    if (this.prevCpu) {
      const pct = (a, b) => {
        const dt = b.total - a.total;
        return dt > 0 ? Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / dt) * 100)) : 0;
      };
      point.cpu = pct(this.prevCpu[0], cpu[0]);
      point.cores = cpu.slice(1).map((c, i) => pct(this.prevCpu[i + 1] || c, c));
    }
    if (this.prevNet) {
      const dt = (now - this.prevAt) / 1000 || 1;
      for (const [name, v] of Object.entries(net)) {
        if (name === 'lo' || !this.prevNet[name]) continue;
        point.rx += Math.max(0, (v.rx - this.prevNet[name].rx) / dt);
        point.tx += Math.max(0, (v.tx - this.prevNet[name].tx) / dt);
      }
    }
    point.netTotals = net;
    this.prevCpu = cpu; this.prevNet = net; this.prevAt = now;
    this.history.push(point);
    if (this.history.length > this.length) this.history.shift();
    return point;
  }

  latest() { return this.history[this.history.length - 1] || this.sample(); }
}

// ---------- static system info ----------

function readOsRelease() {
  try {
    const m = {};
    for (const line of fs.readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, '');
    }
    return m.PRETTY_NAME || m.NAME || null;
  } catch { return null; }
}

function systemInfo() {
  const cpus = os.cpus();
  const ifaces = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) ifaces.push({ name, address: a.address, family: a.family, mac: a.mac, internal: a.internal });
  }
  return {
    hostname: os.hostname(),
    os: readOsRelease() || `${os.type()} ${os.release()}`,
    kernel: os.release(),
    arch: os.arch(),
    platform: process.platform,
    cpuModel: cpus[0] ? cpus[0].model : 'unknown',
    cpuCount: cpus.length,
    uptime: os.uptime(),
    bootTime: Date.now() - os.uptime() * 1000,
    node: process.version,
    panelUptime: process.uptime(),
    interfaces: ifaces,
    user: os.userInfo().username,
  };
}

// ---------- disks ----------

const PSEUDO_FS = /^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup2?|efivarfs|devpts|mqueue|ramfs|none|shm)$/;

function parseDf(text) {
  const lines = text.trim().split('\n').slice(1);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) continue;
    const [, fs_, type, total, used, avail, pct, mount] = m;
    if (PSEUDO_FS.test(type) && mount !== '/') continue;
    if (mount.startsWith('/proc') || mount.startsWith('/sys') || mount.startsWith('/dev/')) continue;
    const key = fs_ + mount;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filesystem: fs_, type, total: +total * 1024, used: +used * 1024, available: +avail * 1024, percent: +pct, mount });
  }
  return out;
}

async function disks() {
  const r = await run('df', ['-P', '-k', '-T']);
  if (!r.stdout) return [];
  return parseDf(r.stdout);
}

// ---------- processes ----------

function parsePs(text) {
  const lines = text.trim().split('\n').slice(1);
  const out = [];
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    out.push({
      pid: +m[1], ppid: +m[2], user: m[3], cpu: +m[4], mem: +m[5], rss: +m[6] * 1024,
      elapsed: m[7], state: m[8], name: m[9], command: (m[10] || m[9]).slice(0, 300),
    });
  }
  return out;
}

async function processes() {
  const r = await run('ps', ['-eo', 'pid,ppid,user:20,pcpu,pmem,rss,etime,stat,comm,args', '--sort=-pcpu'], { timeout: 8000 });
  if (!r.stdout) return { available: false, error: r.stderr || 'ps unavailable', list: [] };
  return { available: true, list: parsePs(r.stdout) };
}

const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGSTOP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2'];

function killProcess(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 1) { const e = new Error('Refusing to signal that PID'); e.status = 400; throw e; }
  if (pid === process.pid) { const e = new Error('Refusing to signal the panel itself'); e.status = 400; throw e; }
  if (!SIGNALS.includes(signal)) { const e = new Error('Unsupported signal'); e.status = 400; throw e; }
  try { process.kill(pid, signal); } catch (err) {
    const e = new Error(err.code === 'ESRCH' ? 'No such process' : err.code === 'EPERM' ? 'Permission denied' : err.message);
    e.status = err.code === 'ESRCH' ? 404 : err.code === 'EPERM' ? 403 : 500;
    throw e;
  }
}

// ---------- network connections ----------

function parseSs(text) {
  const out = [];
  for (const line of text.trim().split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5) continue;
    const proc = (line.match(/users:\(\("([^"]+)",pid=(\d+)/) || []);
    out.push({ proto: p[0], state: p[1], local: p[4], peer: p[5] || '', process: proc[1] || '', pid: proc[2] ? +proc[2] : null });
  }
  return out;
}

async function listeningPorts() {
  const r = await run('ss', ['-H', '-tulnp']);
  if (r.missing) return { available: false, list: [] };
  return { available: true, list: parseSs(r.stdout) };
}

module.exports = {
  Sampler, systemInfo, disks, parseDf, processes, parsePs, killProcess, SIGNALS, listeningPorts, parseSs,
};
