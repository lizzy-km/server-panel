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

/** Offer to switch the server's PHP version (never silently: it affects every PHP site on the server). */
function phpSwitchBox(needs, installed, onStarted) {
  const ver = needs && /^8\.[2-4]$/.test(needs) ? needs : '8.4';
  const tool = { '8.2': 'php82', '8.3': 'php', '8.4': 'php84' }[ver];
  const btn = h('button', { type: 'button', class: 'primary', cmd: `dnf list --available php${ver}   # checked first, nothing is removed if it fails\ndnf -y remove 'php*'   # the current PHP\ndnf -y install php${ver} php${ver}-fpm php${ver}-cli ...\nsystemctl restart php-fpm` }, `Install PHP ${ver} on this server`);
  btn.onclick = async () => {
    if (!window.confirm(`Switch this server from PHP ${installed || 'current'} to PHP ${ver}?\n\nAmazon Linux keeps one PHP version at a time, so EVERY PHP site on this server will run on PHP ${ver} afterwards (PHP-FPM restarts briefly). The panel checks that PHP ${ver} is available first and changes nothing if it is not.`)) return;
    try {
      const r = await api('/api/provision/install', { method: 'POST', body: { tools: [tool], replacePhp: true } });
      logModal(`Installing PHP ${ver}`, { url: `/api/jobs/log?id=${r.id}`, onDone: onStarted });
    } catch (e) { fail(e); }
  };
  return h('div', { class: 'card', style: { margin: '8px 0', padding: '10px' } },
    h('div', { style: { marginBottom: '6px' } }, `This app needs PHP ${ver} or newer, but this server has PHP ${installed || 'an older version'}.`),
    btn, h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } }, 'Alternative: in your code add "config": { "platform": { "php": "8.3.0" } } to composer.json, run composer update, and commit composer.lock.'));
}

/** The real steps a deploy runs for this app (from its effective commands), for button tooltips. */
function deployCmd(a) {
  const e = a.effective || {}; const dir = `${a.baseDir}/${a.name}`;
  const lines = [`git clone --depth 1 --branch ${a.branch} ${a.repoUrl.replace(/\/\/[^@/]*@/, '//')} ${dir}/releases/<new release>`];
  if (a.mode === 'php') lines.push('composer check-platform-reqs --lock --no-dev   # does this server\'s PHP fit?');
  const one = (c) => String(c || '').split('\n').map((x) => x.trim()).filter(Boolean);
  for (const c of [...one(e.install), ...one(e.build)]) lines.push(c);
  if (a.mode === 'php' && one(e.releaseCmd).length) lines.push(...one(e.releaseCmd).map((c) => `${c}   # release command`));
  lines.push(`ln -sfn ${dir}/releases/<new release> ${dir}/current`);
  lines.push(a.mode === 'service' ? `systemctl restart ${a.unit}   # then waits for ${a.healthPath || '/'} to answer` : a.mode === 'php' ? 'systemctl reload php-fpm   # then checks the site answers' : 'nginx serves the new files straight away');
  lines.push(`# keeps the newest ${a.keepReleases} releases, removes older ones`);
  return lines.join('\n');
}

