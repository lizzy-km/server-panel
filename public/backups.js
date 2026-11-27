'use strict';
/* Backups: databases, app data and folders, on a schedule, with restore. Everything is a button. */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n) => String(n).padStart(2, '0');
function scheduleText(s) {
  if (!s || s.kind === 'manual') return 'Only when you press “Back up now”';
  if (s.kind === 'hourly') return `Every hour at :${pad2(s.minute)}`;
  if (s.kind === 'daily') return `Every day at ${pad2(s.hour)}:${pad2(s.minute)}`;
  return `Every ${WEEKDAYS[s.weekday]} at ${pad2(s.hour)}:${pad2(s.minute)}`;
}
function sourceText(s, apps) {
  if (s.type === 'db') return `${s.engine === 'mysql' ? 'MariaDB' : 'PostgreSQL'} database ${s.name}`;
  if (s.type === 'app') { const a = apps.find((x) => x.id === s.appId); return `Data of app ${a ? a.name : '(deleted app)'}`; }
  return `Folder ${s.path}`;
}
function runBadge(m) {
  if (!m) return h('span', { class: 'badge' }, 'never run');
  if (m.status === 'ok') return h('span', { class: 'badge ok' }, 'OK');
  if (m.status === 'ok-not-uploaded') return h('span', { class: 'badge warn' }, 'saved, upload failed');
  return h('span', { class: 'badge crit' }, m.status === 'failed' ? 'failed' : m.status);
}

function pageBackups() {
  const root = h('div', {});
  const box = h('div', {});
  let apps = []; let data = null;
  root.append(pageHeader('Backups', `Databases, app data and folders on ${(currentServer() || {}).name || 'this server'}`, h('button', { class: 'primary', cmd: 'panel: opens the form. Nothing runs until you save the job.', onclick: () => jobDialog(null, apps, data, load) }, 'New backup')), box);

  async function load() {
    const [d, a] = await Promise.all([api('/api/backups'), api('/api/apps').catch(() => ({ apps: [] }))]);
    data = d; apps = a.apps;
    box.replaceChildren(h('div', { class: 'card' }, h('h2', {}, `Backup jobs (${d.jobs.length})`), d.jobs.length ? dataTable({
      columns: [
        { key: 'name', label: 'Name', render: (j) => h('strong', {}, j.name) },
        { key: 'sources', label: 'Backs up', sortable: false, render: (j) => h('div', { style: { fontSize: '12.5px' } }, j.sources.map((s) => h('div', {}, sourceText(s, apps)))) },
        { key: 'schedule', label: 'When', sortable: false, render: (j) => h('div', {}, scheduleText(j.schedule), j.timer && j.timer.scheduled && !j.timer.active ? h('div', { class: 'badge crit' }, 'timer not active') : null) },
        { key: 'last', label: 'Last backup', sortable: false, render: (j) => h('div', {}, runBadge(j.last), j.last ? h('div', { class: 'muted', style: { fontSize: '12px' } }, `${ago(runDate(j.last.run))} · ${fmt.bytes(j.last.bytes || 0)}`) : null) },
        { key: 'keep', label: 'Keeps', render: (j) => `${j.keep}${j.s3.enabled ? ' + S3' : ''}` },
      ],
      rows: d.jobs, empty: '',
      rowActions: (j) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
        h('button', { class: 'sm primary', disabled: j.running, cmd: `bash /opt/panel-backups/${j.id}.sh   # the same script the timer runs\nmysqldump / pg_dump <db> | gzip > .../<time>/db-<engine>-<db>.sql.gz   # per database\ntar -czf .../<time>/files-N.tar.gz -C / <folder>   # per folder\ngzip -t / tar -tzf   # verifies every file\naws s3 cp ... --recursive   # only if S3 is on\n# then removes backups beyond the newest ${j.keep}`, onclick: () => runNow(j) }, j.running ? 'Running…' : 'Back up now'),
        h('button', { class: 'sm', cmd: 'cat <backup folder>/*/manifest.json   # reads the results each run wrote', onclick: () => historyDialog(j, load) }, 'Backups'),
        h('button', { class: 'sm', cmd: 'panel: opens the job settings. Saving rewrites the script and timer on the server.', onclick: () => jobDialog(j, apps, d, load) }, 'Edit'),
        h('button', { class: 'sm danger', cmd: `systemctl disable --now panel-backup-${j.id}.timer\nrm /etc/systemd/system/panel-backup-${j.id}.{timer,service} /opt/panel-backups/${j.id}.sh\nrm -rf <backup folder>/${j.id}   # only if you choose to delete the files`, onclick: () => deleteJob(j, load) }, 'Delete')),
    }) : h('div', { class: 'empty' }, 'No backup jobs yet. Create one to protect your databases and files, then schedule it so it runs by itself.')),
    h('p', { class: 'muted', style: { fontSize: '12.5px' } }, `Backups are stored on the server in ${d.defaults.root} and scheduled with systemd timers on the server itself, so they keep running even when this panel is closed. Restoring a database replaces it after saving a safety copy; restoring files goes to a separate folder unless you choose to overwrite.`));
  }
  load().catch(fail);
  return root;
}
const runDate = (run) => new Date(`${run.slice(0, 4)}-${run.slice(4, 6)}-${run.slice(6, 8)}T${run.slice(8, 10)}:${run.slice(10, 12)}:${run.slice(12, 14)}`).getTime();

