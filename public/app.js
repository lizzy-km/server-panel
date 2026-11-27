'use strict';
/* Server Panel frontend — vanilla JS, no build step. All DOM is built with textContent (no innerHTML) to stay XSS-safe. */

// ---------------------------------------------------------------- helpers
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, props, ...children) {
  const svg = ['svg', 'path', 'line', 'text', 'polyline', 'polygon', 'g', 'rect'].includes(tag);
  const el = svg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (!svg && k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);

const fmt = {
  bytes(n, d = 1) {
    if (!Number.isFinite(n)) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : d)} ${u[i]}`;
  },
  rate: (n) => `${fmt.bytes(n)}/s`,
  pct: (n, d = 0) => `${Number(n).toFixed(d)}%`,
  uptime(s) {
    const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return [d && `${d}d`, (d || hr) && `${hr}h`, `${m}m`].filter(Boolean).join(' ');
  },
  date: (ms) => new Date(ms).toLocaleString(),
};

const level = (p, warn = 75, bad = 90) => (p >= bad ? 'bad' : p >= warn ? 'warn' : '');

async function api(path, { method = 'GET', body, raw } = {}) {
  const opts = { method, headers: { 'X-Panel-Request': '1' }, credentials: 'same-origin' };
  if (raw !== undefined) { opts.body = raw; }
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && state.user && !path.startsWith('/api/login')) { state.user = null; render(); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3000);
}
const fail = (e) => toast(e.message || String(e), true);

function modal(title, content, { wide = false, actions = [] } = {}) {
  const close = () => bg.remove();
  const bg = h('div', { class: 'modal-bg', onmousedown: (e) => { if (e.target === bg) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title), content,
      actions.length ? h('div', { class: 'actions' }, actions.map((a) => h('button', { class: a.cls || '', onclick: () => a.onclick(close) }, a.label))) : null));
  bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(bg);
  const first = bg.querySelector('input,textarea,select,button.primary');
  if (first) first.focus();
  return close;
}

function confirmDialog(title, message, label = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, close) => { done = true; close(); resolve(v); };
    const close = modal(title, h('p', {}, message), {
      actions: [
        { label: 'Cancel', onclick: (c) => finish(false, c) },
        { label, cls: danger ? 'danger' : 'primary', onclick: (c) => finish(true, c) },
      ],
    });
    // resolve false if closed via backdrop/escape
    const obs = new MutationObserver(() => { if (!document.querySelector('.modal-bg') && !done) { done = true; resolve(false); obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
  });
}

function promptDialog(title, label, value = '', { type = 'text' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type, value, style: { width: '100%' } });
    let done = false;
    const submit = (close) => { done = true; close(); resolve(input.value); };
    const close = modal(title, h('div', { class: 'field' }, h('label', {}, label), input), {
      actions: [
        { label: 'Cancel', onclick: (c) => { done = true; c(); resolve(null); } },
        { label: 'OK', cls: 'primary', onclick: submit },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(close); });
    const obs = new MutationObserver(() => { if (!document.querySelector('.modal-bg') && !done) { done = true; resolve(null); obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
  });
}

// Run an async action on a button with busy state + error toast.
function act(btn, fn) {
  return async (...a) => {
    btn.disabled = true;
    try { await fn(...a); } catch (e) { fail(e); } finally { btn.disabled = false; }
  };
}

function sortable(rows, key, dir) {
  const s = [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x ?? '').localeCompare(String(y ?? ''));
  });
  return dir === 'desc' ? s.reverse() : s;
}

// Reusable sortable/filterable table
function dataTable({ columns, rows, sort, rowActions, filterText, empty = 'Nothing to show' }) {
  const keyOf = (c) => c.key;
  const head = h('tr', {}, columns.map((c) => h('th', {
    class: (c.num ? 'num ' : '') + (c.sortable === false ? '' : 'sortable'),
    onclick: c.sortable === false ? null : () => sort.onSort(keyOf(c)),
  }, c.label, sort && sort.key === keyOf(c) ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')), rowActions ? h('th', {}) : null);
  const needle = (filterText || '').toLowerCase();
  let data = rows;
  if (needle) data = data.filter((r) => columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(needle)));
  if (sort) data = sortable(data, sort.key, sort.dir);
  if (!data.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, head),
    h('tbody', {}, data.map((r) => h('tr', {},
      columns.map((c) => h('td', { class: (c.num ? 'num ' : '') + (c.wrap ? 'wrap' : '') }, c.render ? c.render(r) : r[c.key])),
      rowActions ? h('td', { class: 'num' }, rowActions(r)) : null)))));
}

// ---------------------------------------------------------------- charts
function lineChart({ series, max = 100, format = (v) => `${v.toFixed(0)}%`, height = 150 }) {
  const W = 600, H = height, pad = { l: 38, r: 8, t: 8, b: 14 };
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  const layers = h('g', {});
  svg.append(layers);
  return {
    el: svg,
    update(points) {
      layers.replaceChildren();
      let top = typeof max === 'function' ? max(points) : max;
      if (!top || top <= 0) top = 1;
      const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
      for (let i = 0; i <= 4; i++) {
        const y = pad.t + (ih * i) / 4;
        layers.append(h('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y, y2: y }));
        layers.append(h('text', { x: 2, y: y + 3 }, format(top * (1 - i / 4))));
      }
      if (points.length < 2) return;
      for (const s of series) {
        const xy = points.map((p, i) => [pad.l + (iw * i) / (points.length - 1), pad.t + ih * (1 - Math.min(1, Math.max(0, s.get(p) / top)))]);
        const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
        layers.append(h('polygon', { class: 'area', fill: s.color, points: `${pad.l},${pad.t + ih} ${line} ${W - pad.r},${pad.t + ih}` }));
        layers.append(h('polyline', { points: line, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
      }
    },
  };
}

// ---------------------------------------------------------------- app state / router
const state = { user: null, features: {}, setupRequired: false, page: null };
let cleanups = [];
const onLeave = (fn) => cleanups.push(fn);
function poll(fn, ms) {
  let stopped = false;
  const tick = async () => { if (stopped) return; try { await fn(); } catch (e) { /* surface once, keep polling */ } };
  const id = setInterval(() => { if (!document.hidden) tick(); }, ms);
  onLeave(() => { stopped = true; clearInterval(id); });
  return tick();
}

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦', page: () => pageDashboard() },
  { id: 'processes', label: 'Processes', icon: '⚙', page: () => pageProcesses() },
  { id: 'services', label: 'Services', icon: '⏻', page: () => pageServices() },
  { id: 'docker', label: 'Docker', icon: '▣', page: () => pageDocker() },
  { id: 'network', label: 'Network', icon: '⇄', page: () => pageNetwork() },
  { sep: true, admin: true },
  { id: 'files', label: 'Files', icon: '▤', admin: true, page: () => pageFiles() },
  { id: 'logs', label: 'Logs', icon: '≣', admin: true, page: () => pageLogs() },
  { id: 'cron', label: 'Cron jobs', icon: '◷', admin: true, page: () => pageCron() },
  { id: 'terminal', label: 'Terminal', icon: '>_', admin: true, page: () => pageTerminal() },
  { sep: true, admin: true },
  { id: 'users', label: 'Users', icon: '☺', admin: true, page: () => pageUsers() },
  { id: 'audit', label: 'Audit log', icon: '✎', admin: true, page: () => pageAudit() },
];

function currentRoute() { return (location.hash.replace(/^#\/?/, '') || 'dashboard'); }

function render() {
  cleanups.forEach((f) => f()); cleanups = [];
  const app = $('#app');
  app.replaceChildren();
  if (state.setupRequired) return app.append(authScreen(true));
  if (!state.user) return app.append(authScreen(false));

  const isAdmin = state.user.role === 'admin';
  const items = NAV.filter((n) => isAdmin || !n.admin);
  const id = currentRoute();
  const item = items.find((n) => n.id === id) || items[0];
  const content = h('div', {});
  const side = h('aside', { class: 'side', id: 'side' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, h('i')), 'Server Panel'),
    h('nav', { class: 'nav' }, items.map((n) => n.sep ? h('div', { class: 'sep' }) :
      h('a', { href: `#/${n.id}`, class: n.id === item.id ? 'active' : '', onclick: () => side.classList.remove('open') }, h('span', { class: 'ico' }, n.icon), n.label))),
    h('div', { class: 'spacer' }),
    h('div', { class: 'nav' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); accountDialog(); } }, h('span', { class: 'ico' }, '⚿'), `${state.user.username} (${state.user.role})`),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); toggleTheme(); } }, h('span', { class: 'ico' }, '◐'), 'Toggle theme'),
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ } state.user = null; render(); } }, h('span', { class: 'ico' }, '⏏'), 'Sign out')));
  app.append(h('div', { class: 'shell' }, side, h('main', { class: 'main' },
    h('button', { class: 'menu-btn', 'aria-label': 'Menu', onclick: () => side.classList.toggle('open'), style: { marginBottom: '12px' } }, '☰ Menu'), content)));
  try { content.append(item.page()); } catch (e) { content.append(h('div', { class: 'notice' }, `Failed to load: ${e.message}`)); }
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('panel-theme', next); } catch { /* ignore */ }
}

