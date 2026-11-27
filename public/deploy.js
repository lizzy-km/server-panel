'use strict';
/* Deploy pages: server readiness, app list, app detail (overview, history, releases, environment, settings, logs). */

// ---------------------------------------------------------------- shared helpers (also used by domains.js)
const shortSha = (s) => (s ? s.slice(0, 7) : '–');
const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso))) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const duration = (a, b) => (b ? `${Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000))}s` : '');
const isAdminUser = () => state.user && state.user.role === 'admin';

function deployBadge(status) {
  const map = { success: ['ok', 'success'], failed: ['bad', 'failed'], rolled_back: ['warn', 'rolled back'], running: ['', 'running…'], interrupted: ['warn', 'interrupted'] };
  const [cls, label] = map[status] || ['', status || 'never deployed'];
  return h('span', { class: 'badge ' + cls }, status === 'running' ? [h('span', { class: 'spin' }), label] : label);
}

/** Tab strip. Polls/cleanups registered while a tab renders are stopped when you switch away from it. */
function tabs(defs, initial, onSelect) {
  const body = h('div', {});
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const buttons = {};
  let tabCleanups = [];
  function select(id) {
    tabCleanups.forEach((f) => f()); tabCleanups = [];
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle('active', k === id);
    body.replaceChildren();
    const mark = cleanups.length;
    const def = defs.find((d) => d.id === id);
    try { body.append(def.render()); } catch (e) { body.append(h('div', { class: 'notice' }, e.message)); }
    tabCleanups = cleanups.splice(mark); // only this tab's pollers; the page's own stay registered
    if (onSelect) onSelect(id);
  }
  for (const d of defs) { buttons[d.id] = h('button', { role: 'tab', onclick: () => select(d.id) }, d.label); bar.append(buttons[d.id]); }
  select(initial || defs[0].id);
  return h('div', {}, bar, body);
}

function copyRow(value, label) {
  const input = h('input', { value, readonly: true, onclick: () => input.select(), 'aria-label': label });
  return h('div', { class: 'copy-row' }, input, h('button', { class: 'sm', onclick: async () => { try { await navigator.clipboard.writeText(value); toast('Copied'); } catch { input.select(); toast('Press Ctrl+C to copy'); } } }, 'Copy'));
}

function kv(rows) {
  return h('div', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]));
}