async function runNow(j) {
  try {
    const r = await api('/api/backups/run', { method: 'POST', body: { id: j.id } });
    logModal(`Backing up ${j.name}`, { url: `/api/jobs/log?id=${r.id}`, onDone: () => { if (location.hash.startsWith('#/backups')) render(); } });
  } catch (e) { fail(e); }
}

async function deleteJob(j, done) {
  const files = await new Promise((resolve) => {
    const keep = h('button', { cmd: 'systemctl disable --now panel-backup-<id>.timer; rm the timer, service and script files' }, 'Delete job, keep backup files'); const all = h('button', { class: 'danger', cmd: 'systemctl disable --now panel-backup-<id>.timer; rm the timer, service and script files\nrm -rf <backup folder>/<id>' }, 'Delete job and its backup files');
    const close = modal(`Delete ${j.name}?`, h('div', {}, h('p', {}, 'The schedule stops. Existing backups can stay on the server or be deleted too.'), h('div', { class: 'actions' }, h('button', { onclick: () => { close(); resolve(null); } }, 'Cancel'), keep, all)));
    keep.onclick = () => { close(); resolve(false); }; all.onclick = () => { close(); resolve(true); };
  });
  if (files === null) return;
  try { await api(`/api/backups?id=${j.id}${files ? '&deleteFiles=1' : ''}`, { method: 'DELETE' }); toast('Backup job deleted'); done(); } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- create / edit
async function jobDialog(job, apps, data, done) {
  const edit = !!job;
  const name = h('input', { value: edit ? job.name : '', disabled: edit, placeholder: 'nightly' });
  const err = h('div', { class: 'alert crit hidden', role: 'alert' });
  // what to back up
  let dbs = [];
  try {
    const st = await api('/api/db/status');
    for (const e of st.engines) if (e.running) { const ov = await api(`/api/db/overview?engine=${e.engine}`); dbs.push(...ov.databases.filter((d) => !d.system).map((d) => ({ engine: e.engine, name: d.name }))); }
  } catch { dbs = []; }
  const has = (pred) => edit && job.sources.some(pred);
  const dbBoxes = dbs.map((d) => ({ d, cb: h('input', { type: 'checkbox', checked: has((s) => s.type === 'db' && s.engine === d.engine && s.name === d.name) }) }));
  const appBoxes = apps.map((a) => ({ a, cb: h('input', { type: 'checkbox', checked: has((s) => s.type === 'app' && s.appId === a.id) }) }));
  const folders = h('textarea', { rows: 3, placeholder: '/var/www/q-app/storage\n/etc/nginx', style: { width: '100%' } }, edit ? job.sources.filter((s) => s.type === 'path').map((s) => s.path).join('\n') : '');
  const excludes = h('input', { value: edit ? (job.excludes || []).join(', ') : 'node_modules, *.log', placeholder: 'node_modules, *.log' });
  const checks = (rows, label) => rows.map((r) => h('label', { class: 'row', style: { margin: '2px 0' } }, r.cb, label(r)));
  // schedule
  const kind = h('select', {}, [['manual', 'Only when I press the button'], ['hourly', 'Every hour'], ['daily', 'Every day'], ['weekly', 'Every week']].map(([v, l]) => h('option', { value: v, selected: (edit ? job.schedule.kind : 'daily') === v }, l)));
  const hour = h('input', { type: 'number', min: 0, max: 23, value: edit ? job.schedule.hour : 2, style: { width: '70px' } });
  const minute = h('input', { type: 'number', min: 0, max: 59, value: edit ? job.schedule.minute : 30, style: { width: '70px' } });
  const weekday = h('select', {}, WEEKDAYS.map((d, i) => h('option', { value: i, selected: (edit ? job.schedule.weekday : 0) === i }, d)));
  const when = h('div', { class: 'row' });
  const syncWhen = () => { when.replaceChildren(...(kind.value === 'manual' ? [] : [kind.value === 'weekly' ? weekday : null, kind.value !== 'hourly' ? h('span', {}, 'at') : h('span', {}, 'at minute'), kind.value !== 'hourly' ? hour : null, kind.value !== 'hourly' ? h('span', {}, ':') : null, minute].filter(Boolean))); };
  kind.onchange = syncWhen; syncWhen();
  const keep = h('input', { type: 'number', min: 1, max: 365, value: edit ? job.keep : 7, style: { width: '80px' } });
  // S3
  const s3on = h('input', { type: 'checkbox', checked: edit && job.s3.enabled });
  const s3 = { bucket: h('input', { value: (edit && job.s3.bucket) || '', placeholder: 'my-backups' }), prefix: h('input', { value: (edit && job.s3.prefix) || '', placeholder: 'production' }), region: h('input', { value: (edit && job.s3.region) || 'us-east-1' }), endpoint: h('input', { value: (edit && job.s3.endpoint) || '', placeholder: 'only for non-AWS storage (https://…)' }), accessKey: h('input', { value: (edit && job.s3.accessKey) || '', autocomplete: 'off' }), secretKey: h('input', { type: 'password', autocomplete: 'new-password', placeholder: edit && job.s3.hasSecret ? 'unchanged (type to replace)' : '' }) };
  const field = (l, el, hint) => h('div', { class: 'field' }, h('label', {}, l), el, hint ? h('div', { class: 'muted', style: { fontSize: '12px' } }, hint) : null);
  const awsNote = h('div', { class: 'alert warn' }, data.s3.installed ? `AWS CLI found (${data.s3.version}).` : 'The AWS CLI is not installed on this server. ', data.s3.installed ? null : h('button', { class: 'sm', onclick: async () => { try { const r = await api('/api/provision/install', { method: 'POST', body: { tools: ['awscli'] } }); logModal('Installing the AWS CLI', { url: `/api/jobs/log?id=${r.id}` }); } catch (e) { fail(e); } } }, 'Install AWS CLI'));
  const s3box = h('div', { class: 'hidden' }, awsNote, h('div', { class: 'grid2' }, field('Bucket', s3.bucket), field('Folder in the bucket (optional)', s3.prefix)), h('div', { class: 'grid2' }, field('Region', s3.region), field('Custom endpoint (optional)', s3.endpoint)),
    h('div', { class: 'grid2' }, field('Access key ID', s3.accessKey), field('Secret access key', s3.secretKey, 'Stored encrypted. Use a key that can only write to this bucket.')));
  s3on.onchange = () => s3box.classList.toggle('hidden', !s3on.checked); s3box.classList.toggle('hidden', !s3on.checked);

  const go = h('button', { class: 'primary', cmd: 'tee /opt/panel-backups/<id>.sh   # the backup script (mode 700)\ntee /etc/systemd/system/panel-backup-<id>.{service,timer}   # the schedule\nsystemctl daemon-reload; systemctl enable --now panel-backup-<id>.timer' }, edit ? 'Save' : 'Create backup job');
  go.onclick = act(go, async () => {
    err.classList.add('hidden');
    const sources = [
      ...dbBoxes.filter((x) => x.cb.checked).map((x) => ({ type: 'db', engine: x.d.engine, name: x.d.name })),
      ...appBoxes.filter((x) => x.cb.checked).map((x) => ({ type: 'app', appId: x.a.id })),
      ...folders.value.split('\n').map((l) => l.trim()).filter(Boolean).map((p) => ({ type: 'path', path: p })),
    ];
    const body = {
      name: name.value.trim(), sources, excludes: excludes.value.split(',').map((x) => x.trim()).filter(Boolean), keep: Number(keep.value),
      schedule: { kind: kind.value, hour: Number(hour.value), minute: Number(minute.value), weekday: Number(weekday.value) },
      s3: s3on.checked ? { enabled: true, bucket: s3.bucket.value.trim(), prefix: s3.prefix.value.trim(), region: s3.region.value.trim(), endpoint: s3.endpoint.value.trim(), accessKey: s3.accessKey.value.trim(), secretKey: s3.secretKey.value.trim() || undefined } : { enabled: false },
    };
    try {
      if (edit) { body.id = job.id; delete body.name; await api('/api/backups/update', { method: 'POST', body }); } else await api('/api/backups', { method: 'POST', body });
      close(); toast(edit ? 'Saved' : 'Backup job created'); done();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  const close = modal(edit ? `Edit ${job.name}` : 'New backup job', h('div', {}, err,
    field('Name', name),
    h('div', { class: 'field' }, h('label', {}, 'What to back up'),
      dbBoxes.length ? h('div', {}, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Databases'), ...checks(dbBoxes, (r) => `${r.d.engine === 'mysql' ? 'MariaDB' : 'PostgreSQL'}: ${r.d.name}`)) : h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'No databases found (install one on the Databases page).'),
      appBoxes.length ? h('div', { style: { marginTop: '6px' } }, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'App data (.env, uploads and other shared files of a deployed app)'), ...checks(appBoxes, (r) => r.a.name)) : null,
      h('div', { style: { marginTop: '6px' } }, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Other folders, one per line (for example an existing Laravel app’s storage folder)'), folders)),
    field('Leave out (optional)', excludes, 'Names or patterns that are not worth saving, separated by commas.'),
    h('div', { class: 'field' }, h('label', {}, 'When'), kind, when),
    field('How many backups to keep', keep, 'Older ones are deleted automatically.'),
    h('div', { class: 'field' }, h('label', { class: 'row' }, s3on, 'Also copy each backup to Amazon S3 (off-server copy)'), s3box),
    h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), go)), { wide: true });
}

// ---------------------------------------------------------------- history / restore / download
async function historyDialog(job, done) {
  const body = h('div', {});
  const close = modal(`Backups of ${job.name}`, body, { wide: true, actions: [{ label: 'Close', onclick: (c) => { c(); done(); } }] });
  async function paint() {
    const { runs } = await api(`/api/backups/runs?id=${job.id}`);
    body.replaceChildren(runs.length ? h('div', {}, runs.map((m) => h('div', { class: 'card', style: { margin: '8px 0', padding: '10px' } },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', {}, h('strong', {}, new Date(runDate(m.run)).toLocaleString()), ' ', runBadge(m), h('span', { class: 'muted' }, ` ${fmt.bytes(m.bytes || 0)}${m.uploaded === 'yes' ? ' · copied to S3' : ''}`)),
        h('button', { class: 'sm danger', cmd: 'rm -rf <backup folder>/<job>/<time>', onclick: async () => { if (!(await confirmDialog('Delete this backup?', 'The files are removed from the server.', 'Delete'))) return; try { await api(`/api/backups/runs?id=${job.id}&run=${m.run}`, { method: 'DELETE' }); paint().catch(fail); } catch (e) { fail(e); } } }, 'Delete')),
      h('div', {}, m.items.map((it) => h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '3px 0', fontSize: '13px' } },
        h('span', {}, it.type === 'db' ? `Database ${it.source.split(':')[1]}` : it.source, it.status !== 'ok' ? h('span', { class: 'badge crit', style: { marginLeft: '6px' } }, `failed${it.error ? `: ${it.error}` : ''}`) : h('span', { class: 'muted' }, ` ${fmt.bytes(it.bytes)}`)),
        it.status === 'ok' ? h('span', { class: 'row', style: { flexWrap: 'nowrap' } },
          h('a', { class: 'btn sm', style: { textDecoration: 'none', fontSize: '12px', padding: '3px 9px' }, href: withServer(`/api/backups/download?id=${job.id}&run=${m.run}&file=${encodeURIComponent(it.file)}`) }, 'Download'),
          h('button', { class: 'sm', cmd: 'panel: opens the restore options. Nothing runs until you confirm.', onclick: () => restoreDialog(job, m, it) }, 'Restore…')) : null)))))) : h('div', { class: 'empty' }, 'No backups yet. Press “Back up now”.'));
  }
  paint().catch(fail);
  return close;
}

