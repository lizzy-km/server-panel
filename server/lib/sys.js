'use strict';
/** System metrics and inspection, all via a Host (local or SSH) so one code path serves both. */
const { httpError } = require('./auth');

// ---------- raw snapshot ----------

const SNAPSHOT_SCRIPT = 'for f in stat meminfo loadavg uptime net/dev; do echo "@@$f"; cat /proc/$f 2>/dev/null; done';

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^@@(.+)$/);
    if (m) { cur = m[1]; out[cur] = []; } else if (cur) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n');
  return out;
}

function parseCpu(text) {
  return (text || '').split('\n').filter((l) => /^cpu\d*\s/.test(l)).map((line) => {
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    return { idle: n[3] + (n[4] || 0), total: n.reduce((a, b) => a + b, 0) };
  });
}

function parseMem(text) {
  const m = {};
  for (const line of (text || '').split('\n')) {
    const [k, v] = line.split(':');
    if (v) m[k] = parseInt(v, 10) * 1024;
  }
  const total = m.MemTotal || 0;
  const available = m.MemAvailable ?? ((m.MemFree || 0) + (m.Buffers || 0) + (m.Cached || 0));
  return {
    total, available, used: total - available,
    swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
  };
}

function parseNet(text) {
  const out = {};
  for (const line of (text || '').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    out[name.trim()] = { rx: f[0], tx: f[8] };
  }
  return out;
}

class Sampler {
  /** Samples only while someone is looking: stops itself after `idleMs` without touch(). */
  constructor(host, { intervalMs = 3000, length = 200, idleMs = 60000 } = {}) {
    Object.assign(this, { host, intervalMs, length, idleMs });
    this.history = [];
    this.prevCpu = null; this.prevNet = null; this.prevAt = 0;
    this.timer = null; this.running = false; this.lastTouch = 0;
  }

  async touch() {
    this.lastTouch = Date.now();
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (Date.now() - this.lastTouch > this.idleMs) { this.stop(); return; }
        this.sample().catch(() => {});
      }, this.intervalMs);
      this.timer.unref();
    }
    if (!this.history.length) {
      await this.sample();
      await new Promise((r) => setTimeout(r, 400)); // second sample gives a real CPU delta immediately
      await this.sample();
    }
  }

  stop() { clearInterval(this.timer); this.timer = null; this.prevCpu = null; this.prevNet = null; }

  async sample() {
    if (this.running) return this.latest();
    this.running = true;
    try {
      const r = await this.host.run('sh', ['-c', SNAPSHOT_SCRIPT], { timeout: 8000 });
      if (!r.stdout) throw httpError(502, r.stderr || 'Could not read /proc on the target');
      const s = sections(r.stdout);
      const now = Date.now();
      const cpu = parseCpu(s.stat);
      const net = parseNet(s['net/dev']);
      const mem = parseMem(s.meminfo);
      const load = (s.loadavg || '').trim().split(/\s+/).slice(0, 3).map(Number);
      const point = {
        t: now, cpu: 0, cores: [],
        mem: { used: mem.used, total: mem.total, percent: mem.total ? (mem.used / mem.total) * 100 : 0 },
        swap: { used: mem.swapUsed, total: mem.swapTotal },
        load: load.length === 3 && load.every(Number.isFinite) ? load : [0, 0, 0],
        uptime: parseFloat((s.uptime || '').split(' ')[0]) || 0,
        rx: 0, tx: 0,
      };
      if (this.prevCpu && cpu.length) {
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
      this.prevCpu = cpu; this.prevNet = net; this.prevAt = now;
      this.history.push(point);
      if (this.history.length > this.length) this.history.shift();
      return point;
    } finally { this.running = false; }
  }

  latest() { return this.history[this.history.length - 1] || null; }
}

// ---------- static system info ----------

const INFO_SCRIPT = [
  'echo "@@hostname"; hostname',
  'echo "@@osrelease"; cat /etc/os-release 2>/dev/null',
  'echo "@@kernel"; uname -r; uname -m',
  'echo "@@cpu"; grep -m1 -E "^(model name|Model name)" /proc/cpuinfo | cut -d: -f2; lscpu 2>/dev/null | sed -n "s/^Model name: *//p" | head -1; nproc --all 2>/dev/null',
  'echo "@@ip"; ip -o -4 addr show 2>/dev/null',
  'echo "@@user"; id -un',
].join('; ');