/** Live log viewer for a deploy (id) or a provisioning job; polls until finished. */
/** Where on the server the app lives: /var/www (web root) or /srv/apps, or any other folder. */
function locationField(baseDir, nameInput) {
  const known = ['/var/www', '/srv/apps'];
  const sel = h('select', {}, known.map((p) => h('option', { value: p }, p)), h('option', { value: '' }, 'Another folder…'));
  const custom = h('input', { placeholder: '/opt/sites', class: 'hidden' });
  const preview = h('div', { class: 'muted', style: { fontSize: '12px' } });
  let last = ''; try { last = localStorage.getItem('app.baseDir') || ''; } catch { /* ignore */ }
  sel.value = known.includes(last) ? last : '/var/www';
  const sync = () => {
    custom.classList.toggle('hidden', sel.value !== '');
    baseDir.value = (sel.value || custom.value.trim() || '/var/www').replace(/\/+$/, '');
    preview.textContent = `The app will be created in ${baseDir.value}/${nameInput.value.trim() || '<name>'}`;
    try { if (known.includes(sel.value)) localStorage.setItem('app.baseDir', sel.value); } catch { /* ignore */ }
  };
  sel.onchange = sync; custom.oninput = sync; nameInput.addEventListener('input', sync); sync();
  return h('div', { class: 'field' }, h('label', {}, 'Location on the server'), sel, custom, preview);
}

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
        if (r.deploy && r.deploy.hint && r.deploy.hint.startsWith('php:') && r.deploy.status === 'failed' && !badge.dataset.hint) { badge.dataset.hint = '1'; badge.parentNode.appendChild(phpSwitchBox(r.deploy.hint.slice(4), '', () => {})); }
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
    const core = ['git', 'nginx', 'certbot'];
    const runtimes = ['node', 'php', 'composer', 'java', 'maven', 'dotnet', 'go', 'python'];
    const missingCore = core.filter((t) => !r.tools[t].installed);
    const chip = (k, optional) => {
      const t = r.tools[k]; const ok = t.installed;
      const el = h('span', { class: 'chip ' + (ok ? 'ok' : optional ? '' : 'bad'), title: ok ? 'installed' : (isAdminUser() ? 'click to install' : 'not installed'), style: !ok && isAdminUser() ? { cursor: 'pointer' } : {} },
        ok ? '✓' : optional ? '＋' : '✕', ` ${TOOL_LABEL[k] || k}`, t.version ? h('span', { class: 'muted' }, ` ${t.version}`) : null);
      if (!ok && isAdminUser()) el.addEventListener('click', () => installDialog([k], load));
      return el;
    };
    box.replaceChildren(
      h('h2', {}, 'Server readiness', isAdminUser() && missingCore.length ? h('button', { class: 'sm primary', cmd: 'dnf -y install <the missing tools>   # you pick which ones in the next step', onclick: () => installDialog(missingCore, load) }, 'Install missing…') : h('button', { class: 'sm', cmd: 'node --version; git --version; php -v; java -version; dotnet --version; go version ...   # asks each tool for its version', onclick: load }, 'Re-check')),
      h('div', { class: 'chips' }, core.map((k) => chip(k, false)), h('span', { class: 'chip ' + (r.sudo === 'no' ? 'bad' : 'ok') }, r.sudo === 'no' ? '✕ passwordless sudo' : '✓ ' + (r.sudo === 'root' ? 'root' : 'sudo'))),
      h('div', { class: 'muted', style: { margin: '10px 0 6px', fontSize: '12.5px' } }, 'Runtimes for your apps (click a missing one to install it; the new-app form also offers this automatically):'),
      h('div', { class: 'chips' }, runtimes.map((k) => chip(k, true))),
      r.sudo === 'no' ? h('div', { class: 'alert', style: { marginTop: '10px' } }, `User “${r.user}” has no passwordless sudo, so deploys cannot create services and nginx/certificates cannot be managed.`) : null,
      missingCore.length && !isAdminUser() ? h('div', { class: 'muted', style: { marginTop: '8px' } }, 'Ask an administrator to install the missing tools.') : null);
  }
  load();
  return box;
}

function installDialog(missing, onFinished) {
  const names = { git: 'git (clone repositories)', node: 'Node.js + npm (React, Vue, Angular, Next.js, Nest, Express…)', nginx: 'nginx (web server / reverse proxy)', certbot: "certbot (free Let's Encrypt certificates, auto-renewal)", java: 'Java 21 (Amazon Corretto) for Spring Boot', maven: 'Maven (Spring builds without a wrapper)', dotnet: '.NET SDK 8 for ASP.NET Core', php: 'PHP 8.3 + PHP-FPM (set up to work with nginx)', composer: 'Composer (PHP packages)', go: 'Go', python: 'Python 3 + pip' };
  const boxes = Object.fromEntries(missing.map((t) => [t, h('input', { type: 'checkbox', checked: true })]));
  const body = h('div', {}, h('p', { class: 'muted' }, 'Installs with dnf on Amazon Linux 2023. This changes the server; nginx is started and enabled. Remember to open ports 80 and 443 in the instance’s security group.'),
    missing.map((t) => h('label', { class: 'row', style: { margin: '6px 0' } }, boxes[t], names[t])));
  modal('Prepare server', body, { actions: [{ label: 'Cancel', onclick: (c) => c() }, { label: 'Install', cls: 'primary', cmd: 'dnf -y install <the ticked tools>\nsystemctl enable --now nginx   # if nginx is ticked', onclick: async (c) => {
    const tools = missing.filter((t) => boxes[t].checked);
    if (!tools.length) return;
    try { const r = await api('/api/provision/install', { method: 'POST', body: { tools } }); c(); logModal('Installing ' + tools.join(', '), { url: `/api/jobs/log?id=${r.id}`, onDone: onFinished }); } catch (e) { fail(e); }
  } }] });
}

