'use strict';
/* Domains pages: nginx status, domain list, domain detail (checks, certificate, configuration, logs). Uses helpers from deploy.js. */

const certBadge = (c) => {
  if (!c) return h('span', { class: 'badge' }, 'no HTTPS');
  if (c.present === false) return h('span', { class: 'badge bad', title: c.error || '' }, 'certificate missing');
  const d = c.daysLeft;
  return h('span', { class: 'badge ' + (d === null ? '' : d < 0 ? 'bad' : d < 14 ? 'warn' : 'ok') }, d === null ? 'HTTPS' : d < 0 ? 'expired' : `HTTPS · ${d}d left`);
};

const verdictInfo = {
  ok: ['ok', 'DNS points at this server'], mismatch: ['bad', 'DNS points somewhere else'], none: ['bad', 'No DNS record found'],
  error: ['warn', 'DNS lookup failed'], unknown: ['warn', 'Could not compare with this server'],
};

// ---------------------------------------------------------------- nginx status card
function nginxCard(onChange) {
  const box = h('div', { class: 'card', style: { marginBottom: '14px' } });
  async function load() {
    let s;
    try { s = await api('/api/nginx/status'); } catch (e) { box.replaceChildren(h('h2', {}, 'nginx'), h('div', { class: 'notice' }, e.message)); return; }
    const admin = isAdminUser();
    const btn = (label, path, msg) => { const b = h('button', { class: 'sm', cmd: 'nginx -t   # checks the configuration first\nsystemctl reload nginx   # only if the check passed' }, label); b.onclick = act(b, async () => { const r = await api(path, { method: 'POST', body: {} }); toast(msg(r)); await load(); if (onChange) onChange(); }); return b; };
    if (!s.installed) {
      box.replaceChildren(h('h2', {}, 'nginx'), h('div', { class: 'alert' }, 'nginx is not installed on this server. '), h('a', { href: '#/deploy' }, 'Install it from Deploy → Server readiness'));
      return;
    }
    box.replaceChildren(
      h('h2', {}, 'nginx', h('span', { class: 'row' }, admin ? h('button', { class: 'sm', cmd: 'panel: opens the files in /etc/nginx for editing. Saving runs nginx -t and rolls back if it fails.', onclick: () => nginxFilesDialog(load) }, 'Edit config files…') : null, admin ? btn('Test & reload', '/api/nginx/reload', () => 'Configuration is valid and nginx was reloaded') : null)),
      h('div', { class: 'chips' },
        h('span', { class: 'chip ' + (s.active ? 'ok' : 'bad') }, s.active ? '✓ running' : '✕ not running', h('span', { class: 'muted' }, ` v${s.version}`)),
        h('span', { class: 'chip ' + (s.configOk ? 'ok' : 'bad') }, s.configOk ? '✓ config valid' : '✕ config invalid'),
        h('span', { class: 'chip ' + (s.renewalTimer ? 'ok' : 'bad') }, s.renewalTimer ? '✓ certificate auto-renewal on' : '✕ certificate auto-renewal off')),
      !s.configOk ? h('pre', { class: 'out', style: { marginTop: '10px' } }, s.configOutput) : null,
      !s.renewalTimer ? h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12.5px' } }, 'Install certbot from Deploy → Server readiness to enable the twice-daily renewal timer.') : null);
  }
  load();
  return box;
}

// ---------------------------------------------------------------- nginx config files (nginx.conf + conf.d)
function nginxFilesDialog(onSaved) {
  let files = []; let current = null; let original = '';
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '210px', maxHeight: '55vh', overflowY: 'auto' } });
  const area = h('textarea', { class: 'editor', spellcheck: false, disabled: true, style: { minHeight: '50vh', whiteSpace: 'pre' }, placeholder: 'Choose a file on the left.' });
  const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap', maxHeight: '160px', overflow: 'auto' } });
  const title = h('div', { class: 'mono muted', style: { marginBottom: '6px', minHeight: '18px' } });
  const save = h('button', { class: 'primary', disabled: true, cmd: 'cp <file> <file>.bak   # backup\ntee <file>   # writes your text\nnginx -t   # on failure the backup is restored\nsystemctl reload nginx' }, 'Save & reload');
  const del = h('button', { class: 'danger hidden', cmd: 'rm /etc/nginx/conf.d/<file>\nnginx -t && systemctl reload nginx' }, 'Delete file');
  const show = (m) => { err.textContent = m || ''; err.classList.toggle('hidden', !m); };

  async function refresh(select) {
    files = (await api('/api/nginx/files')).files;
    drawList();
    if (select) await open(select);
  }
  function drawList() {
    list.replaceChildren(...files.map((f) => h('button', { class: 'sm', style: { textAlign: 'left', fontWeight: current && current.name === f.name ? '700' : '400', borderColor: current && current.name === f.name ? 'var(--accent)' : '' }, onclick: () => open(f.name) },
      f.name, f.main ? ' ★' : '', f.managed ? h('span', { class: 'muted' }, ' (managed)') : '')));
  }
  async function open(name) {
    show('');
    try {
      const r = await api(`/api/nginx/file?name=${encodeURIComponent(name)}`);
      current = { name, managed: r.managed }; original = r.content;
      area.value = r.content; area.disabled = r.managed; save.disabled = r.managed;
      del.classList.toggle('hidden', r.managed || name === 'nginx.conf');
      title.textContent = r.managed ? `${name} — generated by the panel (read-only; edit the domain instead)` : name;
      drawList();
    } catch (e) { show(e.message); }
  }
  save.onclick = act(save, async () => {
    show('');
    try {
      const r = await api('/api/nginx/file', { method: 'PUT', body: { name: current.name, content: area.value } });
      original = area.value; toast(`${current.name} saved — nginx validated and reloaded${r.created ? ' (new file)' : ''}`);
      await refresh(); if (onSaved) onSaved();
    } catch (e) { show(e.message); }
  });
  del.onclick = async () => {
    if (!(await confirmDialog('Delete file?', `${current.name} will be removed and nginx reloaded. If nginx rejects the result the file is restored.`, 'Delete'))) return;
    try { await api(`/api/nginx/file?name=${encodeURIComponent(current.name)}`, { method: 'DELETE' }); toast('Deleted'); current = null; area.value = ''; area.disabled = true; save.disabled = true; del.classList.add('hidden'); title.textContent = ''; await refresh(); if (onSaved) onSaved(); } catch (e) { show(e.message); }
  };
  const newFile = h('button', { class: 'sm', cmd: 'panel: starts a new empty file. It is only written when you save.' }, '+ New file');
  newFile.onclick = async () => {
    const name = await promptDialog('New nginx file', 'File name inside conf.d (e.g. redirects.conf)', 'custom.conf');
    if (!name) return;
    current = { name, managed: false }; original = ''; area.value = '# server { … }\n'; area.disabled = false; save.disabled = false; del.classList.add('hidden'); title.textContent = `${name} (new — created when you save)`; area.focus();
  };
  const close = modal('nginx configuration files', h('div', {},
    h('div', { class: 'muted', style: { marginBottom: '10px' } }, 'Every save is checked with nginx -t first. If nginx rejects it, the previous content is restored and the error is shown here. A .panel-bak copy of the previous version is kept next to the file.'),
    err,
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(180px, 230px) 1fr', gap: '14px' } }, h('div', {}, list, h('div', { style: { marginTop: '8px' } }, newFile)), h('div', {}, title, area)),
    h('div', { class: 'actions' }, del, h('button', { onclick: () => close() }, 'Close'), save)), { wide: true });
  refresh('nginx.conf').catch((e) => show(e.message));
}

