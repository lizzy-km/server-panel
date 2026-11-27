'use strict';
/* Laravel (PHP) apps: adopt an existing install, then manage it (status, artisan, .env, logs). Uses helpers from deploy.js. */

// ---------------------------------------------------------------- adopt dialog
function adoptLaravelDialog(onAdopted, suggestions = []) {
  const name = h('input', { placeholder: 'q-app', value: 'q-app' });
  const path = h('input', { placeholder: '/var/www/q-app', value: (suggestions[0] && suggestions[0]) || '' });
  const result = h('div', { style: { marginTop: '10px' } });
  const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap' } });
  const detect = h('button', {}, 'Check folder');
  const adopt = h('button', { class: 'primary', disabled: true }, 'Add this app');
  const show = (m) => { err.textContent = m || ''; err.classList.toggle('hidden', !m); };
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('div', { class: 'muted', style: { fontSize: '12px' } }, hint) : null);

  detect.onclick = act(detect, async () => {
    show(''); adopt.disabled = true; result.replaceChildren();
    try {
      const r = await api('/api/laravel/inspect', { method: 'POST', body: { path: path.value.trim() } });
      result.replaceChildren(factsTable(r.info));
      if (r.info.isLaravel) adopt.disabled = false; else show('That folder exists but has no “artisan” file, so it is not a Laravel app.');
    } catch (e) { show(e.message); }
  });
  adopt.onclick = act(adopt, async () => {
    show('');
    try { const r = await api('/api/laravel', { method: 'POST', body: { name: name.value.trim(), path: path.value.trim() } }); close(); toast(`${r.app.name} added. Nothing on the server was changed.`); onAdopted(r.app); } catch (e) { show(e.message); }
  });
  const close = modal('Add an existing Laravel app', h('div', {}, err,
    h('p', { class: 'muted' }, 'Adds an app that is already running on this server, exactly as it is. The panel only reads it to show its status; nothing is moved, rewritten or restarted.'),
    h('div', { class: 'grid2' }, field('Name in the panel', name), field('Folder on the server', path, 'The folder that contains the artisan file')),
    suggestions.length ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Found in your nginx config: ', suggestions.map((p) => h('a', { href: '#', style: { marginRight: '10px' }, onclick: (e) => { e.preventDefault(); path.value = p; } }, p))) : null,
    h('div', { class: 'row', style: { margin: '10px 0' } }, detect), result,
    h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), adopt)), { wide: true });
}

function factsTable(i) {
  const rows = [
    ['Laravel', i.laravel || (i.isLaravel ? 'unknown version' : '–')], ['PHP', i.php || 'not found'], ['Files owned by', i.owner ? `${i.owner}${i.group ? `:${i.group}` : ''}` : '–'],
    ['Environment', i.env.appEnv ? `${i.env.appEnv}${i.env.debug === 'true' ? ' · DEBUG ON' : ''}` : (i.hasEnv ? 'unreadable' : 'no .env file')], ['Database / queue / cache', [i.env.db, i.env.queue, i.env.cache].map((x) => x || '?').join(' / ')],
    ['Git', i.git ? `${i.git.branch || '?'} @ ${shortSha(i.git.commit)} — ${i.git.subject || ''}${i.git.dirty ? ` (${i.git.dirty} uncommitted changes)` : ''}` : 'not a git checkout'],
    ['PHP-FPM', i.fpmUnit ? `${i.fpmUnit}${i.fpmUser ? ` (runs as ${i.fpmUser})` : ''}` : 'service not found'],
    ['Queue workers', i.workers.length ? i.workers.join(', ') : 'none detected'], ['Scheduler (cron)', i.scheduler.length ? 'found' : 'none detected'],
  ];
  return kv(rows);
}

