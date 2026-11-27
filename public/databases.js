'use strict';
/* Databases: MariaDB / PostgreSQL on the server. Everything is a button: install, create, users, access, export, import, drop. */

function pageDatabases() {
  const root = h('div', {});
  const body = h('div', {});
  let engine = sessionStorage.getItem('db.engine') || 'mysql';
  let status = null;
  root.append(pageHeader('Databases', `MariaDB and PostgreSQL on ${(currentServer() || {}).name || 'this server'}. No SQL needed.`), body);

  const tabs = () => h('div', { class: 'tabs', style: { marginBottom: '12px' } }, (status ? status.engines : []).map((e) =>
    h('button', { class: e.engine === engine ? 'primary' : '', onclick: () => { engine = e.engine; try { sessionStorage.setItem('db.engine', engine); } catch { /* ignore */ } paint(); } },
      e.label, ' ', e.running ? h('span', { class: 'badge ok' }, 'running') : e.installed ? h('span', { class: 'badge warn' }, 'stopped') : h('span', { class: 'badge' }, 'not installed'))));

  async function paint() {
    if (!status) status = await api('/api/db/status');
    const e = status.engines.find((x) => x.engine === engine);
    body.replaceChildren(tabs());
    if (!status.sudo) body.append(h('div', { class: 'alert warn' }, 'The SSH user has no passwordless sudo, so database management is limited. Use ec2-user or another user that can run sudo without a password.'));
    if (!e.installed) return body.append(installCard(e));
    if (!e.running) return body.append(h('div', { class: 'card' }, h('h2', {}, `${e.label} is installed but not running`),
      h('p', { class: 'muted' }, 'Start it from the Services page (mariadb or postgresql), then come back here.'), h('button', { onclick: () => { location.hash = '#/services'; } }, 'Open Services')));
    const box = h('div', {});
    body.append(h('p', { class: 'muted' }, `${e.label} ${e.version}`), box);
    await loadOverview(box, e);
  }

  function installCard(e) {
    const tool = e.engine === 'mysql' ? 'mariadb' : 'postgresql';
    const btn = h('button', { class: 'primary' }, `Install ${e.label}`);
    btn.onclick = act(btn, async () => {
      const r = await api('/api/provision/install', { method: 'POST', body: { tools: [tool] } });
      logModal(`Installing ${e.label}`, { url: `/api/jobs/log?id=${r.id}`, onDone: () => { status = null; paint().catch(fail); } });
    });
    return h('div', { class: 'card' }, h('h2', {}, `${e.label} is not installed on this server`),
      h('p', { class: 'muted' }, 'One click installs it, starts it and makes it start on boot. It only listens on this server (127.0.0.1), so it is not exposed to the internet.'), btn);
  }

  async function loadOverview(box, e) {
    const ov = await api(`/api/db/overview?engine=${engine}`);
    const reload = () => { status = null; paint().catch(fail); };
    const create = h('button', { class: 'primary', onclick: () => createDialog(engine, reload) }, 'New database');
    const imp = null;
    box.replaceChildren(
      h('div', { class: 'card' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', {}, `Databases (${ov.databases.length})`), create),
        dataTable({
          columns: [
            { key: 'name', label: 'Name', render: (x) => h('span', {}, x.name, x.system ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'system') : null) },
            { key: 'sizeMb', label: 'Size', render: (x) => `${x.sizeMb} MB` },
            { key: 'tables', label: engine === 'mysql' ? 'Tables' : 'Owner', render: (x) => (engine === 'mysql' ? String(x.tables) : x.owner || '') },
          ],
          rows: ov.databases, empty: 'No databases yet.',
          rowActions: (x) => (x.system ? null : h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
            h('button', { class: 'sm', onclick: () => exportDialog(engine, x.name) }, 'Export'),
            h('button', { class: 'sm', onclick: () => importDialog(engine, x.name, reload) }, 'Import'),
            h('button', { class: 'sm', onclick: () => useInAppDialog(engine, x.name, ov.users) }, 'Use in app'),
            h('button', { class: 'sm danger', onclick: () => dropDb(engine, x.name, reload) }, 'Drop'))),
        })),
      h('div', { class: 'card' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', {}, `Users (${ov.users.length})`), h('button', { onclick: () => userDialog(engine, ov, reload) }, 'New user')),
        dataTable({
          columns: [
            { key: 'name', label: 'User', render: (x) => h('span', {}, x.name, x.system ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'system') : null) },
            { key: 'host', label: 'From' },
            { key: 'databases', label: 'Can use', sortable: false, render: (x) => (x.databases.length ? x.databases.join(', ') : h('span', { class: 'muted' }, 'nothing')) },
          ],
          rows: ov.users, empty: 'No users.',
          rowActions: (x) => (x.system ? null : h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
            h('button', { class: 'sm', onclick: () => accessDialog(engine, x, ov.databases, reload) }, 'Access'),
            h('button', { class: 'sm', onclick: () => resetPw(engine, x.name) }, 'New password'),
            h('button', { class: 'sm danger', onclick: () => dropUser(engine, x.name, reload) }, 'Delete'))),
        })),
      exportsNote(imp));
  }
  const exportsNote = () => h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Exports are compressed .sql.gz files saved on the server (the five newest per database are kept) and can be downloaded. Importing replaces the database, but the panel saves the previous contents first and restores them automatically if the import fails.');

  paint().catch(fail);
  return root;
}

