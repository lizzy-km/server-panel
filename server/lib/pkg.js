'use strict';
const { httpError } = require('./auth');

const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/** Parse `dnf -q check-update` output: "name.arch  version  repo" lines. Stops at the "Obsoleting Packages" section. */
function parseCheckUpdate(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/^Obsoleting Packages/i.test(line)) break;
    const m = line.trim().match(/^(\S+)\.([A-Za-z0-9_]+)\s+(\S+)\s+(\S+)$/);
    if (m) out.push({ name: m[1], arch: m[2], version: m[3], repo: m[4] });
  }
  return out;
}

/** Parse `dnf -q updateinfo list --security`: "ALAS2023-2024-001 Important/Sec. pkg-1.2-3.amzn2023.x86_64". */
function parseSecurity(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(ALAS\S*|\S+-\d{4}-\d+)\s+(\S+)\s+(\S+)$/);
    if (!m) continue;
    // strip version-release.arch to get the package name
    const name = m[3].replace(/\.[A-Za-z0-9_]+$/, '').replace(/-[^-]+-[^-]+$/, '');
    const raw = m[2].split('/')[0];
    const severity = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    const rank = { Critical: 4, Important: 3, Moderate: 2, Low: 1 };
    if (!map[name] || (rank[severity] || 0) > (rank[map[name].severity] || 0)) map[name] = { advisory: m[1], severity };
  }
  return map;
}

const busyHosts = new Set();

async function listUpdates(host, { refresh = false } = {}) {
  const args = ['-q', 'check-update'];
  if (refresh) args.push('--refresh');
  const r = await host.run('dnf', args, { timeout: 180000 });
  if (r.missing) return { available: false, error: 'dnf not found (this page targets Amazon Linux 2023 / Fedora-family hosts)', updates: [] };
  // dnf exits 100 when updates are available, 0 when none, 1 on error
  if (r.code !== 0 && r.code !== 100) return { available: true, error: (r.stderr || 'dnf check-update failed').trim(), updates: [] };
  const [sec, reboot] = await Promise.all([
    host.run('dnf', ['-q', 'updateinfo', 'list', '--security'], { timeout: 120000 }),
    host.runPriv('needs-restarting', ['-r'], { timeout: 30000 }),
  ]);
  const secMap = parseSecurity(sec.stdout);
  const updates = parseCheckUpdate(r.stdout).map((u) => ({ ...u, security: secMap[u.name] ? secMap[u.name].severity : '', advisory: secMap[u.name] ? secMap[u.name].advisory : '' }));
  return {
    available: true,
    updates,
    securityCount: updates.filter((u) => u.security).length,
    // needs-restarting exits 1 when a reboot is advised; null when the tool (dnf-utils) is missing
    rebootRequired: reboot.missing ? null : reboot.code === 1,
    busy: busyHosts.has(host.id),
  };
}

async function upgrade(host, { packages = [], securityOnly = false } = {}) {
  if (busyHosts.has(host.id)) throw httpError(409, 'Another package operation is already running');
  if (!Array.isArray(packages) || packages.length > 200 || !packages.every((p) => typeof p === 'string' && PKG_RE.test(p))) {
    throw httpError(400, 'Invalid package list');
  }
  const args = ['-y', 'upgrade'];
  if (securityOnly) args.push('--security');
  args.push(...packages);
  busyHosts.add(host.id);
  try {
    const r = await host.runPriv('dnf', args, { timeout: 900000, maxBuffer: 16 * 1024 * 1024 });
    const output = (r.stdout + r.stderr).slice(-60000);
    if (!r.ok) throw Object.assign(httpError(500, `dnf failed:\n${output.slice(-2000)}`), { output });
    return { ok: true, output };
  } finally { busyHosts.delete(host.id); }
}

module.exports = { listUpdates, upgrade, parseCheckUpdate, parseSecurity, PKG_RE };