function pageHeader(title, sub, ...right) {
  return h('div', { class: 'top' }, h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, right));
}

// ---------------------------------------------------------------- auth screens
function authScreen(setup) {
  const err = h('div', { class: 'err', role: 'alert' });
  const user = h('input', { id: 'u', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true });
  const token = setup ? h('input', { id: 't', autocomplete: 'off', required: true, placeholder: 'Printed in the server console' }) : null;
  const btn = h('button', { class: 'primary', type: 'submit' }, setup ? 'Create admin account' : 'Sign in');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        const r = await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body: { username: user.value, password: pass.value, setupToken: token && token.value } });
        state.user = r.user; state.setupRequired = false; render();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  },
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), pass),
    token ? h('div', { class: 'field' }, h('label', { for: 't' }, 'Setup token'), token) : null,
    err, btn);
  return h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('h1', {}, setup ? 'Welcome — set up your panel' : 'Server Panel'),
    h('p', { class: 'muted' }, setup ? 'Create the first administrator. Use at least 10 characters.' : 'Sign in to continue.'), form));
}

function accountDialog() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', autocomplete: 'new-password' });
  modal('Change password', h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'Current password'), cur),
    h('div', { class: 'field' }, h('label', {}, 'New password (min 10 characters)'), nw)), {
    actions: [{ label: 'Cancel', onclick: (c) => c() }, {
      label: 'Change', cls: 'primary',
      onclick: async (c) => { try { await api('/api/account/password', { method: 'POST', body: { current: cur.value, password: nw.value } }); toast('Password changed'); c(); } catch (e) { fail(e); } },
    }],
  });
}