// ---------------------------------------------------------------- app form (create + settings)
let PRESET_LIST = null;
async function loadPresets() { if (!PRESET_LIST) PRESET_LIST = (await api('/api/presets')).presets; return PRESET_LIST; }
const TOOL_LABEL = { git: 'git', node: 'Node.js', java: 'Java', maven: 'Maven', dotnet: '.NET SDK', php: 'PHP + PHP-FPM', composer: 'Composer', go: 'Go', python: 'Python', nginx: 'nginx', certbot: 'certbot' };
const MODE_TEXT = {
  service: 'Runs as a background service on its own port; nginx forwards visitors to it.',
  static: 'Built once, then the files are served directly by nginx (no process to run).',
  php: 'Runs under PHP-FPM; nginx hands PHP requests to it (no separate process).',
};

/** Which tools a framework needs and whether the server has them; one click installs what is missing. */
function requirementsBar(preset, tools, onInstalled) {
  const need = ['git', ...(preset.tools || [])];
  const box = h('div', { class: 'req' });
  const missing = need.filter((t) => !(tools[t] && tools[t].installed));
  box.append(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'This server needs:'),
    ...need.map((t) => h('span', { class: 'chip ' + (tools[t] && tools[t].installed ? 'ok' : 'bad') }, tools[t] && tools[t].installed ? '✓' : '✕', ` ${TOOL_LABEL[t] || t}`, tools[t] && tools[t].version ? h('span', { class: 'muted' }, ` ${tools[t].version}`) : null)));
  if (missing.length && isAdminUser()) box.append(h('button', { class: 'sm primary', type: 'button', onclick: async () => {
    try { const r = await api('/api/provision/install', { method: 'POST', body: { tools: missing } }); logModal(`Installing ${missing.map((t) => TOOL_LABEL[t] || t).join(', ')}`, { url: `/api/jobs/log?id=${r.id}`, onDone: onInstalled }); } catch (e) { fail(e); }
  } }, `Install ${missing.map((t) => TOOL_LABEL[t] || t).join(' + ')}`));
  else if (!missing.length) box.append(h('span', { class: 'badge ok' }, 'ready'));
  return box;
}

/**
 * The app form. New app: paste a repository, detect or pick a framework, see what the server needs, go.
 * Raw commands live under "Advanced" and only override the framework's defaults.
 */