// ---------------------------------------------------------------- existing nginx sites found on the server
function discoveryCard(onAdopted) {
  const box = h('div', { class: 'card', style: { marginBottom: '14px' } });
  async function load() {
    const r = await api('/api/nginx/discover');
    const rows = r.sites.filter((x) => !x.adopted);
    if (!rows.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.replaceChildren(h('h2', {}, `Existing nginx sites found on this server (${rows.length})`),
      h('div', { class: 'muted', style: { marginBottom: '10px' } }, 'These files were not created by the panel. Adding one keeps the file exactly as it is (same name, same content): you get DNS and HTTPS checks, certificate status and a validated editor, and nothing is rewritten.'),
      dataTable({
        columns: [
          { key: 'names', label: 'Domains', render: (x) => x.names.join(', ') },
          { key: 'kind', label: 'Type', render: (x) => (x.laravelPath ? h('span', {}, h('span', { class: 'badge ok' }, 'PHP / Laravel'), ' ', h('span', { class: 'mono muted' }, x.laravelPath)) : x.kind === 'php' ? 'PHP' : x.kind === 'proxy' ? `proxy → ${x.target}` : x.kind === 'static' ? `static: ${x.root}` : x.kind) },
          { key: 'https', label: 'HTTPS', render: (x) => h('span', { class: 'badge ' + (x.https ? 'ok' : '') }, x.https ? 'yes' : 'no') },
          { key: 'file', label: 'File', render: (x) => h('code', {}, x.file) },
        ], rows, empty: '',
        rowActions: (x) => { const b = h('button', { class: 'sm primary', cmd: 'panel: starts managing this existing nginx site. The file on the server is left exactly as it is.' }, 'Add to panel'); b.onclick = act(b, async () => { const a = await api('/api/sites/adopt', { method: 'POST', body: { file: x.file } }); toast(`${a.site.domain} added; the file was not changed`); onAdopted(a.site); }); return b; },
      }));
  }
  load().catch(() => box.classList.add('hidden'));
  return box;
}

function showWarnings(list) {
  if (!list || !list.length) return;
  modal('Heads up', h('div', {}, ...list.map((w) => h('div', { class: 'alert warn', style: { marginBottom: '8px' } }, w))), { actions: [{ label: 'OK', cls: 'primary', onclick: (c) => c() }] });
}

/** Look inside the folder: the panel picks the web root, the type (PHP / static) and the framework's nginx settings. */
function folderChecker(f, field) {
  const msg = h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '4px 0 10px' } });
  const btn = h('button', { type: 'button', cmd: 'test -e <folder>/artisan; test -e <folder>/public/index.php; test -e <folder>/wp-config.php; ...   # only looks, changes nothing' }, 'Check folder');
  btn.onclick = act(btn, async () => {
    msg.textContent = 'Looking inside the folder…';
    const r = await api('/api/sites/inspect-folder', { method: 'POST', body: { path: f[field].value.trim() } });
    msg.textContent = r.note;
    if (!r.root) return;
    f._framework = ['laravel', 'symfony', 'codeigniter', 'wordpress', 'php'].includes(r.kind) ? r.kind : 'php';
    if (r.mode === 'php') { f.phpRoot.value = r.root; if (f.type.value !== 'php') { f.type.value = 'php'; f.type.dispatchEvent(new Event('change')); } }
    else { f.root.value = r.root; f.spa.checked = !!r.spa; if (f.type.value !== 'static') { f.type.value = 'static'; f.type.dispatchEvent(new Event('change')); } }
  });
  return h('div', {}, h('div', { class: 'row' }, btn), msg);
}