function laravelWarnings(i, app) {
  const w = [];
  if (i.env.appEnv === 'production' && i.env.debug === 'true') w.push('APP_DEBUG is on in production: visitors can see stack traces and secrets on errors.');
  if (!i.hasEnv) w.push('No .env file found in the app folder.');
  if (!i.hasVendor) w.push('The vendor/ folder is missing: run composer install.');
  if (!i.php) w.push('PHP was not found for the SSH user.');
  if (i.storageMode && /7$/.test(i.storageMode) && i.storageMode === '777') w.push('storage/ is world-writable (777). Prefer owner/group write access for the PHP-FPM user.');
  if (i.fpmUser && i.owner && i.fpmUser !== i.owner && i.group !== i.fpmUser) w.push(`storage/ belongs to ${i.owner}, but PHP-FPM runs as ${i.fpmUser}: it may be unable to write logs and cache.`);
  if (['database', 'redis', 'sqs', 'beanstalkd'].includes(i.env.queue) && !i.workers.length) w.push(`The queue driver is “${i.env.queue}” but no queue worker service was detected: queued jobs may never run.`);
  if (!i.scheduler.length) w.push('No cron entry for “schedule:run” was found: scheduled tasks will not run (ignore if the app uses none).');
  if (i.maintenance) w.push('The app is in MAINTENANCE MODE: visitors see a 503 page.');
  if (i.logsKb > 200000) w.push(`storage/logs is ${(i.logsKb / 1024).toFixed(0)} MB: consider log rotation.`);
  return w;
}

// ---------------------------------------------------------------- list card (used by the Deploy page)
function laravelCard(onChange) {
  const box = h('div', { class: 'card', style: { marginBottom: '14px' } });
  let suggestions = [];
  async function load() {
    const r = await api('/api/laravel');
    if (isAdminUser()) { try { suggestions = (await api('/api/nginx/discover')).sites.map((s) => s.laravelPath).filter(Boolean); } catch { suggestions = []; } }
    const apps = r.apps;
    box.replaceChildren(h('h2', {}, `PHP / Laravel apps (${apps.length})`, isAdminUser() ? h('button', { class: 'sm primary', onclick: () => adoptLaravelDialog((a) => { location.hash = `#/deploy/laravel/${a.id}`; }, [...new Set(suggestions)]) }, 'Add existing app') : null),
      apps.length ? dataTable({
        columns: [
          { key: 'name', label: 'App', render: (x) => h('a', { href: `#/deploy/laravel/${x.id}` }, x.name) },
          { key: 'path', label: 'Folder', render: (x) => h('span', { class: 'mono' }, x.path) },
          { key: 'sites', label: 'Domains', sortable: false, render: (x) => (x.sites.length ? x.sites.map((s, i) => [i ? ', ' : '', h('a', { href: `#/domains/${s.id}` }, s.domain), s.https ? ' 🔒' : '']) : h('span', { class: 'muted' }, '–')) },
        ],
        rows: apps, empty: '', rowActions: (x) => h('button', { class: 'sm', onclick: () => { location.hash = `#/deploy/laravel/${x.id}`; } }, 'Manage'),
      }) : h('div', { class: 'muted' }, isAdminUser() ? 'Already running a Laravel app on this server? Add it here to see its status, run artisan commands, edit its .env and read its logs, without changing anything.' : 'No Laravel apps added yet.'));
    if (onChange) onChange(apps);
  }
  load().catch((e) => box.replaceChildren(h('div', { class: 'notice' }, e.message)));
  return box;
}