function parseInfo(text) {
  const s = sections(text);
  const os = {};
  for (const line of (s.osrelease || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) os[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, '');
  }
  const [kernel, arch] = (s.kernel || '').trim().split('\n');
  const cpuLines = (s.cpu || '').trim().split('\n').map((x) => x.trim()).filter(Boolean);
  const cpuCount = Number(cpuLines.length && /^\d+$/.test(cpuLines[cpuLines.length - 1]) ? cpuLines.pop() : 0) || 0;
  const interfaces = [];
  for (const line of (s.ip || '').split('\n')) {
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+([\d.]+)\/\d+/);
    if (m) interfaces.push({ name: m[1], address: m[2], family: 'IPv4', mac: '', internal: m[1] === 'lo' });
  }
  return {
    hostname: (s.hostname || '').trim(),
    os: os.PRETTY_NAME || os.NAME || 'Linux',
    kernel: (kernel || '').trim(), arch: (arch || '').trim(),
    cpuModel: cpuLines[0] || 'unknown', cpuCount,
    interfaces, user: (s.user || '').trim(),
  };
}

async function systemInfo(host) {
  const r = await host.run('sh', ['-c', INFO_SCRIPT], { timeout: 10000 });
  if (!r.stdout) throw httpError(502, r.stderr || 'Could not query the target');
  return parseInfo(r.stdout);
}

// ---------- disks ----------

const PSEUDO_FS = /^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup2?|efivarfs|devpts|mqueue|ramfs|none|shm)$/;

function parseDf(text) {
  const out = [];
  const seen = new Set();
  for (const line of text.trim().split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) continue;
    const [, fsName, type, total, used, avail, pct, mount] = m;
    if (PSEUDO_FS.test(type) && mount !== '/') continue;
    if (mount.startsWith('/proc') || mount.startsWith('/sys') || mount.startsWith('/dev/')) continue;
    const key = fsName + mount;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filesystem: fsName, type, total: +total * 1024, used: +used * 1024, available: +avail * 1024, percent: +pct, mount });
  }
  return out;
}

async function disks(host) {
  const r = await host.run('df', ['-P', '-k', '-T']);
  return r.stdout ? parseDf(r.stdout) : [];
}

// ---------- processes ----------

function parsePs(text) {
  const out = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    out.push({
      pid: +m[1], ppid: +m[2], user: m[3], cpu: +m[4], mem: +m[5], rss: +m[6] * 1024,
      elapsed: m[7], state: m[8], name: m[9], command: (m[10] || m[9]).slice(0, 300),
    });
  }
  return out;
}

async function processes(host) {
  const r = await host.run('ps', ['-eo', 'pid,ppid,user:20,pcpu,pmem,rss,etime,stat,comm,args', '--sort=-pcpu'], { timeout: 10000 });
  if (!r.stdout) return { available: false, error: r.stderr || 'ps unavailable', list: [] };
  return { available: true, list: parsePs(r.stdout) };
}

const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGSTOP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2'];

async function killProcess(host, pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 1) throw httpError(400, 'Refusing to signal that PID');
  if (host.kind === 'local' && pid === process.pid) throw httpError(400, 'Refusing to signal the panel itself');
  if (!SIGNALS.includes(signal)) throw httpError(400, 'Unsupported signal');
  const r = await host.runPriv('kill', ['-s', signal.slice(3), String(pid)]);
  if (!r.ok) {
    const msg = r.stderr.trim();
    if (/No such process/i.test(msg)) throw httpError(404, 'No such process');
    if (/not permitted|denied/i.test(msg)) throw httpError(403, 'Permission denied');
    throw httpError(500, msg || 'kill failed');
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

async function listeningPorts(host) {
  const r = await host.runPriv('ss', ['-H', '-tulnp']);
  if (r.missing) return { available: false, list: [] };
  return { available: true, list: parseSs(r.stdout) };
}

module.exports = {
  Sampler, systemInfo, parseInfo, disks, parseDf, processes, parsePs, killProcess, SIGNALS, listeningPorts, parseSs,
  parseCpu, parseMem, parseNet, sections,
};