/** Pick a port that something on the server is already listening on (Docker containers show up here too). */
function portPicker(urlInput) {
  const sel = h('select', {}, h('option', { value: '' }, 'Looking for running apps…'));
  api('/api/network/ports').then((r) => {
    const seen = new Set(); const opts = [];
    for (const x of r.list || []) {
      if (!/^tcp/.test(x.proto) || x.state !== 'LISTEN') continue;
      const port = Number((x.local.match(/:(\d+)$/) || [])[1]); if (!port || [22, 25, 80, 443, 3306, 5432, 6379, 53].includes(port) || seen.has(port)) continue;
      seen.add(port); opts.push([port, x.process || '']);
    }
    opts.sort((a, b) => a[0] - b[0]);
    sel.replaceChildren(h('option', { value: '' }, opts.length ? 'Pick a running app…' : 'No running apps found'), ...opts.map(([p, n]) => h('option', { value: p }, `port ${p}${n ? ` — ${n === 'docker-proxy' ? 'Docker container' : n}` : ''}`)));
  }).catch(() => sel.replaceChildren(h('option', { value: '' }, 'Could not list running apps')));
  sel.onchange = () => { if (sel.value) urlInput.value = `http://127.0.0.1:${sel.value}`; };
  return h('div', { class: 'field' }, h('label', {}, 'Or choose from what is running on this server'), sel);
}

/** Fill the folder from an existing (adopted) Laravel app. */
function laravelPicker(rootInput) {
  const sel = h('select', {}, h('option', { value: '' }, 'Looking for Laravel apps…'));
  api('/api/laravel').then((r) => {
    sel.replaceChildren(h('option', { value: '' }, r.apps.length ? 'Or pick an existing Laravel app…' : 'No Laravel apps added yet'), ...r.apps.map((a) => h('option', { value: `${a.path.replace(/\/+$/, '')}/public` }, `${a.name} (${a.path})`)));
  }).catch(() => sel.replaceChildren(h('option', { value: '' }, '')));
  sel.onchange = () => { if (sel.value) rootInput.value = sel.value; };
  return h('div', { class: 'field' }, sel);
}