function appForm(app, apps, presets, tools) {
  const isNew = !app;
  const a = app || { branch: 'main', authType: 'none', healthPath: '/', healthTimeout: 30, keepReleases: 5, tokenUser: 'x-access-token', framework: 'node' };
  let framework = a.framework || 'node';
  const preset = () => presets.find((p) => p.id === framework) || presets[0];
  const f = {
    name: h('input', { value: a.name || '', placeholder: 'my-app', disabled: !isNew }),
    repoUrl: h('input', { value: a.repoUrl || '', placeholder: 'https://github.com/org/repo.git  or  git@github.com:org/repo.git' }),
    branch: h('input', { value: a.branch }),
    authType: h('select', {}, [['none', 'Public repository'], ['token', 'Private: access token'], ['key', 'Private: deploy key']].map(([v, l]) => h('option', { value: v, selected: v === a.authType }, l))),
    tokenUser: h('input', { value: a.tokenUser, placeholder: 'x-access-token' }),
    secret: h('textarea', { rows: 4, spellcheck: false, placeholder: a.hasGitSecret ? '(unchanged: paste to replace)' : '' }),
    port: h('input', { type: 'number', value: a.port || suggestPort(apps), min: 1024, max: 65535 }),
    spa: h('input', { type: 'checkbox', checked: a.spa !== false }),
    outputDir: h('input', { value: a.outputDir || '', placeholder: 'auto-detect (dist, build, out…)' }),
    migrate: h('input', { type: 'checkbox', checked: a.releaseCmd === null || a.releaseCmd === undefined || a.releaseCmd !== '' }),
    sharedPaths: h('input', { value: (a.sharedPaths || preset().sharedPaths || []).join(', '), placeholder: 'storage' }),
    installCmd: h('input', { value: a.installCmd || '' }), buildCmd: h('input', { value: a.buildCmd || '' }), startCmd: h('input', { value: a.startCmd || '' }),
    releaseCmd: h('input', { value: a.releaseCmd || '' }), afterCmd: h('input', { value: a.afterCmd || '' }),
    healthPath: h('input', { value: a.healthPath }), healthHost: h('input', { value: a.healthHost || '', placeholder: 'e.g. app.example.com (PHP apps: checks through nginx)' }),
    healthTimeout: h('input', { type: 'number', value: a.healthTimeout, min: 5, max: 300 }), healthStrict: h('input', { type: 'checkbox', checked: !!a.healthStrict }),
    keepReleases: h('input', { type: 'number', value: a.keepReleases, min: 2, max: 30 }),
    runAs: h('input', { value: a.runAs || '', placeholder: 'default: the SSH user (PHP apps: nginx)' }),
    extraPath: h('input', { value: a.extraPath || '', placeholder: 'e.g. /opt/tools/bin' }),
    baseDir: h('input', { value: a.baseDir || '/srv/apps', disabled: !isNew }),
    env: h('textarea', { rows: 4, spellcheck: false, placeholder: 'NODE_OPTIONS=--max-old-space-size=512\nDATABASE_URL=postgres://…' }),
  };
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('div', { class: 'muted', style: { fontSize: '12px' } }, hint) : null);
  const secretBox = h('div', {});
  const syncAuth = () => {
    const t = f.authType.value;
    secretBox.replaceChildren(...(t === 'none' ? [] : [
      ...(t === 'token' ? [field('Token username', f.tokenUser, 'GitHub: x-access-token')] : []),
      field(t === 'token' ? 'Access token' : 'Deploy key (private key)', f.secret, t === 'key' ? 'Add the matching public key as a read-only deploy key on the repository. Stored encrypted.' : 'A personal access token with read access to the repository. Stored encrypted, never shown again.'),
    ]));
  };
  f.authType.addEventListener('change', syncAuth); syncAuth();

  // ---- framework picker
  const picker = h('div', { class: 'fw-grid' });
  const info = h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '6px' } });
  const req = h('div', {});
  const modeFields = h('div', {});
  const placeholders = () => { const p = preset(); for (const [k, v] of [['installCmd', p.install], ['buildCmd', p.build], ['startCmd', p.start], ['releaseCmd', p.releaseCmd], ['afterCmd', p.afterCmd], ['outputDir', p.outputDir === 'auto' ? 'auto-detect' : p.outputDir]]) f[k].placeholder = v ? `default: ${String(v).slice(0, 90)}` : 'default: none'; f.healthPath.placeholder = p.healthPath || '/'; };
  function drawPicker() {
    const groups = [...new Set(presets.map((p) => p.group))];
    picker.replaceChildren(...groups.flatMap((g) => [h('div', { class: 'fw-group' }, g), ...presets.filter((p) => p.group === g).map((p) => h('button', {
      type: 'button', class: 'fw-card' + (p.id === framework ? ' sel' : ''), disabled: !isNew, 'aria-pressed': p.id === framework,
      onclick: () => { framework = p.id; refresh(); },
    }, h('span', { class: 'ic' }, p.icon), h('span', {}, h('div', { class: 't' }, p.label), h('div', { class: 'm' }, p.mode === 'service' ? 'service' : p.mode === 'static' ? 'static files' : 'PHP-FPM'))))]));
  }
  function drawMode() {
    const p = preset();
    modeFields.replaceChildren(...(p.mode === 'service' ? [field('Port', f.port, 'The port your app listens on. The panel passes it to your app as the PORT environment variable.')]
      : p.mode === 'static' ? [h('label', { class: 'row', style: { margin: '4px 0 8px' } }, f.spa, 'Single-page app: send unknown URLs to index.html (React Router, Vue Router, Angular routes)'), field('Output folder', f.outputDir, 'Where the build puts the website. Leave empty to detect it (dist, build, out, Angular’s dist/<app>/browser…).')]
        : [...(p.id === 'laravel' ? [h('label', { class: 'row', style: { margin: '4px 0 8px' } }, f.migrate, 'Run database migrations on every deploy (php artisan migrate --force, before the new version goes live)')] : []),
          field('Folders kept between releases', f.sharedPaths, 'Uploads, logs and caches that must survive a deploy (Laravel: storage). Comma separated.')]));
  }
  function refresh() {
    const p = preset();
    drawPicker(); drawMode(); placeholders();
    info.textContent = `${p.description} ${MODE_TEXT[p.mode]}`;
    req.replaceChildren(tools ? requirementsBar(p, tools, async () => { try { const t = (await api('/api/provision/status')).tools; Object.assign(tools, t); } catch { /* ignore */ } refresh(); }) : '');
  }

  // ---- detection
  const detectBtn = h('button', { type: 'button', cmd: 'git clone --depth 1 --branch <branch> <repo> /tmp/<temp>   # then looks for artisan, package.json, pom.xml ... and deletes the temp copy' }, 'Detect framework from the repository');
  const detectBox = h('div', {});
  const detectMsg = h('span', { class: 'muted', style: { marginLeft: '10px', fontSize: '12.5px' } });
  detectBtn.onclick = act(detectBtn, async () => {
    detectMsg.textContent = 'Looking inside the repository…';
    try {
      const body = { repoUrl: f.repoUrl.value.trim(), branch: f.branch.value.trim() || 'main', authType: f.authType.value, tokenUser: f.tokenUser.value.trim() || 'x-access-token' };
      if (body.authType !== 'none') body.gitSecret = f.secret.value.trim();
      const r = await api('/api/apps/detect', { method: 'POST', body });
      framework = r.preset; refresh(); detectMsg.textContent = `Detected: ${r.label}`;
      detectBox.replaceChildren();
      if (r.php && r.php.problems.length) detectBox.append(h('div', { class: 'err' }, r.php.problems.join('. ')), phpSwitchBox(r.php.needs, r.php.installed, () => {}));
    } catch (e) { detectMsg.textContent = ''; fail(e); }
  });

  const cmds = h('details', { class: 'adv' }, h('summary', {}, 'Advanced: override commands (only if the defaults do not fit)'),
    field('Install command', f.installCmd), field('Build command', f.buildCmd), field('Start command', f.startCmd, 'Services only. Must listen on $PORT.'),
    field('Release command (runs before going live; a failure cancels the deploy)', f.releaseCmd), field('After-deploy command (runs once live)', f.afterCmd));
  const el = h('div', {},
    isNew ? h('div', {}, field('Git repository', f.repoUrl), h('div', { class: 'grid2' }, field('Branch or tag', f.branch), field('Access', f.authType)), secretBox,
      h('div', { class: 'row', style: { margin: '0 0 10px' } }, detectBtn, detectMsg), detectBox) : h('div', {}, field('Git repository', f.repoUrl), h('div', { class: 'grid2' }, field('Branch or tag', f.branch), field('Access', f.authType)), secretBox),
    h('div', { class: 'field' }, h('label', {}, isNew ? 'Framework' : 'Framework (fixed after creation)'), picker), info, isNew ? req : '',
    modeFields,
    isNew ? h('div', { class: 'grid2' }, field('App name', f.name, 'Lowercase letters, digits, dashes'), locationField(f.baseDir, f.name)) : '',
    cmds,
    h('details', { class: 'adv' }, h('summary', {}, 'Advanced: health check, releases, user'),
      h('div', { class: 'grid2' }, field('Health check path', f.healthPath), field('Wait up to (seconds)', f.healthTimeout)),
      field('Health check host name (PHP apps)', f.healthHost, 'PHP apps are checked through nginx on port 80 with this host name. Leave empty to only check that the site files exist.'),
      h('label', { class: 'row', style: { margin: '4px 0 12px' } }, f.healthStrict, 'Require a 2xx/3xx answer (otherwise anything below 500 counts as healthy)'),
      h('div', { class: 'grid2' }, field('Releases to keep', f.keepReleases), field('Run as Linux user', f.runAs)),
      h('div', { class: 'grid2' }, isNew ? h('div', {}) : field('Apps directory', f.baseDir), field('Extra PATH', f.extraPath))),
    isNew ? field('Environment variables (optional)', f.env, 'One NAME=value per line. Stored encrypted; values are never shown again unless an admin reveals them.') : null);
  refresh();

  const read = () => {
    const p = preset();
    const body = {
      repoUrl: f.repoUrl.value.trim(), branch: f.branch.value.trim(), authType: f.authType.value, framework,
      installCmd: f.installCmd.value, buildCmd: f.buildCmd.value, startCmd: f.startCmd.value, afterCmd: f.afterCmd.value,
      healthPath: f.healthPath.value.trim() || '/', healthHost: f.healthHost.value.trim(), healthTimeout: Number(f.healthTimeout.value), healthStrict: f.healthStrict.checked,
      keepReleases: Number(f.keepReleases.value), runAs: f.runAs.value.trim(), extraPath: f.extraPath.value.trim(),
    };
    // an empty command means "use the framework default", so do not send it
    for (const k of ['installCmd', 'buildCmd', 'startCmd', 'afterCmd']) if (!body[k]) delete body[k];
    if (f.releaseCmd.value) body.releaseCmd = f.releaseCmd.value;
    else if (p.id === 'laravel') body.releaseCmd = f.migrate.checked ? undefined : '';
    if (p.mode === 'service') body.port = Number(f.port.value);
    if (p.mode === 'static') { body.spa = f.spa.checked; body.outputDir = f.outputDir.value.trim(); }
    if (p.mode === 'php') body.sharedPaths = f.sharedPaths.value;
    if (isNew) { body.name = f.name.value.trim(); body.baseDir = f.baseDir.value.trim(); }
    if (body.authType === 'token') body.tokenUser = f.tokenUser.value.trim() || 'x-access-token';
    if (body.authType !== 'none' && f.secret.value.trim()) body.gitSecret = f.secret.value.trim();
    if (isNew) body.env = parseEnvLines(f.env.value);
    return body;
  };
  return { el, read };
}
const suggestPort = (apps) => { const used = new Set((apps || []).map((x) => x.port)); let p = 3000; while (used.has(p)) p += 1; return p; };