/** A secret shown exactly once. */
function secretDialog(title, intro, rows) {
  modal(title, h('div', {}, h('p', {}, intro), ...rows.map(([label, value]) => h('div', { class: 'field' }, h('label', {}, label), copyRow(value, label))),
    h('div', { class: 'alert warn' }, 'Save the password now. It is not stored anywhere and cannot be shown again (you can set a new one at any time).')), { actions: [{ label: 'I saved it', cls: 'primary', onclick: (c) => c() }] });
}

function createDialog(engine, done) {
  const name = h('input', { placeholder: 'myapp', autocomplete: 'off' });
  const withUser = h('input', { type: 'checkbox', checked: true });
  const user = h('input', { placeholder: 'same as the database', autocomplete: 'off' });
  const err = h('div', { class: 'alert crit hidden', role: 'alert' });
  const go = h('button', { class: 'primary' }, 'Create');
  go.onclick = act(go, async () => {
    err.classList.add('hidden');
    try {
      const n = name.value.trim();
      const r = await api('/api/db/databases', { method: 'POST', body: { engine, name: n, user: withUser.checked ? (user.value.trim() || n) : undefined } });
      close(); done();
      if (r.password) secretDialog('Database created', `${r.name} is ready. Give these settings to your app (or use “Use in app” to write them into its .env for you).`, [['Database', r.name], ['User', r.user], ['Password', r.password], ['Host / port', `${r.host}:${r.port}`]]);
      else toast(`${r.name} created`);
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  const close = modal('New database', h('div', {}, err,
    h('div', { class: 'field' }, h('label', {}, 'Database name'), name, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Letters, digits and underscores.')),
    h('label', { class: 'row', style: { margin: '6px 0' } }, withUser, 'Also create a user that can only use this database (recommended)'),
    h('div', { class: 'field' }, h('label', {}, 'User name (optional)'), user),
    h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), go)));
}

function userDialog(engine, ov, done) {
  const name = h('input', { autocomplete: 'off' });
  const db = h('select', {}, h('option', { value: '' }, 'No database yet'), ...ov.databases.filter((d) => !d.system).map((d) => h('option', { value: d.name }, d.name)));
  const err = h('div', { class: 'alert crit hidden', role: 'alert' });
  const go = h('button', { class: 'primary' }, 'Create user');
  go.onclick = act(go, async () => {
    err.classList.add('hidden');
    try {
      const r = await api('/api/db/users', { method: 'POST', body: { engine, name: name.value.trim(), database: db.value || undefined } });
      close(); done();
      secretDialog('User created', `${r.name} can now sign in.`, [['User', r.name], ['Password', r.password]]);
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  const close = modal('New user', h('div', {}, err, h('div', { class: 'field' }, h('label', {}, 'User name'), name), h('div', { class: 'field' }, h('label', {}, 'Give access to'), db),
    h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), go)));
}

function accessDialog(engine, user, databases, done) {
  const rows = databases.filter((d) => !d.system).map((d) => {
    const has = user.databases.includes(d.name);
    const b = h('button', { class: 'sm' + (has ? ' danger' : '') }, has ? 'Remove access' : 'Give access');
    b.onclick = act(b, async () => { await api('/api/db/grant', { method: 'POST', body: { engine, user: user.name, database: d.name, action: has ? 'revoke' : 'grant' } }); toast(has ? 'Access removed' : 'Access granted'); close(); done(); });
    return h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '4px 0' } }, h('span', {}, d.name, has ? h('span', { class: 'badge ok', style: { marginLeft: '6px' } }, 'has access') : null), b);
  });
  const close = modal(`Access for ${user.name}`, h('div', {}, rows.length ? rows : h('div', { class: 'empty' }, 'Create a database first.')), { actions: [{ label: 'Close', onclick: (c) => c() }] });
}