// ---------------------------------------------------------------- add / configure form
function siteForm(site, apps) {
  const s = site || { aliases: [], upstream: { type: 'app' }, forceHttps: true, hsts: false, maxBodyMb: 10, customConfig: '' };
  const u = s.upstream || { type: 'app' };
  const f = {
    domain: h('input', { value: s.domain || '', placeholder: 'app.example.com', disabled: !!site }),
    aliases: h('input', { value: (s.aliases || []).join(', '), placeholder: 'www.example.com, other.example.com' }),
    type: h('select', {}, [...(u.type === 'external' ? [['external', 'Existing nginx setup (kept as it is)']] : []), ['app', 'An app deployed with the panel'], ['url', 'Any app running on a port (Node, Java, Docker, Python, …)'], ['php', 'A PHP / Laravel folder'], ['static', 'Static files'], ['redirect', 'Redirect to another address']].map(([v, l]) => h('option', { value: v, selected: v === u.type }, l))),
    appId: h('select', {}, apps.length ? apps.map((a) => h('option', { value: a.id, selected: a.id === u.appId }, `${a.name} (${a.mode === 'service' ? `port ${a.port}` : a.mode === 'static' ? 'static website' : 'PHP'})`)) : h('option', { value: '' }, 'No apps on this server')),
    url: h('input', { value: u.url || 'http://127.0.0.1:3000' }),
    root: h('input', { value: u.root || '/var/www/site' }),
    phpRoot: h('input', { value: u.type === 'php' ? u.root : '/var/www/site' }),
    redirectUrl: h('input', { value: u.url && u.type === 'redirect' ? u.url : 'https://www.example.com' }),
    permanent: h('input', { type: 'checkbox', checked: u.permanent !== false }),
    spa: h('input', { type: 'checkbox', checked: !!u.spa }),
    forceHttps: h('input', { type: 'checkbox', checked: s.forceHttps !== false }),
    hsts: h('input', { type: 'checkbox', checked: !!s.hsts }),
    maxBodyMb: h('input', { type: 'number', min: 1, max: 2048, value: s.maxBodyMb || 10 }),
    customConfig: h('textarea', { rows: 6, spellcheck: false, value: s.customConfig || '', placeholder: '# extra nginx directives inside the server block, e.g.\nadd_header X-Frame-Options SAMEORIGIN always;\nlocation /static/ { expires 7d; }' }),
  };
  f._framework = u.framework;
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('div', { class: 'muted', style: { fontSize: '12px' } }, hint) : null);
  const target = h('div', {});
  const sync = () => {
    const t = f.type.value;
    target.replaceChildren(t === 'external' ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } }, `This site was added from an nginx file you wrote by hand (${u.kind || 'existing config'}${u.root ? `: ${u.root}` : u.target ? `: ${u.target}` : ''}). The panel keeps that file exactly as it is. Pick another option here only if you want the panel to generate the nginx configuration for this domain instead.`) : t === 'app' ? field('App', f.appId, 'The panel sets up the right nginx configuration for the app type (reverse proxy, static files or PHP-FPM) and follows it if the app changes.')
      : t === 'url' ? h('div', {}, field('Address of the app', f.url, 'For example http://127.0.0.1:8080. Works for anything that listens on a port: Node, Java, Python, Go, .NET, a Docker container…'), portPicker(f.url))
        : t === 'php' ? h('div', {}, field('Web folder of the PHP app', f.phpRoot, 'Type the app’s folder (for example /var/www/q-app) and press “Check folder”: the panel finds the right web folder (Laravel’s public/, WordPress, plain PHP) and the matching nginx settings.'), folderChecker(f, 'phpRoot'), laravelPicker(f.phpRoot))
          : t === 'redirect' ? h('div', {}, field('Send visitors to', f.redirectUrl, 'The path they asked for is kept, e.g. old.com/about → https://new.com/about'), h('label', { class: 'row' }, f.permanent, 'Permanent redirect (301). Untick for a temporary one (302).'))
        : h('div', {}, field('Folder on the server', f.root, 'nginx must be able to read it. Press “Check folder” to find the built site inside an app folder.'), folderChecker(f, 'root'), h('label', { class: 'row' }, f.spa, 'Single-page app (serve index.html for unknown paths)')));
  };
  f.type.addEventListener('change', sync); sync();
  const el = h('div', {},
    field('Domain', f.domain, site ? 'The primary domain cannot be changed. Add a new domain instead.' : 'Must already (or soon) point at this server — you can check DNS afterwards.'),
    field('Alias domains (optional)', f.aliases, 'Comma separated, e.g. www.example.com. They are included in the certificate.'),
    field('Send traffic to', f.type), target,
    h('div', { class: 'grid2' }, field('Max upload size (MB)', f.maxBodyMb), h('div', {}, h('label', { class: 'row', style: { margin: '24px 0 6px' } }, f.forceHttps, 'Redirect HTTP → HTTPS once a certificate exists'), h('label', { class: 'row' }, f.hsts, 'Send HSTS header (browsers will insist on HTTPS)'))),
    h('details', { class: 'adv', open: !!s.customConfig }, h('summary', {}, 'Custom nginx directives (advanced)'), f.customConfig,
      h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Validated with nginx -t before anything is applied; a bad config is rejected and the old one restored.')));
  const read = () => {
    const t = f.type.value;
    const body = {
      aliases: f.aliases.value, forceHttps: f.forceHttps.checked, hsts: f.hsts.checked, maxBodyMb: Number(f.maxBodyMb.value), customConfig: f.customConfig.value,
      upstream: t === 'external' ? undefined : t === 'app' ? { type: 'app', appId: f.appId.value } : t === 'url' ? { type: 'url', url: f.url.value.trim() } : t === 'php' ? { type: 'php', root: f.phpRoot.value.trim(), framework: f._framework || 'php' } : t === 'redirect' ? { type: 'redirect', url: f.redirectUrl.value.trim(), permanent: f.permanent.checked } : { type: 'static', root: f.root.value.trim(), spa: f.spa.checked },
    };
    if (!site) body.domain = f.domain.value.trim();
    return body;
  };
  return { el, read };
}

// ---------------------------------------------------------------- list page
function pageDomains() {
  const arg = routeArgs()[0];
  if (arg) return pageDomainDetail(arg);
  const admin = isAdminUser();
  const box = h('div', { class: 'card' });
  let apps = [];
  async function load() {
    const [r, a] = await Promise.all([api('/api/sites'), api('/api/apps')]);
    apps = a.apps;
    const rows = r.sites;
    box.replaceChildren(h('h2', {}, `Domains (${rows.length})`), rows.length ? dataTable({
      columns: [
        { key: 'domain', label: 'Domain', render: (x) => h('span', {}, h('a', { href: `#/domains/${x.id}` }, x.domain), x.aliases.length ? h('span', { class: 'muted' }, ` +${x.aliases.length}`) : null) },
        { key: 'upstreamLabel', label: 'Serves' },
        { key: 'tls', label: 'HTTPS', sortable: false, render: (x) => { const holder = h('span', {}, x.tls ? h('span', { class: 'badge ok' }, 'HTTPS') : h('span', { class: 'badge' }, 'no HTTPS')); if (x.tls) api(`/api/sites/detail?id=${x.id}`).then((d) => holder.replaceChildren(certBadge(d.status && d.status.certificate))).catch(() => {}); return holder; } },
      ],
      rows, empty: '', rowActions: (x) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
        h('a', { class: 'btn sm', style: { textDecoration: 'none', fontSize: '12px', padding: '3px 9px' }, href: `${x.tls ? 'https' : 'http'}://${x.domain}`, target: '_blank', rel: 'noopener noreferrer' }, 'Visit ↗'),
        h('button', { class: 'sm', onclick: () => { location.hash = `#/domains/${x.id}`; } }, 'Manage')),
    }) : h('div', { class: 'empty' }, admin ? 'No domains yet. Add one to put an app or website behind nginx with HTTPS.' : 'No domains yet.'));
  }
  load().catch(fail);
  const add = () => {
    const form = siteForm(null, apps);
    const err = h('div', { class: 'alert crit hidden', role: 'alert' });
    const create = h('button', { class: 'primary', cmd: 'tee /etc/nginx/conf.d/panel-<domain>.conf   # the generated site\nnginx -t   # rolled back if it fails\nsystemctl reload nginx' }, 'Add domain');
    const close = modal('Add domain', h('div', {}, err, form.el, h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), create)), { wide: true });
    create.onclick = act(create, async () => {
      err.classList.add('hidden');
      try { const r = await api('/api/sites', { method: 'POST', body: form.read() }); close(); showWarnings(r.warnings); toast(`${r.site.domain} added and nginx reloaded`); location.hash = `#/domains/${r.site.id}`; }
      catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    });
  };
  return h('div', {}, pageHeader('Domains', `nginx sites, HTTPS certificates and DNS checks on ${(currentServer() || {}).name || 'this server'}`, admin ? h('button', { class: 'primary', cmd: 'panel: opens the form. Nothing runs until you press Add domain inside it.', onclick: add }, 'Add domain') : null),
    nginxCard(() => load().catch(() => {})), admin ? discoveryCard((site) => { location.hash = `#/domains/${site.id}`; }) : '', box);
}