function restoreDialog(job, m, it) {
  const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap' } });
  const isDb = it.type === 'db';
  const target = isDb ? it.source.split(':')[1] : it.source;
  const mode = h('select', {}, h('option', { value: 'stage' }, 'Unpack into a separate folder (safe)'), h('option', { value: 'inplace' }, 'Overwrite the files on the server'));
  const confirm = h('input', { autocomplete: 'off', placeholder: target });
  const confirmBox = h('div', { class: 'field' }, h('label', {}, `Type ${target} to confirm`), confirm);
  const sync = () => confirmBox.classList.toggle('hidden', !isDb && mode.value !== 'inplace'); sync(); mode.onchange = sync;
  const go = h('button', { class: 'danger', cmd: isDb ? 'mysqldump/pg_dump <db>   # safety copy first\ngunzip -c <backup file> | mysql <db>   # or psql, after dropping and recreating it\n# restored automatically if loading fails' : 'tar -xzf <backup file> -C <staging folder>   # safe: your live files are not touched\n# or, if you choose to overwrite:\ntar -czf <before-restore copy> -C / <folder>   # saved first\ntar -xzf <backup file> -C /' }, isDb ? 'Replace the database' : 'Restore');
  go.onclick = act(go, async () => {
    err.classList.add('hidden');
    try {
      const r = await api('/api/backups/restore', { method: 'POST', body: { id: job.id, run: m.run, file: it.file, inPlace: !isDb && mode.value === 'inplace', confirm: confirm.value } });
      close();
      modal('Restored', h('div', {}, isDb ? h('p', {}, `${r.database} now has the contents from this backup. The previous contents were saved as ${r.safetyDump || 'n/a'} in the exports folder.`)
        : r.inPlace ? h('p', {}, `Files in ${r.path} were overwritten. The previous files were saved first in ${r.savedAs}.`) : h('p', {}, 'The files were unpacked here (nothing else was changed):', h('br'), h('code', {}, r.path))), { actions: [{ label: 'OK', cls: 'primary', onclick: (c) => c() }] });
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  const close = modal(`Restore ${isDb ? `database ${target}` : target}`, h('div', {}, err,
    isDb ? h('div', { class: 'alert warn' }, `This REPLACES everything in ${target} with the backup from ${new Date(runDate(m.run)).toLocaleString()}. The current contents are saved first and put back automatically if the restore fails.`)
      : h('div', { class: 'field' }, h('label', {}, 'How'), mode, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Overwriting replaces files that exist in the backup (files created since then are left alone). The current files are saved first.')),
    confirmBox, h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), go)));
}