// ---------------------------------------------------------------- dashboard
function pageDashboard() {
  const root = h('div', {});
  const alertsBox = h('div', {});
  const stats = h('div', { class: 'grid g4' });
  const cpuChart = lineChart({ series: [{ color: '#2563eb', get: (p) => p.cpu }] });
  const memChart = lineChart({ series: [{ color: '#16a34a', get: (p) => p.mem.percent }] });
  const netChart = lineChart({
    series: [{ color: '#2563eb', get: (p) => p.rx }, { color: '#f59e0b', get: (p) => p.tx }],
    max: (pts) => Math.max(1024, ...pts.map((p) => Math.max(p.rx, p.tx))) * 1.1, format: (v) => fmt.bytes(v, 0),
  });
  const cores = h('div', { class: 'cores' });
  const disksBox = h('div', {});
  const infoBox = h('div', {});
  const header = pageHeader('Dashboard', 'Live system overview');
  root.append(header, alertsBox, stats,
    h('div', { class: 'grid g2', style: { marginTop: '14px' } },
      h('div', { class: 'card' }, h('h2', {}, 'CPU usage'), cpuChart.el),
      h('div', { class: 'card' }, h('h2', {}, 'Memory usage'), memChart.el),
      h('div', { class: 'card' }, h('h2', {}, 'Network throughput', h('span', { class: 'legend' }, h('span', {}, h('i', { style: { background: '#2563eb' } }), 'Download'), h('span', {}, h('i', { style: { background: '#f59e0b' } }), 'Upload'))), netChart.el),
      h('div', { class: 'card' }, h('h2', {}, 'CPU cores'), cores)),
    h('div', { class: 'grid g2', style: { marginTop: '14px' } },
      h('div', { class: 'card' }, h('h2', {}, 'Disks'), disksBox),
      h('div', { class: 'card' }, h('h2', {}, 'System'), infoBox)));

  const statCard = (label, value, detail, pct) => h('div', { class: 'card stat' },
    h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'detail' }, detail),
    pct === undefined ? null : h('div', { class: 'bar ' + level(pct) }, h('span', { style: { width: `${Math.min(100, pct)}%` } })));

  let points = [];
  async function tickMetrics() {
    const r = await api('/api/metrics');
    points = r.points;
    const l = points[points.length - 1];
    if (!l) return;
    stats.replaceChildren(
      statCard('CPU', fmt.pct(l.cpu), `Load ${l.load.map((x) => x.toFixed(2)).join(' · ')}`, l.cpu),
      statCard('Memory', fmt.pct(l.mem.percent), `${fmt.bytes(l.mem.used)} of ${fmt.bytes(l.mem.total)}`, l.mem.percent),
      statCard('Network ↓', fmt.rate(l.rx), 'Receive'),
      statCard('Network ↑', fmt.rate(l.tx), 'Transmit'),
      ...(l.swap.total ? [statCard('Swap', fmt.pct((l.swap.used / l.swap.total) * 100), `${fmt.bytes(l.swap.used)} of ${fmt.bytes(l.swap.total)}`, (l.swap.used / l.swap.total) * 100)] : []));
    cpuChart.update(points); memChart.update(points); netChart.update(points);
    cores.replaceChildren(...l.cores.map((c, i) => h('div', { class: 'core' }, `Core ${i}`, h('div', { class: 'bar ' + level(c) }, h('span', { style: { width: `${c}%` } })), fmt.pct(c))));
  }
  async function tickSlow() {
    const [sys, al] = await Promise.all([api('/api/system'), api('/api/alerts')]);
    alertsBox.replaceChildren(...al.alerts.map((a) => h('div', { class: 'alert ' + (a.level === 'crit' ? 'crit' : '') }, '⚠ ' + a.message)));
    const i = sys.info;
    infoBox.replaceChildren(h('table', {}, h('tbody', {}, [
      ['Hostname', i.hostname], ['OS', i.os], ['Kernel', `${i.kernel} (${i.arch})`], ['CPU', `${i.cpuModel} × ${i.cpuCount}`],
      ['Uptime', fmt.uptime(i.uptime)], ['Booted', fmt.date(i.bootTime)], ['Runtime', `Node ${i.node} as ${i.user}`],
      ['Addresses', i.interfaces.filter((x) => !x.internal && x.family === 'IPv4').map((x) => `${x.address} (${x.name})`).join(', ') || '–'],
    ].map(([k, v]) => h('tr', {}, h('td', { class: 'muted' }, k), h('td', { class: 'wrap' }, v))))));
    disksBox.replaceChildren(...(sys.disks.length ? sys.disks.map((d) => h('div', { style: { marginBottom: '12px' } },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('strong', {}, d.mount), h('span', { class: 'muted' }, `${fmt.bytes(d.used)} / ${fmt.bytes(d.total)} · ${d.type}`)),
      h('div', { class: 'bar ' + level(d.percent) }, h('span', { style: { width: `${d.percent}%` } })))) : [h('div', { class: 'empty' }, 'No disks reported')]));
  }
  if (state.user.role === 'admin') {
    header.lastChild.append(h('button', { class: 'sm', onclick: thresholdDialog }, 'Alert thresholds'));
  }
  poll(tickMetrics, 3000); poll(tickSlow, 15000);
  return root;
}