/** Live log viewer for a deploy (id) or a provisioning job; polls until finished. */
function logModal(title, { url, onDone }) {
  const pre = h('pre', { class: 'out', style: { minHeight: '40vh' } }, '');
  const badge = h('span', {}, '');
  let offset = 0; let stopped = false; let followed = true;
  pre.addEventListener('scroll', () => { followed = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40; });
  const close = modal(title, h('div', {}, h('div', { style: { marginBottom: '8px' } }, badge), pre), { wide: true, actions: [{ label: 'Close', onclick: (c) => { stopped = true; c(); } }] });
  (async function loop() {
    while (!stopped && document.body.contains(pre)) {
      try {
        const r = await api(`${url}${url.includes('?') ? '&' : '?'}offset=${offset}`);
        if (r.text) { pre.textContent += r.text; if (followed) pre.scrollTop = pre.scrollHeight; }
        offset = r.offset;
        if (r.deploy) badge.replaceChildren(deployBadge(r.deploy.status));
        if (r.done && (!r.deploy || r.deploy.status !== 'running')) {
          if (!r.deploy) badge.replaceChildren(h('span', { class: 'badge ok' }, 'finished'));
          if (onDone) onDone(r.deploy || null);
          return;
        }
      } catch (e) { pre.textContent += `\n${e.message}\n`; return; }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }());
  return close;
}

const needsQuotes = (v) => v === '' ? false : /[\s"'#\\]|^\s|\s$/.test(v) || v.includes('\n');
/** vars -> editable NAME=value text. Values with spaces, quotes, # or newlines are written as "…" with \" \\ \n escapes. */
const serializeEnv = (vars) => Object.entries(vars).map(([k, v]) => (needsQuotes(v) ? `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : `${k}=${v}`)).join('\n');
/** NAME=value lines -> vars. Understands "double" (with escapes) and 'single' (literal) quotes, blank lines and # comments. */
const parseEnvLines = (text) => {
  const vars = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) throw new Error(`Each line must look like NAME=value: "${t.slice(0, 30)}"`);
    let v = t.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\n])/g, (m, c) => (c === 'n' ? '\n' : c));
    else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    vars[t.slice(0, i).trim()] = v;
  }
  return vars;
};

// ---------------------------------------------------------------- readiness (prepare server)
function readinessCard() {
  const box = h('div', { class: 'card', style: { marginBottom: '14px' } });
  async function load() {
    box.replaceChildren(h('h2', {}, 'Server readiness'), h('div', { class: 'muted' }, 'Checking…'));
    let r;
    try { r = await api('/api/provision/status'); } catch (e) { box.replaceChildren(h('h2', {}, 'Server readiness'), h('div', { class: 'notice' }, e.message)); return; }
    const labels = { git: 'git', node: 'Node.js', npm: 'npm', nginx: 'nginx', certbot: 'certbot', curl: 'curl' };
    const missing = ['git', 'node', 'nginx', 'certbot'].filter((t) => !r.tools[t].installed);
    box.replaceChildren(
      h('h2', {}, 'Server readiness', isAdminUser() && missing.length ? h('button', { class: 'sm primary', onclick: () => installDialog(missing, load) }, 'Install missing…') : h('button', { class: 'sm', onclick: load }, 'Re-check')),
      h('div', { class: 'chips' }, Object.entries(labels).map(([k, label]) => h('span', { class: 'chip ' + (r.tools[k].installed ? 'ok' : 'bad') }, r.tools[k].installed ? '✓' : '✕', ` ${label}`, r.tools[k].version ? h('span', { class: 'muted' }, ` ${r.tools[k].version}`) : null)),
        h('span', { class: 'chip ' + (r.sudo === 'no' ? 'bad' : 'ok') }, r.sudo === 'no' ? '✕ passwordless sudo' : '✓ ' + (r.sudo === 'root' ? 'root' : 'sudo'))),
      r.sudo === 'no' ? h('div', { class: 'alert', style: { marginTop: '10px' } }, `User “${r.user}” has no passwordless sudo, so deploys cannot create services and nginx/certificates cannot be managed.`) : null,
      missing.length && !isAdminUser() ? h('div', { class: 'muted', style: { marginTop: '8px' } }, 'Ask an administrator to install the missing tools.') : null);
  }
  load();
  return box;
}

function installDialog(missing, onFinished) {
  const names = { git: 'git (clone repositories)', node: 'Node.js + npm (build and run apps)', nginx: 'nginx (web server / reverse proxy)', certbot: "certbot (free Let's Encrypt certificates, auto-renewal)" };
  const boxes = Object.fromEntries(missing.map((t) => [t, h('input', { type: 'checkbox', checked: true })]));
  const body = h('div', {}, h('p', { class: 'muted' }, 'Installs with dnf on Amazon Linux 2023. This changes the server; nginx is started and enabled. Remember to open ports 80 and 443 in the instance’s security group.'),
    missing.map((t) => h('label', { class: 'row', style: { margin: '6px 0' } }, boxes[t], names[t])));
  modal('Prepare server', body, { actions: [{ label: 'Cancel', onclick: (c) => c() }, { label: 'Install', cls: 'primary', onclick: async (c) => {
    const tools = missing.filter((t) => boxes[t].checked);
    if (!tools.length) return;
    try { const r = await api('/api/provision/install', { method: 'POST', body: { tools } }); c(); logModal('Installing ' + tools.join(', '), { url: `/api/jobs/log?id=${r.id}`, onDone: onFinished }); } catch (e) { fail(e); }
  } }] });
}

// ---------------------------------------------------------------- app form (create + settings)
function appForm(app, apps) {
  const isNew = !app;
  const a = app || { branch: 'main', authType: 'none', healthPath: '/', healthTimeout: 30, keepReleases: 5, tokenUser: 'x-access-token' };
  const f = {
    name: h('input', { value: a.name || '', placeholder: 'my-app', disabled: !isNew }),
    repoUrl: h('input', { value: a.repoUrl || '', placeholder: 'https://github.com/org/repo.git or git@github.com:org/repo.git' }),
    branch: h('input', { value: a.branch }),
    authType: h('select', {}, [['none', 'Public repository (no credentials)'], ['token', 'Access token (HTTPS)'], ['key', 'Deploy key (SSH)']].map(([v, l]) => h('option', { value: v, selected: v === a.authType }, l))),
    tokenUser: h('input', { value: a.tokenUser, placeholder: 'x-access-token' }),
    secret: h('textarea', { rows: 4, spellcheck: false, placeholder: a.hasGitSecret ? '(unchanged — paste to replace)' : '' }),
    port: h('input', { type: 'number', value: a.port || suggestPort(apps), min: 1024, max: 65535 }),
    installCmd: h('input', { value: a.installCmd || '', placeholder: 'default: npm ci (or npm install without a lockfile)' }),
    buildCmd: h('input', { value: a.buildCmd || '', placeholder: 'default: npm run build, if the project has a build script' }),
    startCmd: h('input', { value: a.startCmd || '', placeholder: 'default: npm start' }),
    healthPath: h('input', { value: a.healthPath }),
    healthTimeout: h('input', { type: 'number', value: a.healthTimeout, min: 5, max: 300 }),
    healthStrict: h('input', { type: 'checkbox', checked: !!a.healthStrict }),
    keepReleases: h('input', { type: 'number', value: a.keepReleases, min: 2, max: 30 }),
    runAs: h('input', { value: a.runAs || '', placeholder: 'default: the SSH user' }),
    extraPath: h('input', { value: a.extraPath || '', placeholder: 'e.g. /home/ec2-user/.nvm/versions/node/v22.0.0/bin' }),
    baseDir: h('input', { value: a.baseDir || '/srv/apps', disabled: !isNew }),
    env: h('textarea', { rows: 5, spellcheck: false, placeholder: 'NODE_OPTIONS=--max-old-space-size=512\nDATABASE_URL=postgres://…' }),
  };
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('div', { class: 'muted', style: { fontSize: '12px' } }, hint) : null);
  const secretBox = field('', h('div', {}));
  const syncAuth = () => {
    const t = f.authType.value;
    secretBox.replaceChildren(...(t === 'none' ? [] : [
      ...(t === 'token' ? [field('Token username', f.tokenUser, 'GitHub: x-access-token (fine-grained or classic personal access token with read access to the repo)')] : []),
      field(t === 'token' ? 'Access token' : 'Deploy key (private key)', f.secret, t === 'key' ? 'Add the matching public key as a read-only deploy key in the repository. It is stored encrypted and only written to the server for the duration of a clone.' : 'Stored encrypted. Never shown again.'),
    ]));
  };
  f.authType.addEventListener('change', syncAuth); syncAuth();
  const el = h('div', {},
    isNew ? h('div', { class: 'grid2' }, field('App name', f.name, 'Lowercase letters, digits, dashes'), field('Port', f.port, 'The port your app listens on (given as $PORT)')) : field('Port', f.port),
    field('Git repository URL', f.repoUrl),
    h('div', { class: 'grid2' }, field('Branch or tag', f.branch), field('Authentication', f.authType)),
    secretBox,
    h('details', { class: 'adv', open: isNew }, h('summary', {}, 'Build and run'),
      field('Install command', f.installCmd), field('Build command', f.buildCmd), field('Start command', f.startCmd, 'Runs from the release folder as a systemd service; your app must listen on $PORT')),
    h('details', { class: 'adv' }, h('summary', {}, 'Health check and releases'),
      h('div', { class: 'grid2' }, field('Health check path', f.healthPath), field('Wait up to (seconds)', f.healthTimeout)),
      h('label', { class: 'row', style: { margin: '4px 0 12px' } }, f.healthStrict, 'Require a 2xx/3xx answer (otherwise any answer below 500 counts as healthy)'),
      field('Releases to keep', f.keepReleases)),
    h('details', { class: 'adv' }, h('summary', {}, 'Advanced'),
      h('div', { class: 'grid2' }, field('Service user', f.runAs), field('Apps directory', f.baseDir)),
      field('Extra PATH (e.g. nvm node)', f.extraPath)),
    isNew ? field('Environment variables (optional)', f.env, 'One NAME=value per line. Stored encrypted; values are never shown again.') : null);
  const read = () => {
    const body = {
      repoUrl: f.repoUrl.value.trim(), branch: f.branch.value.trim(), authType: f.authType.value, port: Number(f.port.value),
      installCmd: f.installCmd.value, buildCmd: f.buildCmd.value, startCmd: f.startCmd.value, healthPath: f.healthPath.value.trim() || '/',
      healthTimeout: Number(f.healthTimeout.value), healthStrict: f.healthStrict.checked, keepReleases: Number(f.keepReleases.value),
      runAs: f.runAs.value.trim(), extraPath: f.extraPath.value.trim(),
    };
    if (isNew) { body.name = f.name.value.trim(); body.baseDir = f.baseDir.value.trim(); }
    if (body.authType === 'token') body.tokenUser = f.tokenUser.value.trim() || 'x-access-token';
    if (body.authType !== 'none' && f.secret.value.trim()) body.gitSecret = f.secret.value.trim();
    if (isNew) body.env = parseEnvLines(f.env.value);
    return body;
  };
  return { el, read };
}
const suggestPort = (apps) => { const used = new Set((apps || []).map((x) => x.port)); let p = 3000; while (used.has(p)) p += 1; return p; };

function newAppDialog(apps, onCreated) {
  const form = appForm(null, apps);
  const err = h('div', { class: 'alert crit hidden', role: 'alert' });
  const create = h('button', { class: 'primary' }, 'Create app');
  const close = modal('New app', h('div', {}, err, form.el, h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), create)), { wide: true });
  create.onclick = act(create, async () => {
    err.classList.add('hidden');
    try { const r = await api('/api/apps', { method: 'POST', body: form.read() }); close(); toast(`Created ${r.app.name}. Deploy it from the app page.`); onCreated(r.app); }
    catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
}

// ---------------------------------------------------------------- list page
function pageDeploy() {
  const arg = routeArgs()[0];
  if (arg) return pageAppDetail(arg);
  const admin = isAdminUser();
  const box = h('div', { class: 'card' });
  let apps = [];
  async function load() {
    const r = await api('/api/apps');
    apps = r.apps;
    box.replaceChildren(h('h2', {}, `Apps (${apps.length})`), apps.length ? dataTable({
      columns: [
        { key: 'name', label: 'App', render: (x) => h('a', { href: `#/deploy/${x.id}` }, x.name) },
        { key: 'repoUrl', label: 'Source', render: (x) => h('span', { class: 'mono' }, `${x.repoUrl.replace(/^https:\/\//, '').replace(/\.git$/, '')} @ ${x.branch}`) },
        { key: 'port', label: 'Port', num: true },
        { key: 'lastDeploy', label: 'Last deploy', sortable: false, render: (x) => (x.lastDeploy ? h('span', {}, deployBadge(x.lastDeploy.status), ' ', h('span', { class: 'muted' }, `${shortSha(x.lastDeploy.commit)} · ${ago(x.lastDeploy.startedAt)}`)) : h('span', { class: 'muted' }, 'never')) },
      ],
      rows: apps, empty: '',
      rowActions: (x) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
        admin ? (() => { const b = h('button', { class: 'sm primary', disabled: x.deploying }, x.deploying ? 'Deploying…' : 'Deploy'); b.onclick = act(b, () => deployNow(x, load)); return b; })() : null,
        h('button', { class: 'sm', onclick: () => { location.hash = `#/deploy/${x.id}`; } }, 'Open')),
    }) : h('div', { class: 'empty' }, admin ? 'No apps yet. Create one to deploy a Node.js project from Git.' : 'No apps yet.'));
  }
  poll(load, 8000);
  return h('div', {}, pageHeader('Deploy', `Node.js apps on ${(currentServer() || {}).name || 'this server'}: Git → build → zero-downtime switch → health check → auto-rollback`,
    admin ? h('button', { class: 'primary', onclick: () => newAppDialog(apps, (a) => { location.hash = `#/deploy/${a.id}`; }) }, 'New app') : null),
    readinessCard(), box);
}