// ---------------------------------------------------------------- detail page
function pageDomainDetail(id) {
  const root = h('div', {});
  const head = h('div', {});
  const content = h('div', {});
  root.append(head, content);
  let data = null; let tabId = 'overview'; let apps = [];
  const checks = { dns: null, http: null, running: false };

  async function load(rerender = true) {
    const [d, a] = await Promise.all([api(`/api/sites/detail?id=${encodeURIComponent(id)}`), api('/api/apps').catch(() => ({ apps: [] }))]);
    data = d; apps = a.apps;
    drawHead();
    if (rerender) drawTabs();
  }

  function drawHead() {
    const { site } = data;
    head.replaceChildren(h('div', { class: 'muted', style: { marginBottom: '6px' } }, h('a', { href: '#/domains' }, '← All domains')),
      pageHeader(site.domain, `${site.upstreamLabel}${site.aliases.length ? ` · aliases: ${site.aliases.join(', ')}` : ''}`,
        certBadge(data.status && data.status.certificate),
        h('a', { class: 'btn', style: { textDecoration: 'none' }, href: `${site.tls ? 'https' : 'http'}://${site.domain}`, target: '_blank', rel: 'noopener noreferrer' }, 'Visit ↗')));
  }

  function drawTabs() {
    content.replaceChildren(tabs([
      { id: 'overview', label: 'Overview & checks', render: overview },
      { id: 'config', label: 'Configuration', render: configuration },
      ...(isAdminUser() ? [{ id: 'logs', label: 'Logs', render: logs }] : []),
    ], tabId, (p) => { tabId = p; }));
  }

  // ---- checks
  function checklist() {
    const { site, status } = data;
    const cert = status && status.certificate;
    const dns = checks.dns && checks.dns.reports[0];
    const http = checks.http;
    const step = (state, title, detail) => h('li', {}, h('span', { class: 'dot ' + state }, state === 'ok' ? '✓' : state === 'bad' ? '✕' : state === 'warn' ? '!' : '·'), h('div', {}, h('strong', {}, title), detail ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, detail) : null));
    const dnsState = !dns ? ['', 'DNS', 'Run the checks to compare DNS with this server.'] : [verdictInfo[dns.verdict][0], verdictInfo[dns.verdict][1], dns.notes[0] || null];
    const direct = http && http.direct;
    const viaDns = http && http.viaDns;
    const httpOk = direct && direct.http.ok;
    return h('ol', { class: 'step-list' },
      step(...dnsState),
      step(!http ? '' : httpOk ? 'ok' : 'bad', 'Server answers on port 80', !http ? null : httpOk ? `nginx replied ${direct.http.status} directly from the server` : (direct ? direct.http.error : 'No server IP known to test directly')),
      step(!cert ? '' : cert.present === false ? 'bad' : cert.daysLeft !== null && cert.daysLeft < 14 ? 'warn' : 'ok', 'HTTPS certificate', cert ? (cert.present === false ? cert.error : `${cert.issuer || 'certificate'} · expires in ${cert.daysLeft} days${cert.staging ? ' (STAGING: browsers will not trust it)' : ''}`) : 'None yet — issue one below once DNS and port 80 work.'),
      step(!viaDns ? '' : viaDns.https.ok && viaDns.https.cert && viaDns.https.cert.authorized ? 'ok' : cert ? 'warn' : '', 'Reachable over HTTPS from the internet', !viaDns ? null : viaDns.https.ok ? (viaDns.https.cert && viaDns.https.cert.authorized ? `${viaDns.https.status} in ${viaDns.https.ms} ms, trusted certificate` : 'Reachable, but the certificate is not trusted') : viaDns.https.error));
  }

  function dnsPanel() {
    const r = checks.dns;
    if (!r) return null;
    const rows = [];
    for (const rep of r.reports) for (const res of rep.resolvers) rows.push({ name: rep.domain, resolver: res.name, a: res.a.join(', ') || '–', aaaa: res.aaaa.join(', ') || '–', cname: res.cname.join(', ') || '–', err: res.error });
    const first = r.reports[0];
    return h('div', { class: 'card', style: { marginTop: '14px' } },
      h('h2', {}, 'DNS', h('span', { class: 'muted' }, r.serverIps.length ? `this server: ${r.serverIps.join(', ')}` : 'server IP unknown')),
      r.reports.map((rep) => h('div', {}, h('span', { class: 'badge ' + verdictInfo[rep.verdict][0] }, `${rep.domain}: ${verdictInfo[rep.verdict][1]}`), rep.notes.length ? h('ul', { class: 'note-list' }, rep.notes.map((n) => h('li', {}, n))) : null)),
      h('div', { style: { marginTop: '12px' } }, dataTable({ columns: [{ key: 'name', label: 'Name' }, { key: 'resolver', label: 'Resolver' }, { key: 'a', label: 'A' }, { key: 'aaaa', label: 'AAAA' }, { key: 'cname', label: 'CNAME' }], rows, empty: '' })),
      first && first.records ? h('div', { style: { marginTop: '12px' } }, kv([
        ['NS', (first.records.ns || []).join(', ') || '–'], ['MX', (first.records.mx || []).map((m) => `${m.priority} ${m.exchange}`).join(', ') || '–'],
        ['TXT', (first.records.txt || []).length ? h('div', {}, first.records.txt.map((t) => h('div', { class: 'mono' }, t.slice(0, 200)))) : '–'],
        ['CAA', (first.records.caa || []).map((c) => `${c.tag} ${c.value}`).join(', ') || h('span', { class: 'muted' }, 'none (any CA may issue)')],
      ])) : null);
  }

  function httpPanel() {
    const r = checks.http;
    if (!r) return null;
    const col = (title, rep) => {
      if (!rep) return h('div', { class: 'card' }, h('h2', {}, title), h('div', { class: 'muted' }, 'Server IP unknown.'));
      const line = (label, x) => [label, x.ok ? h('span', {}, h('span', { class: 'badge ' + (x.status < 400 ? 'ok' : 'warn') }, x.status), x.location ? h('span', { class: 'muted' }, ` → ${x.location}`) : null, h('span', { class: 'muted' }, ` ${x.ms} ms`)) : h('span', { class: 'badge bad' }, x.error)];
      return h('div', { class: 'card' }, h('h2', {}, title), kv([
        line('http://', rep.http), line('https://', rep.https),
        rep.https.cert ? ['Certificate', h('span', {}, `${rep.https.cert.issuer || '?'} · ${rep.https.cert.daysLeft} days left · ${rep.https.cert.authorized ? 'trusted' : 'NOT trusted'}`)] : null,
        rep.https.hsts ? ['HSTS', rep.https.hsts] : null,
      ]), rep.notes.length ? h('ul', { class: 'note-list' }, rep.notes.map((n) => h('li', {}, n))) : null);
    };
    return h('div', { class: 'two', style: { marginTop: '14px' } }, col('HTTP(S) via public DNS', r.viaDns), col(`Directly to the server${r.serverIps[0] ? ` (${r.serverIps[0]})` : ''}`, r.direct));
  }

  function overview() {
    const wrap = h('div', {});
    const result = h('div', {});
    const run = h('button', { class: 'primary', cmd: 'panel: looks up DNS records (A, AAAA, CNAME, CAA) and requests the site over HTTP and HTTPS from the panel host. Nothing runs on the server.' }, checks.dns ? 'Re-run checks' : 'Run checks');
    const draw = () => {
      result.replaceChildren(dnsPanel() || '', httpPanel() || '');
      checkCard.replaceChildren(h('h2', {}, 'Setup checklist', run), checklist());
    };
    run.onclick = act(run, async () => {
      run.textContent = 'Checking…';
      try {
        const [dns, http] = await Promise.all([api(`/api/sites/dns?id=${id}`), api(`/api/sites/http?id=${id}`)]);
        checks.dns = dns; checks.http = http;
        await load(false); drawHead();
      } finally { run.textContent = 'Re-run checks'; draw(); }
    });
    const checkCard = h('div', { class: 'card' });
    wrap.append(checkCard, certCard(), result);
    draw();
    return wrap;
  }

  // ---- certificate
  function certCard() {
    const { site, status } = data;
    const cert = status && status.certificate;
    const admin = isAdminUser();
    const card = h('div', { class: 'card', style: { marginTop: '14px' } }, h('h2', {}, "HTTPS certificate (Let's Encrypt)", certBadge(cert)));
    if (site.tls && cert && cert.present) {
      card.append(kv([['Issuer', cert.issuer || '–'], ['Expires', cert.validTo ? `${fmt.date(cert.validTo)} (${cert.daysLeft} days)` : '–'], ['Covers', (cert.names || []).join(', ')], ['Type', site.tls.staging ? h('span', { class: 'badge warn' }, 'STAGING (test certificate, not trusted by browsers)') : 'Production'], ['Contact', site.tls.email]]),
        h('div', { class: 'muted', style: { margin: '8px 0', fontSize: '12.5px' } }, 'Renewed automatically by the certbot timer twice a day when due (30 days before expiry).'));
      if (admin) card.append(h('div', { class: 'row' },
        (() => { const b = h('button', { cmd: 'certbot renew --cert-name <domain> --force-renewal --non-interactive\nsystemctl reload nginx   # via the deploy hook' }, 'Renew now'); b.onclick = act(b, async () => { const r = await api('/api/sites/cert/renew', { method: 'POST', body: { id } }); toast('Certificate renewed'); await load(); modal('certbot output', h('pre', { class: 'out' }, r.output), { wide: true, actions: [{ label: 'Close', onclick: (c) => c() }] }); }); return b; })(),
        site.tls.staging ? (() => { const b = h('button', { class: 'primary', cmd: 'panel: opens the certificate request form' }, 'Replace with a real certificate'); b.onclick = () => issueDialog(); return b; })() : null,
        h('button', { class: 'danger', cmd: 'certbot delete --cert-name <domain> --non-interactive\nrewrites the site as HTTP-only; nginx -t && systemctl reload nginx', onclick: async () => { if (await confirmDialog('Remove certificate?', `${site.domain} will be served over HTTP only until you issue a new certificate.`, 'Remove')) try { await api('/api/sites/cert/remove', { method: 'POST', body: { id } }); toast('Certificate removed'); await load(); } catch (e) { fail(e); } } }, 'Remove certificate')));
    } else {
      card.append(h('div', { class: 'muted', style: { marginBottom: '10px' } }, 'No certificate yet. Before issuing: the domain’s DNS must point at this server and port 80 must be open in the security group — run the checks above first. Let’s Encrypt validates over HTTP on port 80.'));
      if (admin) card.append(h('button', { class: 'primary', cmd: 'panel: opens the certificate request form', onclick: () => issueDialog() }, 'Issue certificate…'));
      else card.append(h('div', { class: 'muted' }, 'An administrator can issue the certificate.'));
    }
    return card;
  }

  function issueDialog() {
    let saved = '';
    try { saved = localStorage.getItem('panel-le-email') || ''; } catch { /* ignore */ }
    const email = h('input', { type: 'email', value: saved, placeholder: 'you@example.com' });
    const staging = h('input', { type: 'checkbox' });
    const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap' } });
    const go = h('button', { class: 'primary', cmd: 'certbot certonly --webroot -w <acme folder> --cert-name <domain> -d <domain> [-d <alias>] --email <you> --agree-tos --non-interactive --deploy-hook "systemctl reload nginx"\nthen rewrites the site for HTTPS; nginx -t && systemctl reload nginx' }, 'Request certificate');
    const close = modal('Issue certificate', h('div', {}, err,
      h('div', { class: 'field' }, h('label', {}, 'Email for expiry notices'), email),
      h('label', { class: 'row' }, staging, 'Use the Let’s Encrypt staging server (test run: no rate limits, but the certificate is not trusted)'),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, `Covers ${[data.site.domain, ...data.site.aliases].join(', ')}. Takes up to a minute.`),
      h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), go)));
    go.onclick = act(go, async () => {
      err.classList.add('hidden'); go.textContent = 'Requesting…';
      try {
        const r = await api('/api/sites/cert/issue', { method: 'POST', body: { id, email: email.value.trim(), staging: staging.checked } });
        try { localStorage.setItem('panel-le-email', email.value.trim()); } catch { /* ignore */ }
        close(); toast('Certificate issued and HTTPS enabled'); await load(); void r;
      } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); } finally { go.textContent = 'Request certificate'; }
    });
  }

  // ---- configuration
  function configuration() {
    const { site, status } = data;
    const admin = isAdminUser();
    const form = siteForm(site, apps);
    const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap' } });
    const save = h('button', { class: 'primary', cmd: 'tee /etc/nginx/conf.d/panel-<domain>.conf   # regenerated from these settings\nnginx -t   # the previous file is restored if it fails\nsystemctl reload nginx' }, 'Save & apply');
    save.onclick = act(save, async () => {
      err.classList.add('hidden');
      try { const body = form.read();
        if (site.manual && body.upstream) {
          if (!(await confirmDialog('Let the panel generate the nginx file?', 'This domain currently uses an nginx file written by hand. Choosing a new target replaces it with a file generated by the panel (matching the framework). Your original file is saved next to it as “….original-before-panel”.', 'Generate', false))) return;
          body.rawConfig = null;
        }
        const sv = await api('/api/sites', { method: 'PUT', body: { id, ...body } }); showWarnings(sv.warnings); toast('Saved. nginx reloaded.'); await load(); } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    });
    const generated = { text: '' };
    const right = h('div', { class: 'card' });
    function drawRight(editing) {
      const manual = !!site.manual;
      const badge = status && status.configPresent ? h('span', { class: 'badge ' + (sync ? 'ok' : 'warn') }, sync ? 'in sync with server' : 'differs from server') : h('span', { class: 'badge bad' }, 'not on server');
      if (!admin) { right.replaceChildren(h('h2', {}, 'nginx configuration', badge), h('div', { class: 'muted' }, manual ? 'This domain uses a manually edited nginx file.' : 'Generated from the domain’s settings.'), h('div', { class: 'muted' }, 'Administrators can view and edit the file.')); return; }
      if (editing) {
        const area = h('textarea', { class: 'editor', spellcheck: false, style: { minHeight: '46vh', whiteSpace: 'pre' }, value: manual ? site.rawConfig : generated.text });
        const e2 = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap', maxHeight: '180px', overflow: 'auto' } });
        const saveRaw = h('button', { class: 'primary', cmd: 'tee /etc/nginx/conf.d/panel-<domain>.conf   # exactly your text\nnginx -t   # the previous file is restored if it fails\nsystemctl reload nginx' }, 'Save file & apply');
        saveRaw.onclick = act(saveRaw, async () => {
          e2.classList.add('hidden');
          try { await api('/api/sites', { method: 'PUT', body: { id, rawConfig: area.value } }); toast('Manual configuration applied. nginx validated and reloaded.'); await load(); } catch (er) { e2.textContent = er.message; e2.classList.remove('hidden'); }
        });
        right.replaceChildren(h('h2', {}, 'Edit nginx file', h('span', { class: 'badge warn' }, 'manual mode')),
          h('div', { class: 'muted', style: { marginBottom: '8px', fontSize: '12.5px' } }, 'You are editing the whole file for this domain. The panel will write it exactly as typed (validated with nginx -t; rejected edits are rolled back). In manual mode, domain, upstream, HTTPS and certificate settings no longer change the file — you maintain them here. Keep the /.well-known/acme-challenge/ location if you use Let’s Encrypt.'),
          e2, area, h('div', { class: 'row', style: { marginTop: '10px' } }, saveRaw, h('button', { onclick: () => drawRight(false) }, 'Cancel')));
        return;
      }
      const pre = h('pre', { class: 'out', style: { maxHeight: '45vh' } }, manual ? site.rawConfig : generated.text || 'Loading…');
      right.replaceChildren(h('h2', {}, manual ? 'nginx file (manual)' : 'Generated nginx config', h('span', { class: 'row' }, badge, manual ? h('span', { class: 'badge warn' }, 'manual mode') : null)),
        pre,
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'primary', disabled: !manual && !generated.text, onclick: () => drawRight(true) }, manual ? 'Edit file' : 'Edit full config manually…'),
          !sync && status && status.configPresent ? reapply : null,
          manual ? h('button', { onclick: async () => { if (await confirmDialog('Switch back to generated?', 'Your manual nginx file is discarded and the configuration is regenerated from this domain’s settings.', 'Switch back', false)) try { await api('/api/sites', { method: 'PUT', body: { id, rawConfig: null } }); toast('Using the generated configuration again'); await load(); } catch (er) { fail(er); } } }, 'Switch back to generated') : null),
        h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, manual ? 'Settings on the left (aliases, upstream, HTTPS) do not affect this file while manual mode is on.' : 'The panel owns this file. Use the settings on the left, “custom directives”, or manual mode; hand edits on the server are flagged and overwritten on the next apply.'));
    }
    if (admin) api(`/api/sites/config?id=${id}`).then((r) => { generated.text = r.config; drawRight(false); }).catch((e) => { generated.text = e.message; drawRight(false); });
    const reapply = h('button', { cmd: 'tee /etc/nginx/conf.d/panel-<domain>.conf   # rewrites the generated file\nnginx -t && systemctl reload nginx' }, 'Re-apply to server');
    reapply.onclick = act(reapply, async () => { await api('/api/sites/apply', { method: 'POST', body: { id } }); toast('Configuration re-applied'); await load(); });
    const del = h('button', { class: 'danger', cmd: 'rm /etc/nginx/conf.d/panel-<domain>.conf\nnginx -t && systemctl reload nginx\ncertbot delete --cert-name <domain>   # only if you tick it' }, 'Delete domain…');
    del.onclick = () => {
      const cert = h('input', { type: 'checkbox', checked: !!site.tls });
      modal(`Delete ${site.domain}?`, h('div', {}, h('p', {}, 'The nginx site is removed and nginx reloaded. The app and its files are not touched.'), site.tls ? h('label', { class: 'row' }, cert, 'Also delete its certificate') : null),
        { actions: [{ label: 'Cancel', onclick: (c) => c() }, { label: 'Delete', cls: 'danger', onclick: async (c) => { try { await api(`/api/sites?id=${id}${cert.checked ? '&removeCert=1' : ''}`, { method: 'DELETE' }); c(); toast('Domain deleted'); location.hash = '#/domains'; } catch (e) { fail(e); } } }] });
    };
    const sync = status && status.inSync;
    drawRight(false);
    return h('div', { class: 'two' },
      h('div', { class: 'card' }, h('h2', {}, 'Settings'), admin ? h('div', {}, err, form.el, h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '12px' } }, save, del)) : kv([['Domain', site.domain], ['Aliases', site.aliases.join(', ') || '–'], ['Serves', site.upstreamLabel], ['Max upload', `${site.maxBodyMb} MB`], ['Force HTTPS', site.forceHttps ? 'yes' : 'no']])),
      right);
  }

  // ---- logs
  function logs() {
    const out = h('pre', { class: 'out' }, 'Loading…');
    const kind = h('select', { onchange: refresh }, [['access', 'Access log'], ['error', 'Error log']].map(([v, l]) => h('option', { value: v }, l)));
    const lines = h('select', { onchange: refresh }, [100, 200, 500, 1000].map((n) => h('option', { value: n, selected: n === 200 }, `${n} lines`)));
    const follow = h('input', { type: 'checkbox' });
    async function refresh() {
      const r = await api(`/api/sites/logs?id=${id}&kind=${kind.value}&lines=${lines.value}`);
      const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.textContent = r.output || '(empty)';
      if (atEnd) out.scrollTop = out.scrollHeight;
    }
    poll(() => (follow.checked ? refresh() : null), 3000);
    refresh().catch((e) => { out.textContent = e.message; });
    return h('div', {}, h('div', { class: 'toolbar' }, kind, lines, h('label', { class: 'row' }, follow, 'Follow'), h('button', { cmd: 'tail -c 2097152 /var/log/nginx/<domain>.access.log   # or the error log', onclick: () => refresh().catch(fail) }, 'Refresh')), out);
  }

  load().catch((e) => { root.replaceChildren(h('div', { class: 'notice' }, e.message), h('p', {}, h('a', { href: '#/domains' }, '← Back to domains'))); });
  return root;
}