async function thresholdDialog() {
  const cur = (await api('/api/alerts')).thresholds;
  const inputs = {};
  const body = h('div', {}, ['cpu', 'mem', 'disk'].map((k) => {
    inputs[k] = h('input', { type: 'number', min: 1, max: 100, value: cur[k] });
    return h('div', { class: 'field' }, h('label', {}, `${k.toUpperCase()} alert at (%)`), inputs[k]);
  }));
  modal('Alert thresholds', body, { actions: [{ label: 'Cancel', onclick: (c) => c() }, {
    label: 'Save', cls: 'primary',
    onclick: async (c) => { try { await api('/api/alerts/thresholds', { method: 'PUT', body: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, Number(v.value)])) }); toast('Saved'); c(); } catch (e) { fail(e); } },
  }] });
}

// ---------------------------------------------------------------- processes
function pageProcesses() {
  const isAdmin = state.user.role === 'admin';
  const holder = h('div', { class: 'card' });
  const sort = { key: 'cpu', dir: 'desc', onSort(k) { if (sort.key === k) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc'; else { sort.key = k; sort.dir = 'desc'; } draw(); } };
  const search = h('input', { placeholder: 'Filter by name, user, PID, command…', class: 'grow', oninput: () => draw() });
  let rows = [];
  let paused = false;
  const pause = h('button', { onclick: () => { paused = !paused; pause.textContent = paused ? 'Resume' : 'Pause'; } }, 'Pause');
  const columns = [
    { key: 'pid', label: 'PID', num: true }, { key: 'user', label: 'User' },
    { key: 'cpu', label: 'CPU %', num: true }, { key: 'mem', label: 'MEM %', num: true },
    { key: 'rss', label: 'RSS', num: true, render: (r) => fmt.bytes(r.rss) },
    { key: 'state', label: 'State' }, { key: 'elapsed', label: 'Elapsed' }, { key: 'command', label: 'Command', wrap: true },
  ];
  function draw() {
    holder.replaceChildren(dataTable({
      columns, rows, sort, filterText: search.value, empty: 'No matching processes',
      rowActions: isAdmin ? (r) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
        h('button', { class: 'sm', onclick: () => signal(r, 'SIGTERM') }, 'Stop'),
        h('button', { class: 'sm danger', onclick: () => signal(r, 'SIGKILL') }, 'Kill')) : null,
    }));
  }
  async function signal(r, sig) {
    if (!(await confirmDialog(`Send ${sig}?`, `Process ${r.pid} (${r.name}) owned by ${r.user}.`, sig === 'SIGKILL' ? 'Kill' : 'Stop'))) return;
    try { await api('/api/processes/kill', { method: 'POST', body: { pid: r.pid, signal: sig } }); toast(`${sig} sent to ${r.pid}`); load(); } catch (e) { fail(e); }
  }
  async function load() {
    if (paused) return;
    const r = await api('/api/processes');
    if (!r.available) { holder.replaceChildren(h('div', { class: 'notice' }, r.error)); return; }
    rows = r.list; draw();
  }
  poll(load, 4000);
  return h('div', {}, pageHeader('Processes', 'Sorted by CPU by default — click a column header to re-sort'),
    h('div', { class: 'toolbar' }, search, pause), holder);
}

// ---------------------------------------------------------------- services
function pageServices() {
  const isAdmin = state.user.role === 'admin';
  const holder = h('div', { class: 'card' });
  const search = h('input', { class: 'grow', placeholder: 'Filter services…', oninput: () => draw() });
  const only = h('select', { onchange: () => draw() }, [['all', 'All'], ['active', 'Active'], ['failed', 'Failed'], ['inactive', 'Inactive']].map(([v, l]) => h('option', { value: v }, l)));
  const sort = { key: 'unit', dir: 'asc', onSort(k) { sort.dir = sort.key === k && sort.dir === 'asc' ? 'desc' : 'asc'; sort.key = k; draw(); } };
  let list = [];
  async function act_(unit, action) {
    if (['stop', 'disable', 'restart'].includes(action) && !(await confirmDialog(`${action[0].toUpperCase()}${action.slice(1)} ${unit}?`, 'This affects the running system.', action))) return;
    try { await api('/api/services/action', { method: 'POST', body: { unit, action } }); toast(`${action} ${unit}: ok`); load(); } catch (e) { fail(e); }
  }
  async function showStatus(unit) {
    try { const r = await api('/api/services/status?unit=' + encodeURIComponent(unit)); modal(unit, h('pre', { class: 'out' }, r.output), { wide: true, actions: [{ label: 'Close', onclick: (c) => c() }] }); } catch (e) { fail(e); }
  }
  function draw() {
    const f = only.value;
    const rows = list.filter((u) => f === 'all' || (f === 'inactive' ? u.active === 'inactive' : u.active === f));
    holder.replaceChildren(dataTable({
      columns: [
        { key: 'unit', label: 'Unit', render: (r) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); showStatus(r.unit); } }, r.unit) },
        { key: 'active', label: 'State', render: (r) => h('span', { class: 'badge ' + (r.active === 'active' ? 'ok' : r.active === 'failed' ? 'bad' : '') }, `${r.active} (${r.sub})`) },
        { key: 'enabled', label: 'Boot' }, { key: 'description', label: 'Description', wrap: true },
      ],
      rows, sort, filterText: search.value, empty: 'No matching services',
      rowActions: isAdmin ? (r) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
        r.active === 'active' ? h('button', { class: 'sm', onclick: () => act_(r.unit, 'restart') }, 'Restart') : h('button', { class: 'sm', onclick: () => act_(r.unit, 'start') }, 'Start'),
        r.active === 'active' ? h('button', { class: 'sm danger', onclick: () => act_(r.unit, 'stop') }, 'Stop') : null,
        h('button', { class: 'sm', onclick: () => act_(r.unit, r.enabled === 'enabled' ? 'disable' : 'enable') }, r.enabled === 'enabled' ? 'Disable' : 'Enable')) : null,
    }));
  }
  async function load() {
    const r = await api('/api/services');
    if (!r.available) { holder.replaceChildren(h('div', { class: 'notice' }, `systemd is not available on this host. ${r.error || ''}`)); return; }
    list = r.list; draw();
  }
  poll(load, 10000);
  return h('div', {}, pageHeader('Services', 'systemd units'), h('div', { class: 'toolbar' }, search, only), holder);
}