async function newAppDialog(apps, onCreated) {
  let presets; let tools = null;
  try { presets = await loadPresets(); } catch (e) { return fail(e); }
  try { tools = (await api('/api/provision/status')).tools; } catch { tools = null; }
  const form = appForm(null, apps, presets, tools);
  const err = h('div', { class: 'alert crit hidden', role: 'alert', style: { whiteSpace: 'pre-wrap' } });
  const create = h('button', { class: 'primary', cmd: 'panel: saves the app settings. Nothing runs on the server until you press Deploy.' }, 'Create app');
  const close = modal('New app', h('div', {}, err, form.el, h('div', { class: 'actions' }, h('button', { onclick: () => close() }, 'Cancel'), create)), { wide: true });
  create.onclick = act(create, async () => {
    err.classList.add('hidden');
    try { const r = await api('/api/apps', { method: 'POST', body: form.read() }); close(); toast(`Created ${r.app.name}. Click Deploy to publish it.`); onCreated(r.app); }
    catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
}

// ---------------------------------------------------------------- list page
function pageDeploy() {
  const args = routeArgs();
  if (args[0] === 'laravel' && args[1]) return pageLaravelDetail(args[1]);
  if (args[0]) return pageAppDetail(args[0]);
  const admin = isAdminUser();
  const box = h('div', { class: 'card' });
  let apps = [];
  async function load() {
    await loadPresets();
    const r = await api('/api/apps');
    apps = r.apps;
    box.replaceChildren(h('h2', {}, `Apps (${apps.length})`), apps.length ? dataTable({
      columns: [
        { key: 'name', label: 'App', render: (x) => h('a', { href: `#/deploy/${x.id}` }, x.name) },
        { key: 'repoUrl', label: 'Source', render: (x) => h('span', { class: 'mono' }, `${x.repoUrl.replace(/^https:\/\//, '').replace(/\.git$/, '')} @ ${x.branch}`) },
        { key: 'framework', label: 'Framework', render: (x) => { const p = PRESET_LIST.find((q) => q.id === x.framework) || {}; return h('span', {}, `${p.icon || ''} ${(p.label || x.framework).replace(/ \(.*\)$/, '')}`, h('span', { class: 'muted' }, x.mode === 'service' ? ` · port ${x.port}` : x.mode === 'static' ? ' · static files' : ' · PHP-FPM')); } },
        { key: 'lastDeploy', label: 'Last deploy', sortable: false, render: (x) => (x.lastDeploy ? h('span', {}, deployBadge(x.lastDeploy.status), ' ', h('span', { class: 'muted' }, `${shortSha(x.lastDeploy.commit)} · ${ago(x.lastDeploy.startedAt)}`)) : h('span', { class: 'muted' }, 'never')) },
      ],
      rows: apps, empty: '',
      rowActions: (x) => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
        admin ? (() => { const b = h('button', { class: 'sm primary', disabled: x.deploying, cmd: deployCmd(x) }, x.deploying ? 'Deploying…' : 'Deploy'); b.onclick = act(b, () => deployNow(x, load)); return b; })() : null,
        h('button', { class: 'sm', onclick: () => { location.hash = `#/deploy/${x.id}`; } }, 'Open')),
    }) : h('div', { class: 'empty' }, admin ? 'No apps yet. Create one to deploy a Node.js project from Git.' : 'No apps yet.'));
  }
  poll(load, 8000);
  return h('div', {}, pageHeader('Deploy', `Node.js apps on ${(currentServer() || {}).name || 'this server'}: Git → build → zero-downtime switch → health check → auto-rollback`,
    admin ? h('button', { class: 'primary', onclick: () => newAppDialog(apps, (a) => { location.hash = `#/deploy/${a.id}`; }) }, 'New app') : null),
    readinessCard(), laravelCard(), box);
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
    await loadPresets();
    data = await api(`/api/apps/detail?id=${encodeURIComponent(id)}`);
    drawHead();
    if (rerender) drawTabs();
    return data;
  }

  function drawHead() {
    const { app, status } = data;
    const admin = isAdminUser();
    const act1 = (label, fn, cls = '', cmd = '') => { const b = h('button', { class: cls, cmd: cmd || undefined }, label); b.onclick = act(b, fn); return b; };
    head.replaceChildren(h('div', { class: 'muted', style: { marginBottom: '6px' } }, h('a', { href: '#/deploy' }, '← All apps')),
      pageHeader(app.name, `${app.repoUrl.replace(/\.git$/, '')} @ ${app.branch}`,
        h('span', { class: 'badge ' + (['active', 'serving'].includes(status.active) ? 'ok' : ['inactive', 'failed', 'broken'].includes(status.active) ? 'bad' : '') }, app.mode === 'service' ? `service ${status.active}` : status.active),
        admin ? act1('Deploy now', async () => { await deployNow(app, () => load()); }, 'primary', deployCmd(app)) : null,
        admin && app.mode === 'service' ? act1('Restart', async () => { await api('/api/apps/service', { method: 'POST', body: { id, action: 'restart' } }); toast('Restarted'); await load(false); drawHead(); }, '', `systemctl restart ${app.unit}`) : null,
        admin && app.mode === 'service' ? act1(status.active === 'active' ? 'Stop' : 'Start', async () => { await api('/api/apps/service', { method: 'POST', body: { id, action: status.active === 'active' ? 'stop' : 'start' } }); await load(false); drawHead(); }, status.active === 'active' ? 'danger' : '', `systemctl ${status.active === 'active' ? 'stop' : 'start'} ${app.unit}`) : null));
  }

  function drawTabs() {
    content.replaceChildren(tabs([
      { id: 'overview', label: 'Overview', render: overview },
      { id: 'history', label: `History (${data.deploys.length})`, render: history },
      { id: 'releases', label: `Releases (${data.releases.length})`, render: releases },
      { id: 'env', label: `Environment (${data.app.envNames.length})`, render: environment },
      { id: 'settings', label: 'Settings', render: settings },
      ...(isAdminUser() && data.app.mode === 'service' ? [{ id: 'logs', label: 'Service logs', render: serviceLogs }] : []),
    ], tabId, (picked) => { tabId = picked; }));
  }

  function overview() {
    const { app, status, releases: rel, deploys, sites } = data;
    const current = rel.find((r) => r.current);
    const last = deploys[0];
    const webhook = isAdminUser() ? webhookCard() : null;
    return h('div', { class: 'two' },
      h('div', { class: 'card' }, h('h2', {}, app.mode === 'service' ? 'Service' : app.mode === 'static' ? 'Website' : 'PHP application'), kv([
        ['Framework', (PRESET_LIST.find((p) => p.id === app.framework) || {}).label || app.framework],
        ['State', h('span', { class: 'badge ' + (['active', 'serving'].includes(status.active) ? 'ok' : 'bad') }, status.active)],
        ...(app.mode === 'service' ? [['Unit', h('code', {}, app.unit)], ['Since', status.since || '–'], ['PID', status.pid || '–'], ['Memory', status.memory ? fmt.bytes(status.memory) : '–'], ['Restarts', String(status.restarts)], ['Listens on', `127.0.0.1:${app.port}`]]
          : [['Served from', h('code', {}, status.serving || '–')], ['How', app.mode === 'static' ? 'nginx serves the files directly' : 'nginx + PHP-FPM']]),
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
        h('button', { class: 'sm', cmd: 'panel: creates a new secret URL for the deploy webhook', onclick: async () => { await api('/api/apps/webhook', { method: 'POST', body: { id, enabled: true } }); await load(); } }, webhookUrl ? 'Rotate secret' : 'Enable'),
        webhookUrl ? h('button', { class: 'sm danger', cmd: 'panel: turns the webhook off', onclick: async () => { await api('/api/apps/webhook', { method: 'POST', body: { id, enabled: false } }); await load(); } }, 'Disable') : null)));
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
      rowActions: isAdminUser() ? (r) => (r.current ? null : (() => { const b = h('button', { class: 'sm', cmd: `ln -sfn ${data.app.baseDir}/${data.app.name}/releases/${r.id} ${data.app.baseDir}/${data.app.name}/current\n${data.app.mode === 'service' ? `systemctl restart ${data.app.unit}   # then checks the old release is healthy` : 'reload the web server, then checks the site answers'}` }, 'Roll back to this'); b.onclick = act(b, async () => {
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
    const reveal = h('button', { class: 'primary', cmd: 'panel: decrypts the stored environment variables and shows them (recorded in the audit log)' }, 'Reveal & edit');
    const save = h('button', { class: 'hidden', cmd: 'panel: stores the variables encrypted. Nothing runs on the server until you apply or deploy.' }, 'Save');
    const isStatic = app.mode === 'static';
    const apply = h('button', { class: 'primary hidden', cmd: isStatic ? deployCmd(app) : `write ${app.baseDir}/${app.name}/shared/.env and env file\nsystemctl restart ${app.unit || 'php-fpm'}` }, isStatic ? 'Save & redeploy' : 'Save & apply now');
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
        if (isStatic) { const d = await api('/api/apps/deploy', { method: 'POST', body: { id } }); logModal(`Rebuilding ${app.name}`, { url: `/api/deploys/log?id=${d.deploy.id}`, onDone: () => load() }); return; }
        apply.textContent = 'Applying…';
        const r = await api('/api/apps/env/apply', { method: 'POST', body: { id } });
        toast(app.mode === 'php' ? 'Saved and applied: config cache refreshed, PHP-FPM reloaded' : 'Saved and applied: the app restarted and is healthy'); void r; await load(false); drawHead();
      } catch (e) { show(e.message); } finally { apply.textContent = isStatic ? 'Save & redeploy' : 'Save & apply now'; }
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
    const form = appForm(app, [], PRESET_LIST || [], null);
    const err = h('div', { class: 'alert crit hidden', role: 'alert' });
    const save = h('button', { class: 'primary', cmd: 'panel: saves the settings. They are used on the next deploy.' }, 'Save settings');
    save.onclick = act(save, async () => {
      err.classList.add('hidden');
      try { const body = form.read(); delete body.env; const sv = await api('/api/apps', { method: 'PUT', body: { id, ...body } }); toast(sv.sitesUpdated && sv.sitesUpdated.length ? `Saved. nginx was regenerated for ${sv.sitesUpdated.join(', ')}. Other settings apply on the next deploy.` : 'Saved. Settings apply on the next deploy.'); if (sv.siteWarnings && sv.siteWarnings.length) fail(new Error(sv.siteWarnings.join('\n'))); await load(); }
      catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    });
    const del = h('button', { class: 'danger', cmd: `systemctl stop ${app.unit || '<app service>'}; systemctl disable ...; rm ${app.unit ? '<unit file>' : ''}\nrm -rf ${app.baseDir}/${app.name}   # only if you tick “also delete the files”` }, 'Delete app…');
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
    return h('div', {}, h('div', { class: 'toolbar' }, lines, h('label', { class: 'row' }, follow, 'Follow'), h('button', { cmd: `journalctl -u ${app.unit || '<service>'} -n <lines> --no-pager`, onclick: () => refresh().catch(fail) }, 'Refresh')), out);
  }

  load().catch((e) => { root.replaceChildren(h('div', { class: 'notice' }, e.message), h('p', {}, h('a', { href: '#/deploy' }, '← Back to apps'))); });
  poll(() => load(false), 10000);
  return root;
}