async function resetPw(engine, name) {
  if (!(await confirmDialog('Set a new password?', `${name}’s current password stops working immediately. Apps using it will fail until you update them.`, 'Set new password', false))) return;
  try { const r = await api('/api/db/users/password', { method: 'POST', body: { engine, name } }); secretDialog('New password', `${r.name} has a new password.`, [['User', r.name], ['Password', r.password]]); } catch (e) { fail(e); }
}

async function typedConfirm(title, message, expected, label) {
  return new Promise((resolve) => {
    const input = h('input', { autocomplete: 'off', placeholder: expected });
    const ok = h('button', { class: 'danger', disabled: true }, label);
    input.oninput = () => { ok.disabled = input.value !== expected; };
    let done = false;
    const close = modal(title, h('div', {}, h('p', {}, message), h('div', { class: 'field' }, h('label', {}, `Type ${expected} to confirm`), input),
      h('div', { class: 'actions' }, h('button', { onclick: () => { done = true; close(); resolve(false); } }, 'Cancel'), ok)));
    ok.onclick = () => { done = true; close(); resolve(true); };
    new MutationObserver((_, o) => { if (!document.querySelector('.modal-bg') && !done) { done = true; resolve(false); o.disconnect(); } }).observe(document.body, { childList: true });
  });
}

async function dropDb(engine, name, done) {
  if (!(await typedConfirm('Drop database', `This permanently deletes ${name} and everything in it. Export it first if you might need it.`, name, 'Drop database'))) return;
  try { await api(`/api/db/databases?engine=${engine}&name=${encodeURIComponent(name)}&confirm=${encodeURIComponent(name)}`, { method: 'DELETE' }); toast(`${name} dropped`); done(); } catch (e) { fail(e); }
}
async function dropUser(engine, name, done) {
  if (!(await typedConfirm('Delete user', `${name} will no longer be able to sign in.`, name, 'Delete user'))) return;
  try { await api(`/api/db/users?engine=${engine}&name=${encodeURIComponent(name)}&confirm=${encodeURIComponent(name)}`, { method: 'DELETE' }); toast(`${name} deleted`); done(); } catch (e) { fail(e); }
}