// ---------------------------------------------------------------- docker
function pageDocker() {
  const isAdmin = state.user.role === 'admin';
  const cBox = h('div', { class: 'card' }), iBox = h('div', { class: 'card', style: { marginTop: '14px' } });
  async function dact(id, action) {
    if (['stop', 'kill', 'rm', 'restart'].includes(action) && !(await confirmDialog(`${action} container?`, id, action))) return;
    try { await api('/api/docker/action', { method: 'POST', body: { id, action } }); toast(`${action}: ok`); load(); } catch (e) { fail(e); }
  }
  async function logs(c) {
    try { const r = await api(`/api/docker/logs?id=${encodeURIComponent(c.id)}&lines=500`); modal(`Logs — ${c.name}`, h('pre', { class: 'out' }, r.output || '(empty)'), { wide: true, actions: [{ label: 'Close', onclick: (x) => x() }] }); } catch (e) { fail(e); }
  }
  async function load() {
    const r = await api('/api/docker');
    if (!r.available) { cBox.replaceChildren(h('div', { class: 'notice' }, `Docker is unavailable: ${r.error}`)); iBox.replaceChildren(); return; }
    cBox.replaceChildren(h('h2', {}, `Containers (${r.containers.length})`), dataTable({
      columns: [
        { key: 'name', label: 'Name' }, { key: 'image', label: 'Image' },
        { key: 'state', label: 'State', render: (c) => h('span', { class: 'badge ' + (c.state === 'running' ? 'ok' : c.state === 'exited' ? '' : 'warn') }, c.state) },
        { key: 'status', label: 'Status' }, { key: 'cpu', label: 'CPU', num: true }, { key: 'mem', label: 'Memory', num: true }, { key: 'ports', label: 'Ports', wrap: true },
      ],
      rows: r.containers, empty: 'No containers',
      rowActions: (c) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
        isAdmin ? h('button', { class: 'sm', onclick: () => logs(c) }, 'Logs') : null,
        ...(isAdmin ? (c.state === 'running' ? [h('button', { class: 'sm', onclick: () => dact(c.id, 'restart') }, 'Restart'), h('button', { class: 'sm danger', onclick: () => dact(c.id, 'stop') }, 'Stop')]
          : [h('button', { class: 'sm', onclick: () => dact(c.id, 'start') }, 'Start'), h('button', { class: 'sm danger', onclick: () => dact(c.id, 'rm') }, 'Remove')]) : [])),
    }));
    iBox.replaceChildren(h('h2', {}, `Images (${r.images.length})`), dataTable({
      columns: [{ key: 'repo', label: 'Repository' }, { key: 'tag', label: 'Tag' }, { key: 'id', label: 'ID' }, { key: 'size', label: 'Size', num: true }, { key: 'created', label: 'Created' }],
      rows: r.images, empty: 'No images',
    }));
  }
  poll(load, 8000);
  return h('div', {}, pageHeader('Docker', 'Containers and images'), cBox, iBox);
}

// ---------------------------------------------------------------- network
function pageNetwork() {
  const portsBox = h('div', { class: 'card' }), ifBox = h('div', { class: 'card' });
  const search = h('input', { class: 'grow', placeholder: 'Filter ports / processes…', oninput: () => draw() });
  let ports = [];
  const sort = { key: 'local', dir: 'asc', onSort(k) { sort.dir = sort.key === k && sort.dir === 'asc' ? 'desc' : 'asc'; sort.key = k; draw(); } };
  function draw() {
    portsBox.replaceChildren(h('h2', {}, 'Listening sockets'), dataTable({
      columns: [{ key: 'proto', label: 'Proto' }, { key: 'local', label: 'Local address' }, { key: 'state', label: 'State' }, { key: 'process', label: 'Process' }, { key: 'pid', label: 'PID', num: true }],
      rows: ports, sort, filterText: search.value, empty: 'No listening sockets found',
    }));
  }
  (async () => {
    try {
      const [p, s] = await Promise.all([api('/api/network/ports'), api('/api/system')]);
      ifBox.replaceChildren(h('h2', {}, 'Interfaces'), dataTable({
        columns: [{ key: 'name', label: 'Name' }, { key: 'address', label: 'Address' }, { key: 'family', label: 'Family' }, { key: 'mac', label: 'MAC' }],
        rows: s.info.interfaces.filter((i) => !i.internal), empty: 'No interfaces',
      }));
      if (!p.available) portsBox.replaceChildren(h('div', { class: 'notice' }, 'The `ss` command is not available on this host.'));
      else { ports = p.list; draw(); }
    } catch (e) { fail(e); }
  })();
  return h('div', {}, pageHeader('Network', 'Interfaces and listening ports'), ifBox, h('div', { style: { height: '14px' } }), h('div', { class: 'toolbar' }, search), portsBox);
}