async function deployNow(app, after) {
  const r = await api('/api/apps/deploy', { method: 'POST', body: { id: app.id } });
  logModal(`Deploying ${app.name}`, { url: `/api/deploys/log?id=${r.deploy.id}`, onDone: () => { if (after) after(); } });
}

// ---------------------------------------------------------------- app detail
function pageAppDetail(id) {
  const root = h('div', {});
  const head = h('div', {});
  const content = h('div', {});
  root.append(head, content);
  let data = null;
  let tabId = 'overview';

  async function load(rerender = true) {
    data = await api(`/api/apps/detail?id=${encodeURIComponent(id)}`);
    drawHead();
    if (rerender) drawTabs();
    return data;
  }

  function drawHead() {
    const { app, status } = data;
    const admin = isAdminUser();
    const act1 = (label, fn, cls = '') => { const b = h('button', { class: cls }, label); b.onclick = act(b, fn); return b; };
    head.replaceChildren(h('div', { class: 'muted', style: { marginBottom: '6px' } }, h('a', { href: '#/deploy' }, '← All apps')),
      pageHeader(app.name, `${app.repoUrl.replace(/\.git$/, '')} @ ${app.branch}`,
        h('span', { class: 'badge ' + (status.active === 'active' ? 'ok' : status.active === 'inactive' || status.active === 'failed' ? 'bad' : '') }, `service ${status.active}`),
        admin ? act1('Deploy now', async () => { await deployNow(app, () => load()); }, 'primary') : null,
        admin ? act1('Restart', async () => { await api('/api/apps/service', { method: 'POST', body: { id, action: 'restart' } }); toast('Restarted'); await load(false); drawHead(); }) : null,
        admin ? act1(status.active === 'active' ? 'Stop' : 'Start', async () => { await api('/api/apps/service', { method: 'POST', body: { id, action: status.active === 'active' ? 'stop' : 'start' } }); await load(false); drawHead(); }, status.active === 'active' ? 'danger' : '') : null));
  }

  function drawTabs() {
    content.replaceChildren(tabs([
      { id: 'overview', label: 'Overview', render: overview },
      { id: 'history', label: `History (${data.deploys.length})`, render: history },
      { id: 'releases', label: `Releases (${data.releases.length})`, render: releases },
      { id: 'env', label: `Environment (${data.app.envNames.length})`, render: environment },
      { id: 'settings', label: 'Settings', render: settings },
      ...(isAdminUser() ? [{ id: 'logs', label: 'Service logs', render: serviceLogs }] : []),
    ], tabId, (picked) => { tabId = picked; }));
  }

  function overview() {
    const { app, status, releases: rel, deploys, sites } = data;
    const current = rel.find((r) => r.current);
    const last = deploys[0];
    const webhook = isAdminUser() ? webhookCard() : null;
    return h('div', { class: 'two' },
      h('div', { class: 'card' }, h('h2', {}, 'Service'), kv([
        ['State', h('span', { class: 'badge ' + (status.active === 'active' ? 'ok' : 'bad') }, status.active)],
        ['Unit', h('code', {}, app.unit)], ['Since', status.since || '–'], ['PID', status.pid || '–'],
        ['Memory', status.memory ? fmt.bytes(status.memory) : '–'], ['Restarts', String(status.restarts)], ['Listens on', `127.0.0.1:${app.port}`],
        ['Domains', sites.length ? h('span', {}, sites.map((s, i) => [i ? ', ' : '', h('a', { href: `#/domains/${s.id}` }, s.domain), s.https ? ' 🔒' : ''])) : h('span', { class: 'muted' }, 'none yet — add one on the Domains page')],
      ])),
      h('div', { class: 'card' }, h('h2', {}, 'Current release'), current ? kv([
        ['Release', h('code', {}, current.id)], ['Commit', h('code', {}, shortSha(current.commit))], ['Created', ago(current.time)],
        last ? ['Last deploy', h('span', {}, deployBadge(last.status), ' ', ago(last.startedAt), last.user ? ` by ${last.user}` : '')] : null,
        last && last.message ? ['Message', last.message] : null,
        ['Health check', `${app.healthPath} (${app.healthStrict ? '2xx/3xx' : '<500'}, ≤${app.healthTimeout}s)`],
      ]) : h('div', { class: 'empty' }, 'Not deployed yet. Click “Deploy now”.')),
      webhook);
  }

  function webhookCard() {
    const { app, webhookUrl } = data;
    const card = h('div', { class: 'card', style: { gridColumn: '1 / -1' } }, h('h2', {}, 'Auto-deploy webhook',
      h('span', { class: 'row' },
        h('button', { class: 'sm', onclick: async () => { await api('/api/apps/webhook', { method: 'POST', body: { id, enabled: true } }); await load(); } }, webhookUrl ? 'Rotate secret' : 'Enable'),
        webhookUrl ? h('button', { class: 'sm danger', onclick: async () => { await api('/api/apps/webhook', { method: 'POST', body: { id, enabled: false } }); await load(); } }, 'Disable') : null)));
    if (!webhookUrl) { card.append(h('div', { class: 'muted' }, 'Off. Enable it to deploy automatically whenever you push to ', h('code', {}, app.branch), ' (GitHub webhook or any CI that can POST to a URL).')); return card; }
    const token = webhookUrl.split('/').pop();
    card.append(
      h('div', { class: 'field' }, h('label', {}, 'Payload URL'), copyRow(webhookUrl, 'Webhook URL')),
      h('div', { class: 'field' }, h('label', {}, 'Secret (for GitHub signature verification)'), copyRow(token, 'Webhook secret')),
      h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'GitHub: repository → Settings → Webhooks → Add webhook → paste the URL, content type ', h('code', {}, 'application/json'), ', paste the secret, “Just the push event”. Other CI: ', h('code', {}, 'curl -X POST <URL>'), '. Pushes to other branches are ignored. The panel must be reachable from the internet at this URL (set ', h('code', {}, 'PANEL_PUBLIC_URL'), ' behind a reverse proxy and only expose ', h('code', {}, '/api/hooks/'), ').'));
    return card;
  }

  function history() {
    const { deploys } = data;
    if (!deploys.length) return h('div', { class: 'card empty' }, 'No deploys yet.');
    return h('div', { class: 'card' }, dataTable({
      columns: [
        { key: 'startedAt', label: 'When', render: (d) => h('span', { title: fmt.date(Date.parse(d.startedAt)) }, ago(d.startedAt)) },
        { key: 'kind', label: 'Type', render: (d) => `${d.kind}${d.trigger === 'webhook' ? ' (webhook)' : ''}` },
        { key: 'ref', label: 'Ref', render: (d) => d.ref || '–' },
        { key: 'commit', label: 'Commit', render: (d) => h('span', {}, h('code', {}, shortSha(d.commit)), d.message ? h('span', { class: 'muted' }, ` ${d.message.slice(0, 50)}`) : null) },
        { key: 'status', label: 'Result', render: (d) => deployBadge(d.status) },
        { key: 'user', label: 'By' },
        { key: 'finishedAt', label: 'Took', render: (d) => duration(d.startedAt, d.finishedAt) },
      ],
      rows: deploys, empty: '', sort: { key: 'startedAt', dir: 'desc', onSort() {} },
      rowActions: isAdminUser() ? (d) => h('button', { class: 'sm', onclick: () => logModal(`${d.kind} ${shortSha(d.commit)} — ${d.status}`, { url: `/api/deploys/log?id=${d.id}` }) }, 'Log') : null,
    }));
  }

  function releases() {
    const { releases: rel } = data;
    if (!rel.length) return h('div', { class: 'card empty' }, 'No releases on the server yet.');
    return h('div', { class: 'card' }, h('div', { class: 'muted', style: { marginBottom: '8px' } }, `The newest ${data.app.keepReleases} releases are kept. Rolling back switches the live version and restarts the service, with a health check.`), dataTable({
      columns: [
        { key: 'id', label: 'Release', render: (r) => h('code', {}, r.id) },
        { key: 'commit', label: 'Commit', render: (r) => h('code', {}, shortSha(r.commit)) },
        { key: 'time', label: 'Created', render: (r) => ago(r.time) },
        { key: 'current', label: '', sortable: false, render: (r) => (r.current ? h('span', { class: 'badge ok' }, 'live') : '') },
      ],
      rows: rel, empty: '', sort: { key: 'time', dir: 'desc', onSort() {} },
      rowActions: isAdminUser() ? (r) => (r.current ? null : (() => { const b = h('button', { class: 'sm' }, 'Roll back to this'); b.onclick = act(b, async () => {
        if (!(await confirmDialog('Roll back?', `Make release ${r.id} (${shortSha(r.commit)}) live and restart ${data.app.name}.`, 'Roll back', false))) return;
        const d = await api('/api/apps/rollback', { method: 'POST', body: { id, release: r.id } });
        logModal(`Rolling back ${data.app.name}`, { url: `/api/deploys/log?id=${d.deploy.id}`, onDone: () => load() });
      }); return b; })()) : null,
    }));
  }

  function environment() {
    const { app } = data;
    const card = h('div', { class: 'card' });
    if (!isAdminUser()) {
      card.append(h('div', { class: 'muted', style: { marginBottom: '10px' } }, 'Variable names only; values are visible to administrators.'),
        app.envNames.length ? h('div', { class: 'chips' }, app.envNames.map((n) => h('span', { class: 'chip mono' }, n))) : h('div', { class: 'empty' }, 'No environment variables.'));
      return card;
    }
    const names = h('div', { class: 'chips', style: { marginBottom: '12px' } }, app.envNames.map((n) => h('span', { class: 'chip mono' }, n)));
    const area = h('textarea', { rows: 14, spellcheck: false, disabled: true, class: 'editor', style: { minHeight: '260px', whiteSpace: 'pre' }, placeholder: 'Values are hidden until you click “Reveal & edit”.' });
    const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap' } });
    const reveal = h('button', { class: 'primary' }, 'Reveal & edit');
    const save = h('button', { class: 'hidden' }, 'Save');
    const apply = h('button', { class: 'primary hidden' }, 'Save & apply now');
    const cancel = h('button', { class: 'hidden' }, 'Cancel');
    const show = (msg) => { err.textContent = msg; err.classList.toggle('hidden', !msg); };
    const lock = () => { area.disabled = true; area.value = ''; for (const b of [save, apply, cancel]) b.classList.add('hidden'); reveal.classList.remove('hidden'); show(''); };
    reveal.onclick = act(reveal, async () => {
      const r = await api(`/api/apps/env?id=${id}`);
      area.value = serializeEnv(r.vars); area.disabled = false; area.focus();
      reveal.classList.add('hidden'); for (const b of [save, apply, cancel]) b.classList.remove('hidden');
    });
    cancel.onclick = lock;
    const persist = async () => { show(''); const vars = parseEnvLines(area.value); const r = await api('/api/apps/env/save', { method: 'POST', body: { id, vars } }); data.app.envNames = r.names; names.replaceChildren(...r.names.map((n) => h('span', { class: 'chip mono' }, n))); return r; };
    save.onclick = act(save, async () => { try { await persist(); toast('Saved. Applies on the next deploy, or use “Save & apply now”.'); } catch (e) { show(e.message); } });
    apply.onclick = act(apply, async () => {
      try {
        await persist();
        apply.textContent = 'Restarting…';
        const r = await api('/api/apps/env/apply', { method: 'POST', body: { id } });
        toast('Saved and applied: the app restarted and is healthy'); void r; await load(false); drawHead();
      } catch (e) { show(e.message); } finally { apply.textContent = 'Save & apply now'; }
    });
    card.append(
      h('div', { class: 'muted', style: { marginBottom: '10px' } }, 'This is the app’s .env file: one NAME=value per line. Use "double quotes" for values with spaces, # or \\n for new lines. Revealing values is recorded in the audit log.'),
      names, err, area,
      h('div', { class: 'row', style: { marginTop: '12px' } }, reveal, save, apply, cancel),
      h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '12.5px' } }, h('strong', {}, 'Save'), ' stores the change for the next deploy. ', h('strong', {}, 'Save & apply now'), ' also writes the file to the server and restarts the service (no rebuild; variables used at build time, like NEXT_PUBLIC_*, need a redeploy). If the app does not become healthy you are told and can fix the values and apply again. ', h('code', {}, 'PORT'), ' and ', h('code', {}, 'NODE_ENV'), ' are set by the panel.'));
    return card;
  }

  function settings() {
    const { app } = data;
    const admin = isAdminUser();
    const form = appForm(app, []);
    const err = h('div', { class: 'alert crit hidden', role: 'alert' });
    const save = h('button', { class: 'primary' }, 'Save settings');
    save.onclick = act(save, async () => {
      err.classList.add('hidden');
      try { const body = form.read(); delete body.env; await api('/api/apps', { method: 'PUT', body: { id, ...body } }); toast('Saved. Settings apply on the next deploy.'); await load(); }
      catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    });
    const del = h('button', { class: 'danger' }, 'Delete app…');
    del.onclick = () => {
      const files = h('input', { type: 'checkbox' });
      const close = modal(`Delete ${app.name}?`, h('div', {}, h('p', {}, 'The service is stopped and removed. Domains that point at this app keep working against its port.'),
        h('label', { class: 'row' }, files, `Also delete ${app.baseDir}/${app.name} on the server (all releases and the environment file)`)),
      { actions: [{ label: 'Cancel', onclick: (c) => c() }, { label: 'Delete', cls: 'danger', onclick: async (c) => { try { await api(`/api/apps?id=${id}${files.checked ? '&deleteFiles=1' : ''}`, { method: 'DELETE' }); c(); toast('App deleted'); location.hash = '#/deploy'; } catch (e) { fail(e); } } }] });
      return close;
    };
    return h('div', { class: 'card' }, admin ? h('div', {}, err, form.el, h('div', { class: 'row', style: { marginTop: '12px', justifyContent: 'space-between' } }, save, del)) : kv([['Repository', app.repoUrl], ['Branch', app.branch], ['Port', app.port], ['Install', app.installCmd || 'default'], ['Build', app.buildCmd || 'default'], ['Start', app.startCmd || 'npm start'], ['Apps directory', `${app.baseDir}/${app.name}`]]));
  }

  function serviceLogs() {
    const out = h('pre', { class: 'out' }, 'Loading…');
    const lines = h('select', { onchange: refresh }, [100, 200, 500, 1000].map((n) => h('option', { value: n, selected: n === 200 }, `${n} lines`)));
    const follow = h('input', { type: 'checkbox', checked: true });
    async function refresh() {
      const r = await api(`/api/apps/logs?id=${id}&lines=${lines.value}`);
      const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.textContent = r.output || '(no output yet)';
      if (atEnd) out.scrollTop = out.scrollHeight;
    }
    poll(() => (follow.checked ? refresh() : null), 3000);
    refresh().catch((e) => { out.textContent = e.message; });
    return h('div', {}, h('div', { class: 'toolbar' }, lines, h('label', { class: 'row' }, follow, 'Follow'), h('button', { onclick: () => refresh().catch(fail) }, 'Refresh')), out);
  }

  load().catch((e) => { root.replaceChildren(h('div', { class: 'notice' }, e.message), h('p', {}, h('a', { href: '#/deploy' }, '← Back to apps'))); });
  poll(() => load(false), 10000);
  return root;
}