// ---------------------------------------------------------------- detail page
function pageLaravelDetail(id) {
  const root = h('div', {});
  const head = h('div', {});
  const content = h('div', {});
  root.append(head, content);
  let data = null; let tabId = 'overview';
  const admin = isAdminUser();

  async function load(rerender = true, fresh = false) {
    data = await api(`/api/laravel/detail?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`);
    drawHead();
    if (rerender) drawTabs();
  }

  async function run(command, { confirm: ask } = {}) {
    if (ask && !(await confirmDialog(ask.title, ask.text, ask.label || 'Run', ask.danger !== false))) return null;
    const r = await api('/api/laravel/artisan', { method: 'POST', body: { id, command } });
    await load(false, true);
    return r;
  }

  function drawHead() {
    const { app, info } = data;
    const btn = (label, fn, cls = '') => { const b = h('button', { class: cls }, label); b.onclick = act(b, fn); return b; };
    head.replaceChildren(h('div', { class: 'muted', style: { marginBottom: '6px' } }, h('a', { href: '#/deploy' }, '← All apps')),
      pageHeader(app.name, `${app.path}${data.sites.length ? ' · ' + data.sites.map((s) => s.domain).join(', ') : ''}`,
        h('span', { class: 'badge' }, `Laravel ${info.laravel || '?'}`), h('span', { class: 'badge' }, `PHP ${info.php || '?'}`),
        info.maintenance ? h('span', { class: 'badge warn' }, 'maintenance mode') : h('span', { class: 'badge ok' }, 'live'),
        admin ? btn(info.maintenance ? 'Go live' : 'Maintenance mode', async () => { const r = await run(info.maintenance ? 'up' : 'down', info.maintenance ? {} : { confirm: { title: 'Enable maintenance mode?', text: 'Visitors will see a 503 “be right back” page until you switch it off.', label: 'Enable' } }); if (r) toast(r.ok ? (info.maintenance ? 'App is live' : 'Maintenance mode on') : r.output, !r.ok); drawTabs(); }, info.maintenance ? 'primary' : '') : null));
  }

  function drawTabs() {
    content.replaceChildren(tabs([
      { id: 'overview', label: 'Overview', render: overview },
      ...(admin ? [{ id: 'commands', label: 'Commands', render: commands }, { id: 'env', label: '.env', render: envEditor }, { id: 'logs', label: 'Logs', render: logs }] : []),
      { id: 'settings', label: 'Settings', render: settings },
    ], tabId, (p) => { tabId = p; }));
  }

  function overview() {
    const { info, app } = data;
    const warns = laravelWarnings(info, app);
    return h('div', {},
      warns.length ? h('div', { class: 'card', style: { marginBottom: '14px' } }, h('h2', {}, `Things to look at (${warns.length})`), h('ul', { class: 'note-list', style: { color: 'var(--text)' } }, warns.map((x) => h('li', {}, x)))) : h('div', { class: 'alert', style: { background: 'var(--ok-bg)', color: 'var(--ok)' } }, '✓ No problems detected'),
      h('div', { class: 'two' },
        h('div', { class: 'card' }, h('h2', {}, 'Application'), factsTable(info)),
        h('div', { class: 'card' }, h('h2', {}, 'Domains'), data.sites.length ? h('div', {}, data.sites.map((s) => h('div', { style: { margin: '6px 0' } }, h('a', { href: `#/domains/${s.id}` }, s.domain), s.https ? ' 🔒' : ' (HTTP only)'))) : h('div', { class: 'muted' }, 'No nginx site points at this folder’s public/ directory yet. Adopt it from the Domains page.'),
          h('div', { class: 'muted', style: { marginTop: '12px', fontSize: '12.5px' } }, `artisan commands run as “${app.runUser || 'the SSH user'}”, the owner of storage/, so cache and log files keep the right owner.`))));
  }

  function commands() {
    const out = h('pre', { class: 'out', style: { minHeight: '180px' } }, 'Pick a command. Output appears here.');
    const groups = [
      ['Caches', [['optimize:clear', 'Clear all caches', ''], ['optimize', 'Cache config, routes & views', ''], ['config:clear', 'config:clear', ''], ['config:cache', 'config:cache', ''], ['route:clear', 'route:clear', ''], ['route:cache', 'route:cache', ''], ['view:clear', 'view:clear', ''], ['cache:clear', 'cache:clear', '']]],
      ['Workers & schedule', [['queue:restart', 'Restart queue workers', ''], ['queue:failed', 'List failed jobs', ''], ['schedule:list', 'Show schedule', '']]],
      ['Database', [['migrate:status', 'Migration status', ''], ['migrate', 'Run pending migrations', 'danger']]],
      ['Other', [['storage:link', 'storage:link', ''], ['about', 'About this app', '']]],
    ];
    const exec = async (cmd, label, danger) => {
      out.textContent = `$ php artisan ${cmd}\n…`;
      const r = await run(cmd, danger ? { confirm: { title: 'Run migrations?', text: 'Applies all pending database migrations (migrate --force). Take a database backup first if this is production.', label: 'Run migrations' } } : {});
      if (r) out.textContent = `$ php artisan ${cmd}   (${r.ms} ms, ${r.ok ? 'ok' : 'FAILED'})\n\n${r.output || '(no output)'}`; else out.textContent = 'Cancelled.';
    };
    const fpm = (action) => { const b = h('button', {}, action === 'reload' ? 'Reload PHP-FPM' : 'Restart PHP-FPM'); b.onclick = act(b, async () => { if (action === 'restart' && !(await confirmDialog('Restart PHP-FPM?', 'Requests in flight are interrupted for a moment.', 'Restart'))) return; await api('/api/laravel/fpm', { method: 'POST', body: { id, action } }); toast(`PHP-FPM ${action}ed`); }); return b; };
    return h('div', {}, h('div', { class: 'two' }, groups.map(([title, items]) => h('div', { class: 'card' }, h('h2', {}, title), h('div', { class: 'row' }, items.map(([cmd, label, cls]) => { const b = h('button', { class: cls === 'danger' ? 'danger' : '', title: `php artisan ${cmd}` }, label); b.onclick = act(b, () => exec(cmd, label, cls === 'danger')); return b; }))))),
      h('div', { class: 'card', style: { marginTop: '14px' } }, h('h2', {}, 'PHP-FPM', h('span', { class: 'muted' }, data.app.fpmUnit)), h('div', { class: 'row' }, fpm('reload'), fpm('restart')), h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12.5px' } }, 'Reload after changing PHP code or php.ini so OPcache picks it up.')),
      h('div', { style: { marginTop: '14px' } }, out),
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, 'Only a fixed list of safe commands can be run. Destructive ones (migrate:fresh, rollback, db:wipe, db:seed) are deliberately not available.'));
  }

  function envEditor() {
    const card = h('div', { class: 'card' });
    const area = h('textarea', { class: 'editor', rows: 18, spellcheck: false, disabled: true, style: { minHeight: '300px', whiteSpace: 'pre' }, placeholder: 'Values are hidden until you click “Reveal & edit”.' });
    const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap' } });
    const reveal = h('button', { class: 'primary' }, 'Reveal & edit');
    const save = h('button', { class: 'hidden' }, 'Save');
    const apply = h('button', { class: 'primary hidden' }, 'Save & apply');
    const cancel = h('button', { class: 'hidden' }, 'Cancel');
    const show = (m) => { err.textContent = m || ''; err.classList.toggle('hidden', !m); };
    const lock = () => { area.disabled = true; area.value = ''; for (const b of [save, apply, cancel]) b.classList.add('hidden'); reveal.classList.remove('hidden'); show(''); };
    reveal.onclick = act(reveal, async () => { const r = await api(`/api/laravel/env?id=${id}`); area.value = r.content; area.disabled = false; area.focus(); reveal.classList.add('hidden'); for (const b of [save, apply, cancel]) b.classList.remove('hidden'); });
    cancel.onclick = lock;
    const put = async (applyNow, force) => {
      show('');
      try {
        const r = await api('/api/laravel/env', { method: 'PUT', body: { id, content: area.value, apply: applyNow, force } });
        toast(applyNow ? (r.healthy ? 'Saved. Config cache refreshed and queue workers restarted.' : 'Saved, but a follow-up command failed. See Commands.') : 'Saved to .env (backup: .env.panel-bak)', applyNow && !r.healthy);
        await load(false, true);
      } catch (e) {
        if (/APP_KEY/.test(e.message) && await confirmDialog('APP_KEY is missing', e.message, 'Save anyway')) return put(applyNow, true);
        show(e.message);
      }
    };
    save.onclick = act(save, () => put(false));
    apply.onclick = act(apply, () => put(true));
    card.append(
      h('div', { class: 'muted', style: { marginBottom: '10px' } }, h('code', {}, `${data.app.path}/.env`), ' — edited as plain text: comments, order and quoting are kept. A copy of the previous file is saved as ', h('code', {}, '.env.panel-bak'), ' and the file’s owner and permissions are unchanged. Revealing values is recorded in the audit log.'),
      err, area, h('div', { class: 'row', style: { marginTop: '12px' } }, reveal, save, apply, cancel),
      h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '12.5px' } }, h('strong', {}, 'Save'), ' only writes the file (if config is cached, Laravel keeps using the old values until the cache is rebuilt). ', h('strong', {}, 'Save & apply'), ' also runs ', h('code', {}, 'config:clear'), ' (and ', h('code', {}, 'config:cache'), ' if it was cached) and ', h('code', {}, 'queue:restart'), '.'));
    return card;
  }

  function logs() {
    const out = h('pre', { class: 'out' }, 'Loading…');
    const file = h('select', { onchange: refresh });
    const lines = h('select', { onchange: refresh }, [200, 500, 1000, 3000].map((n) => h('option', { value: n }, `${n} lines`)));
    const filter = h('input', { class: 'grow', placeholder: 'Filter (e.g. ERROR, a request id, an exception)…', oninput: () => { clearTimeout(filter.t); filter.t = setTimeout(refresh, 350); } });
    const follow = h('input', { type: 'checkbox' });
    async function refresh() {
      if (!file.value) return;
      try {
        const r = await api(`/api/laravel/logs?id=${id}&file=${encodeURIComponent(file.value)}&lines=${lines.value}&q=${encodeURIComponent(filter.value)}`);
        const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
        out.textContent = r.output || '(no matching lines)';
        if (atEnd || !out.dataset.seen) { out.scrollTop = out.scrollHeight; out.dataset.seen = '1'; }
      } catch (e) { out.textContent = e.message; }
    }
    api(`/api/laravel/logfiles?id=${id}`).then((r) => { file.replaceChildren(...r.files.map((f) => h('option', { value: f.name }, `${f.name} (${fmt.bytes(f.size)})`))); if (!r.files.length) out.textContent = 'No log files in storage/logs yet.'; refresh(); }).catch((e) => { out.textContent = e.message; });
    poll(() => (follow.checked ? refresh() : null), 3000);
    return h('div', {}, h('div', { class: 'toolbar' }, file, lines, filter, h('label', { class: 'row' }, follow, 'Follow'), h('button', { onclick: refresh }, 'Refresh')), out);
  }

  function settings() {
    const { app } = data;
    const forget = h('button', { class: 'danger' }, 'Remove from panel…');
    forget.onclick = async () => { if (await confirmDialog('Remove from the panel?', `${app.name} is only forgotten here. The app, its files and its nginx site stay exactly as they are.`, 'Remove')) try { await api(`/api/laravel?id=${id}`, { method: 'DELETE' }); toast('Removed from the panel'); location.hash = '#/deploy'; } catch (e) { fail(e); } };
    return h('div', { class: 'card' }, kv([['Name', app.name], ['Folder', h('code', {}, app.path)], ['artisan runs as', app.runUser || 'the SSH user'], ['PHP-FPM service', app.fpmUnit], ['Added', `${fmt.date(Date.parse(app.created))} by ${app.createdBy}`]]),
      admin ? h('div', { style: { marginTop: '14px' } }, forget) : null);
  }

  load().catch((e) => { root.replaceChildren(h('div', { class: 'notice' }, e.message), h('p', {}, h('a', { href: '#/deploy' }, '← Back to apps'))); });
  poll(async () => { await load(false); }, 15000);
  return root;
}