// ---------------------------------------------------------------- files
function pageFiles() {
  const root = h('div', {});
  let cwd = sessionStorageGet('panel-cwd') || '/';
  const crumbs = h('div', { class: 'crumbs' });
  const listBox = h('div', { class: 'card' });
  const join = (a, b) => (a === '/' ? '' : a) + '/' + b;
  const parent = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';

  async function go(path) {
    try {
      const r = await api('/api/files/list?path=' + encodeURIComponent(path));
      cwd = r.path; sessionStoragePut('panel-cwd', cwd);
      drawCrumbs();
      listBox.replaceChildren(dataTable({
        columns: [
          { key: 'name', label: 'Name', render: (e) => e.type === 'dir'
            ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); go(join(cwd, e.name)); } }, '📁 ' + e.name)
            : h('a', { href: '#', onclick: (ev) => { ev.preventDefault(e.type === 'file' ? edit(join(cwd, e.name)) : go(join(cwd, e.name)).catch(() => {})); } }, (e.type === 'link' ? '🔗 ' : '📄 ') + e.name) },
          { key: 'size', label: 'Size', num: true, render: (e) => (e.type === 'dir' ? '–' : fmt.bytes(e.size)) },
          { key: 'mode', label: 'Mode' }, { key: 'mtime', label: 'Modified', render: (e) => fmt.date(e.mtime) },
        ],
        rows: r.entries, sort: { key: 'name', dir: 'asc', onSort() {} }, empty: 'This folder is empty',
        rowActions: (e) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
          e.type === 'file' ? h('a', { class: 'btn sm', style: { textDecoration: 'none', fontSize: '12px', padding: '3px 9px' }, href: '/api/files/download?path=' + encodeURIComponent(join(cwd, e.name)) }, 'Download') : null,
          h('button', { class: 'sm', onclick: () => rename(e) }, 'Rename'),
          h('button', { class: 'sm', onclick: () => chmod(e) }, 'chmod'),
          h('button', { class: 'sm danger', onclick: () => del(e) }, 'Delete')),
      }));
    } catch (e) { fail(e); if (cwd !== '/') { cwd = '/'; go('/'); } }
  }
  function drawCrumbs() {
    const parts = cwd.split('/').filter(Boolean);
    let acc = '';
    crumbs.replaceChildren(h('a', { onclick: () => go('/') }, '⌂ root'), ...parts.flatMap((p) => { acc += '/' + p; const target = acc; return [h('span', { class: 'muted' }, '/'), h('a', { onclick: () => go(target) }, p)]; }));
  }
  async function edit(path) {
    let data;
    try { data = await api('/api/files/read?path=' + encodeURIComponent(path)); } catch (e) { return fail(e); }
    const ta = h('textarea', { class: 'editor', spellcheck: false, value: data.content });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('\t', s, ta.selectionEnd, 'end'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save.click(); }
    });
    const save = h('button', { class: 'primary' }, 'Save');
    save.onclick = act(save, async () => { await api('/api/files/write', { method: 'PUT', body: { path, content: ta.value } }); toast('Saved'); });
    modal(path, ta, { wide: true, actions: [{ label: 'Close', onclick: (c) => c() }] });
    document.querySelector('.modal .actions').prepend(save);
  }
  async function rename(e) {
    const to = await promptDialog('Rename', 'New path', join(cwd, e.name));
    if (to) try { await api('/api/files/rename', { method: 'POST', body: { from: join(cwd, e.name), to } }); go(cwd); } catch (x) { fail(x); }
  }
  async function chmod(e) {
    const mode = await promptDialog('Change permissions', 'Octal mode (e.g. 644)', e.mode);
    if (mode) try { await api('/api/files/chmod', { method: 'POST', body: { path: join(cwd, e.name), mode } }); go(cwd); } catch (x) { fail(x); }
  }
  async function del(e) {
    if (!(await confirmDialog('Delete?', `${join(cwd, e.name)}${e.type === 'dir' ? ' and everything inside it' : ''} will be permanently deleted.`, 'Delete'))) return;
    try { await api('/api/files/delete', { method: 'POST', body: { path: join(cwd, e.name) } }); go(cwd); } catch (x) { fail(x); }
  }
  async function newItem(kind) {
    const name = await promptDialog(kind === 'dir' ? 'New folder' : 'New file', 'Name');
    if (!name) return;
    try {
      if (kind === 'dir') await api('/api/files/mkdir', { method: 'POST', body: { path: join(cwd, name) } });
      else await api('/api/files/write', { method: 'PUT', body: { path: join(cwd, name), content: '' } });
      go(cwd);
    } catch (x) { fail(x); }
  }
  async function upload(files) {
    for (const f of files) {
      try { await api(`/api/files/upload?path=${encodeURIComponent(cwd)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f }); toast(`Uploaded ${f.name}`); } catch (x) { fail(x); }
    }
    go(cwd);
  }
  const picker = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: () => upload([...picker.files]) });
  const drop = h('div', { class: 'dropzone hidden' }, 'Drop files to upload to the current folder');
  root.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.remove('hidden'); });
  root.addEventListener('dragleave', (e) => { if (e.target === drop) drop.classList.add('hidden'); });
  root.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.add('hidden'); upload([...e.dataTransfer.files]); });
  root.append(pageHeader('Files', 'Browse and edit files inside the configured root'),
    h('div', { class: 'toolbar' }, crumbs, h('span', { class: 'grow' }),
      h('button', { onclick: () => go(parent(cwd)) }, '↑ Up'), h('button', { onclick: () => go(cwd) }, 'Refresh'),
      h('button', { onclick: () => newItem('file') }, 'New file'), h('button', { onclick: () => newItem('dir') }, 'New folder'),
      h('button', { class: 'primary', onclick: () => picker.click() }, 'Upload'), picker),
    drop, listBox);
  go(cwd);
  return root;
}
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStoragePut(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------------------------------------------------------------- logs
function pageLogs() {
  const out = h('pre', { class: 'out' }, 'Select a log source…');
  const mode = h('select', { onchange: () => { sync(); load(); } }, h('option', { value: 'journal' }, 'systemd journal'), h('option', { value: 'file' }, 'Log file'));
  const fileSel = h('select', { class: 'hidden', onchange: load });
  const unit = h('input', { placeholder: 'Unit (e.g. nginx.service)', onchange: load });
  const prio = h('select', { onchange: load }, [['', 'Any priority'], ['err', 'Errors'], ['warning', 'Warnings+'], ['info', 'Info+']].map(([v, l]) => h('option', { value: v }, l)));
  const lines = h('select', { onchange: load }, [200, 500, 1000, 3000].map((n) => h('option', { value: n }, `${n} lines`)));
  const filter = h('input', { class: 'grow', placeholder: 'Filter text…', oninput: () => { clearTimeout(filter.t); filter.t = setTimeout(load, 350); } });
  const follow = h('input', { type: 'checkbox', onchange: () => {} });
  function sync() { const j = mode.value === 'journal'; fileSel.classList.toggle('hidden', j); unit.classList.toggle('hidden', !j); prio.classList.toggle('hidden', !j); }
  async function load() {
    try {
      let r;
      if (mode.value === 'journal') r = await api(`/api/logs/journal?lines=${lines.value}&unit=${encodeURIComponent(unit.value)}&priority=${prio.value}&q=${encodeURIComponent(filter.value)}`);
      else { if (!fileSel.value) return; r = await api(`/api/logs/file?path=${encodeURIComponent(fileSel.value)}&lines=${lines.value}&q=${encodeURIComponent(filter.value)}`); }
      const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.textContent = r.output || '(no matching lines)';
      if (atBottom || !out.dataset.seen) { out.scrollTop = out.scrollHeight; out.dataset.seen = '1'; }
    } catch (e) { out.textContent = e.message; }
  }
  (async () => {
    try {
      const s = await api('/api/logs/sources');
      fileSel.replaceChildren(...s.files.map((f) => h('option', { value: f.path }, `${f.path} (${fmt.bytes(f.size)})`)));
      if (!s.journal) { mode.value = 'file'; mode.querySelector('option[value=journal]').disabled = true; }
      sync(); load();
    } catch (e) { fail(e); }
  })();
  poll(() => (follow.checked ? load() : null), 3000);
  return h('div', {}, pageHeader('Logs', 'Journal and log files'),
    h('div', { class: 'toolbar' }, mode, fileSel, unit, prio, lines, filter, h('label', { class: 'row' }, follow, 'Follow'), h('button', { onclick: load }, 'Refresh')), out);
}

// ---------------------------------------------------------------- cron
function pageCron() {
  const ta = h('textarea', { class: 'editor', spellcheck: false, style: { minHeight: '40vh' } });
  const info = h('div', { class: 'notice', style: { marginBottom: '12px' } }, 'Edits the crontab of the user running the panel. Format: minute hour day-of-month month day-of-week command');
  const save = h('button', { class: 'primary' }, 'Save crontab');
  save.onclick = act(save, async () => { await api('/api/cron', { method: 'PUT', body: { content: ta.value } }); toast('Crontab saved'); });
  (async () => {
    try { const r = await api('/api/cron'); if (!r.available) { ta.disabled = true; save.disabled = true; info.textContent = 'crontab is not installed on this host.'; } ta.value = r.content; } catch (e) { fail(e); }
  })();
  const examples = h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '12px' } }, 'Examples: ', h('code', {}, '*/5 * * * * /usr/local/bin/task.sh'), ' · ', h('code', {}, '0 3 * * 1 /usr/bin/backup'), ' · ', h('code', {}, '@reboot /opt/start.sh'));
  return h('div', {}, pageHeader('Cron jobs', null, save), info, ta, examples);
}

// ---------------------------------------------------------------- terminal
function pageTerminal() {
  const out = h('div', { class: 'terminal-out', style: { minHeight: '40vh' }, tabindex: 0 });
  const input = h('input', { class: 'grow mono', placeholder: state.features.exec ? 'Run a command (non-interactive, 30 s timeout)…' : 'Command execution is disabled on this server', disabled: !state.features.exec, autocomplete: 'off', spellcheck: false });
  const history = JSON.parse(sessionStorageGet('panel-hist') || '[]');
  let hi = history.length;
  const line = (cls, text) => out.append(h('div', { class: cls }, text));
  async function runIt() {
    const cmd = input.value.trim();
    if (!cmd) return;
    history.push(cmd); hi = history.length; sessionStoragePut('panel-hist', JSON.stringify(history.slice(-100)));
    input.value = ''; line('cmd', `$ ${cmd}`); input.disabled = true;
    try {
      const r = await api('/api/exec', { method: 'POST', body: { command: cmd } });
      if (r.output) line('', r.output.replace(/\n$/, ''));
      line('meta', `exit ${r.code ?? r.signal ?? '?'} · ${r.ms} ms${r.timedOut ? ' · TIMED OUT' : ''}${r.truncated ? ' · output truncated' : ''}`);
    } catch (e) { line('err', e.message); }
    input.disabled = false; input.focus(); out.scrollTop = out.scrollHeight;
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runIt();
    else if (e.key === 'ArrowUp' && history.length) { hi = Math.max(0, hi - 1); input.value = history[hi]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(history.length, hi + 1); input.value = history[hi] || ''; e.preventDefault(); }
  });
  line('meta', 'Each command runs in a fresh bash process (no TTY). Every command is recorded in the audit log.');
  return h('div', {}, pageHeader('Terminal', 'One-shot command runner', h('button', { onclick: () => out.replaceChildren() }, 'Clear')),
    out, h('div', { class: 'row grow', style: { marginTop: '10px' } }, h('span', { class: 'mono muted' }, '$'), input, h('button', { class: 'primary', onclick: runIt }, 'Run')));
}

// ---------------------------------------------------------------- users
function pageUsers() {
  const box = h('div', { class: 'card' });
  async function load() {
    const r = await api('/api/users');
    box.replaceChildren(dataTable({
      columns: [{ key: 'username', label: 'Username' }, { key: 'role', label: 'Role', render: (u) => h('span', { class: 'badge ' + (u.role === 'admin' ? 'warn' : '') }, u.role) }, { key: 'created', label: 'Created', render: (u) => fmt.date(Date.parse(u.created)) }],
      rows: r.users,
      rowActions: (u) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
        h('button', { class: 'sm', onclick: async () => { const pw = await promptDialog(`New password for ${u.username}`, 'At least 10 characters', '', { type: 'password' }); if (pw) try { await api('/api/users/password', { method: 'POST', body: { id: u.id, password: pw } }); toast('Password updated'); } catch (e) { fail(e); } } }, 'Reset password'),
        u.id === state.user.id ? null : h('button', { class: 'sm danger', onclick: async () => { if (await confirmDialog('Delete user?', u.username, 'Delete')) try { await api('/api/users?id=' + encodeURIComponent(u.id), { method: 'DELETE' }); load(); } catch (e) { fail(e); } } }, 'Delete')),
    }));
  }
  function add() {
    const un = h('input'), pw = h('input', { type: 'password', autocomplete: 'new-password' });
    const role = h('select', {}, h('option', { value: 'viewer' }, 'Viewer (read-only monitoring)'), h('option', { value: 'admin' }, 'Admin (full control)'));
    modal('Add user', h('div', {}, h('div', { class: 'field' }, h('label', {}, 'Username'), un), h('div', { class: 'field' }, h('label', {}, 'Password (min 10)'), pw), h('div', { class: 'field' }, h('label', {}, 'Role'), role)), {
      actions: [{ label: 'Cancel', onclick: (c) => c() }, { label: 'Create', cls: 'primary', onclick: async (c) => { try { await api('/api/users', { method: 'POST', body: { username: un.value, password: pw.value, role: role.value } }); c(); load(); } catch (e) { fail(e); } } }],
    });
  }
  load().catch(fail);
  return h('div', {}, pageHeader('Users', 'Viewers can monitor; admins can change things', h('button', { class: 'primary', onclick: add }, 'Add user')), box);
}

// ---------------------------------------------------------------- audit
function pageAudit() {
  const box = h('div', { class: 'card' });
  const search = h('input', { class: 'grow', placeholder: 'Filter…', oninput: () => draw() });
  let rows = [];
  function draw() {
    box.replaceChildren(dataTable({
      columns: [{ key: 'ts', label: 'Time', render: (r) => fmt.date(Date.parse(r.ts)) }, { key: 'user', label: 'User' }, { key: 'action', label: 'Action', render: (r) => h('span', { class: 'badge ' + (r.action === 'login_failed' ? 'bad' : '') }, r.action) }, { key: 'detail', label: 'Detail', wrap: true }, { key: 'ip', label: 'IP' }],
      rows, filterText: search.value, empty: 'No audit entries yet',
    }));
  }
  async function load() { rows = (await api('/api/audit?limit=500')).entries; draw(); }
  poll(load, 10000);
  return h('div', {}, pageHeader('Audit log', 'Sign-ins and every state-changing action'), h('div', { class: 'toolbar' }, search), box);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  try { const t = localStorage.getItem('panel-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
  try {
    const s = await api('/api/session');
    state.user = s.user; state.setupRequired = s.setupRequired; state.features = s.features;
  } catch (e) { toast(e.message, true); }
  window.addEventListener('hashchange', render);
  render();
})();