async function exportDialog(engine, name) {
  try {
    toast('Exporting…');
    const r = await api('/api/db/export', { method: 'POST', body: { engine, name } });
    modal('Export ready', h('div', {}, h('p', {}, `${r.file} (${fmt.bytes(r.bytes)}) is saved on the server and can be downloaded now.`), h('code', {}, r.path)),
      { actions: [{ label: 'Close', onclick: (c) => c() }, { label: 'Download', cls: 'primary', onclick: () => { window.location.href = withServer(`/api/db/download?file=${encodeURIComponent(r.file)}`); } }] });
  } catch (e) { fail(e); }
}

function importDialog(engine, name, done) {
  const file = h('input', { type: 'file', accept: '.sql,.gz,.sql.gz' });
  const confirm = h('input', { autocomplete: 'off', placeholder: name });
  const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap' } });
  const go = h('button', { class: 'danger' }, 'Replace database with this file');
  go.onclick = act(go, async () => {
    err.classList.add('hidden');
    const f = file.files[0];
    if (!f) { err.textContent = 'Choose a .sql or .sql.gz file.'; err.classList.remove('hidden'); return; }
    try {
      const r = await api(`/api/db/import?engine=${engine}&name=${encodeURIComponent(name)}&confirm=${encodeURIComponent(confirm.value)}&filename=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f });
      close(); toast(`Imported. Previous contents saved as ${r.safetyDump || 'n/a'}`); done();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  const close = modal(`Import into ${name}`, h('div', {}, err,
    h('div', { class: 'alert warn' }, `This REPLACES everything in ${name}. The current contents are exported first and restored automatically if the import fails.`),
    h('div', { class: 'field' }, h('label', {}, 'SQL file (.sql or .sql.gz)'), file), h('div', { class: 'field' }, h('label', {}, `Type ${name} to confirm`), confirm),
    h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), go)));
}

/** Write the connection settings into a panel app or a Laravel app. The password is entered (or generated) here and never shown after. */
async function useInAppDialog(engine, database, users) {
  let apps = []; let lv = [];
  try { [apps, lv] = await Promise.all([api('/api/apps').then((r) => r.apps), api('/api/laravel').then((r) => r.apps)]); } catch (e) { return fail(e); }
  const targets = [...lv.map((a) => ({ label: `${a.name} (Laravel, .env)`, type: 'laravel', id: a.id })), ...apps.map((a) => ({ label: `${a.name} (deployed app)`, type: 'app', id: a.id }))];
  if (!targets.length) return toast('Add an app first (Deploy page).', true);
  const target = h('select', {}, targets.map((t, i) => h('option', { value: i }, t.label)));
  const user = h('select', {}, users.filter((u) => !u.system).map((u) => h('option', { value: u.name, selected: u.databases.includes(database) }, u.name)));
  const pw = h('input', { type: 'password', autocomplete: 'off', placeholder: 'that user’s password' });
  const err = h('div', { class: 'alert crit hidden', role: 'alert' });
  const go = h('button', { class: 'primary' }, 'Write settings');
  go.onclick = act(go, async () => {
    err.classList.add('hidden');
    try {
      const t = targets[Number(target.value)];
      const r = await api('/api/db/use-in-app', { method: 'POST', body: { engine, database, user: user.value, password: pw.value, target: { type: t.type, id: t.id }, apply: t.type === 'laravel' } });
      close(); toast(r.redeploy ? `Saved to ${r.target}. Redeploy it to use the new settings.` : `Saved to ${r.target}’s .env`);
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  const close = modal(`Use ${database} in an app`, h('div', {}, err, h('p', { class: 'muted' }, 'Writes DB_HOST, DB_DATABASE, DB_USERNAME, DB_PASSWORD and DATABASE_URL into the app’s environment so nobody copies a password around.'),
    h('div', { class: 'field' }, h('label', {}, 'App'), target), h('div', { class: 'field' }, h('label', {}, 'Database user'), user), h('div', { class: 'field' }, h('label', {}, 'Password'), pw, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Forgot it? Use “New password” on the user first.')),
    h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), go)));
}
