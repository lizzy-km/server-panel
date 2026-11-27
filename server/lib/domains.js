'use strict';
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { httpError } = require('./auth');
const { shq } = require('./host');
const { dnsReport, httpReport } = require('./netcheck');
const { summarizeFile } = require('./nginxparse');
const P = require('./presets');

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?(\/[A-Za-z0-9._~/%-]*)?$/;
const ROOT_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;

const MAP_FILE = '00-panel-upgrade-map.conf';
const MAP_CONF = `# Managed by Server Panel: lets nginx proxy WebSocket upgrades only when requested.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
`;

function cleanSite(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  if (!partial || has('domain')) {
    const d = String(input.domain || '').trim().toLowerCase();
    if (!HOST_RE.test(d)) throw httpError(400, 'Enter a valid domain name such as app.example.com (wildcards are not supported)');
    out.domain = d;
  }
  if (has('aliases')) {
    const list = (Array.isArray(input.aliases) ? input.aliases : String(input.aliases || '').split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    if (list.length > 10) throw httpError(400, 'At most 10 alias domains');
    for (const a of list) if (!HOST_RE.test(a)) throw httpError(400, `Invalid alias domain: ${a}`);
    out.aliases = [...new Set(list)];
  }
  if (!partial || has('upstream')) {
    const u = input.upstream || {};
    if (u.type === 'app') {
      if (!u.appId) throw httpError(400, 'Choose an app');
      out.upstream = { type: 'app', appId: String(u.appId) };
    } else if (u.type === 'url') {
      const url = String(u.url || '').trim();
      if (!URL_RE.test(url)) throw httpError(400, 'Upstream must look like http://127.0.0.1:3000');
      const m = url.match(/:(\d{1,5})(\/|$)/);
      if (m && Number(m[1]) > 65535) throw httpError(400, 'Invalid upstream port');
      out.upstream = { type: 'url', url };
    } else if (u.type === 'static') {
      const root = String(u.root || '').trim();
      if (!ROOT_RE.test(root) || root.includes('..')) throw httpError(400, 'Static root must be an absolute path such as /var/www/site');
      out.upstream = { type: 'static', root, spa: !!u.spa };
    } else throw httpError(400, 'Upstream type must be app, url or static');
  }
  if (has('forceHttps')) out.forceHttps = !!input.forceHttps;
  if (has('hsts')) out.hsts = !!input.hsts;
  if (has('maxBodyMb')) {
    const n = Number(input.maxBodyMb);
    if (!Number.isInteger(n) || n < 1 || n > 2048) throw httpError(400, 'Max upload size must be 1-2048 MB');
    out.maxBodyMb = n;
  }
  if (has('rawConfig')) {
    const c = input.rawConfig === null ? '' : String(input.rawConfig);
    if (c.length > 100000 || c.includes('\0')) throw httpError(400, 'The nginx configuration is too large (max 100 KB)');
    out.rawConfig = c.trim() ? c.replace(/\r\n/g, '\n').replace(/\n*$/, '\n') : '';
  }
  if (has('customConfig')) {
    const c = String(input.customConfig || '');
    if (c.length > 8000 || c.includes('\0')) throw httpError(400, 'Custom nginx configuration is too long');
    out.customConfig = c;
  }
  return out;
}

/** Pure function: nginx configuration for one site. */
function renderNginx(site, ctx) {
  const names = [site.domain, ...(site.aliases || [])].join(' ');
  const tls = !!(ctx.tlsActive && site.tls);
  const v6 = ctx.ipv6 !== false;
  const cert = tls ? `${ctx.letsencryptDir}/live/${site.tls.certName}` : null;
  const up = site.upstream;
  const app = ctx.app && (ctx.app.mode === 'static' || ctx.app.mode === 'php') ? ctx.app : null; // {mode, root, spa, fastcgi}
  const body = up.type === 'static'
    ? `        root ${up.root};\n        index index.html;\n        try_files $uri ${up.spa ? '/index.html' : '$uri/ =404'};`
    : `        proxy_pass ${ctx.upstreamUrl};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 120s;`;
  const custom = (site.customConfig || '').trim()
    ? `\n    # ---- custom configuration ----\n${site.customConfig.trim().split('\n').map((l) => '    ' + l).join('\n')}\n`
    : '';
  const rootLines = app ? `    root ${app.root};\n    index ${app.mode === 'php' ? 'index.php index.html' : 'index.html'};\n` : '';
  const common = `    server_name ${names};
${rootLines}    client_max_body_size ${site.maxBodyMb || 10}m;
    access_log ${ctx.logDir}/${site.domain}.access.log;
    error_log ${ctx.logDir}/${site.domain}.error.log;
${custom}`;
  const acme = `    location ^~ /.well-known/acme-challenge/ {
        root ${ctx.acmeRoot};
        default_type "text/plain";
    }`;
  const appLocations = !app ? null : app.mode === 'php'
    ? `    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    location ~ \\.php$ {
        fastcgi_pass ${app.fastcgi};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_read_timeout 120s;
    }
    location ~ /\\.(?!well-known) {
        deny all;
    }`
    : `    location / {
        try_files $uri ${app.spa ? '/index.html' : '$uri/ =404'};
    }
    location ~* \\.(?:css|js|mjs|woff2?|ttf|svg|png|jpe?g|gif|webp|ico)$ {
        expires 7d;
        add_header Cache-Control "public";
        try_files $uri =404;
    }`;
  const proxyLocation = appLocations || `    location / {\n${body}\n    }`;

  let out = `# Managed by Server Panel (site ${site.id}). Edit it in the panel; manual changes are overwritten.\n`;
  if (!tls) {
    out += `server {\n    listen 80;\n${v6 ? '    listen [::]:80;\n' : ''}${common}\n${acme}\n\n${proxyLocation}\n}\n`;
    return out;
  }
  const http2On = ctx.http2 === 'directive';
  out += `server {\n    listen 80;\n${v6 ? '    listen [::]:80;\n' : ''}    server_name ${names};\n    access_log ${ctx.logDir}/${site.domain}.access.log;\n\n${acme}\n\n`;
  out += site.forceHttps !== false ? `    location / {\n        return 301 https://$host$request_uri;\n    }\n}\n\n` : `${proxyLocation}\n}\n\n`;
  out += `server {\n    listen 443 ssl${http2On ? '' : ' http2'};\n${v6 ? `    listen [::]:443 ssl${http2On ? '' : ' http2'};\n` : ''}${http2On ? '    http2 on;\n' : ''}${common}
    ssl_certificate     ${cert}/fullchain.pem;
    ssl_certificate_key ${cert}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
${site.hsts ? '    add_header Strict-Transport-Security "max-age=31536000" always;\n' : ''}
${proxyLocation}
}
`;
  return out;
}

class DomainManager {
  constructor({ store, servers, deploy, config }) { Object.assign(this, { store, servers, deploy, config }); }

  get sites() { return this.store.data.sites; }

  find(id) {
    const s = this.sites.find((x) => x.id === id);
    if (!s) throw httpError(404, 'Unknown domain');
    return s;
  }

  confPath(site) { return `${this.config.nginxConfDir}/${site.confFile || `panel-${site.domain}.conf`}`; }
  mapPath() { return `${this.config.nginxConfDir}/${MAP_FILE}`; }
  certDir(site) { return site.tls ? `${this.config.letsencryptDir}/live/${site.tls.certName}` : null; }

  /** Viewers get the site without its raw nginx text (it can reveal internal addresses); admins get everything. */
  publicSite(site, admin = true) {
    const app = site.upstream.type === 'app' ? this.deploy.apps.find((a) => a.id === site.upstream.appId) : null;
    const out = { ...site, manual: !!site.rawConfig, appName: app ? app.name : null, upstreamLabel: this.upstreamLabel(site, app) };
    if (!admin) { delete out.rawConfig; delete out.customConfig; }
    return out;
  }
  upstreamLabel(site, app) {
    const u = site.upstream;
    if (u.type === 'external') return `existing config (${u.kind}${u.root ? `: ${u.root}` : u.target ? `: ${u.target}` : ''})`;
    return u.type === 'app' ? `app: ${app ? app.name : '(deleted)'}${app ? ` (${P.BY_ID[app.framework || 'node'].label.split(' (')[0]})` : ''}` : u.type === 'url' ? u.url : `static: ${u.root}`;
  }
  list(serverId, admin = true) { return this.sites.filter((s) => s.serverId === serverId).map((s) => this.publicSite(s, admin)); }

  upstreamUrl(site) {
    const u = site.upstream;
    if (u.type === 'url') return u.url;
    if (u.type === 'app') {
      const app = this.deploy.apps.find((a) => a.id === u.appId);
      if (!app) throw httpError(400, 'The app this domain points to no longer exists');
      return P.resolve(app).mode === 'service' ? `http://127.0.0.1:${app.port}` : null;
    }
    return null;
  }

  /** For apps that nginx serves directly (static builds, PHP): where the files are and how to serve them. */
  appCtx(site) {
    if (!site.upstream || site.upstream.type !== 'app') return null;
    const app = this.deploy.apps.find((a) => a.id === site.upstream.appId);
    if (!app) return null;
    const cfg = P.resolve(app);
    return cfg.mode === 'service' ? null : { mode: cfg.mode, root: `${this.deploy.appDir(app)}/live`, spa: cfg.spa, fastcgi: this.config.phpSocket };
  }

  validateOwnership(serverId, v, selfId) {
    const all = [v.domain, ...(v.aliases || [])].filter(Boolean);
    for (const s of this.sites) {
      if (s.id === selfId) continue;
      const theirs = [s.domain, ...(s.aliases || [])];
      const clash = all.find((n) => theirs.includes(n));
      if (clash && s.serverId === serverId) throw httpError(409, `${clash} is already configured on this server`);
    }
    if (v.upstream && v.upstream.type === 'app') {
      const app = this.deploy.apps.find((a) => a.id === v.upstream.appId && a.serverId === serverId);
      if (!app) throw httpError(400, 'That app does not exist on this server');
    }
  }

  // ------------------------------------------------------------------ nginx on the target

  nginxArgs(extra) { return [...(this.config.nginxConf ? ['-c', this.config.nginxConf] : []), ...extra]; }

  async nginxVersion(host) {
    const r = await host.runPriv('nginx', ['-v']);
    const m = (r.stderr + r.stdout).match(/nginx\/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  /** Hosts booted with ipv6.disable=1 make nginx reject `listen [::]:80`, so only emit IPv6 listeners when supported. */
  async hasIpv6(host) {
    const r = await host.run('test', ['-e', '/proc/net/if_inet6']);
    return r.ok;
  }

  async nginxTest(host) {
    const r = await host.runPriv('nginx', this.nginxArgs(['-t']));
    if (r.missing || /command not found/.test(r.stderr)) throw httpError(400, 'nginx is not installed on this server (Deploy → Prepare server)');
    return { ok: r.ok, output: (r.stderr + r.stdout).trim() };
  }

  async reload(host) {
    let r = await host.runPriv('systemctl', ['reload', 'nginx']);
    if (!r.ok) r = await host.runPriv('systemctl', ['restart', 'nginx']);
    if (!r.ok) throw httpError(500, `Configuration is valid but nginx could not be reloaded: ${(r.stderr || r.stdout).trim()}`);
  }

  async readFile(host, p) {
    const r = await host.runPriv('cat', [p]);
    return r.ok ? r.stdout : null;
  }
  async writeFile(host, p, content) {
    const r = await host.runPriv('tee', [p], { stdin: content });
    if (!r.ok) throw httpError(500, `Could not write ${p}: ${(r.stderr || '').trim()}`);
  }

  /** Render, write, `nginx -t`, reload. On a failed test the previous file is restored. */
  async apply(site) {
    const e = this.servers.entry(site.serverId);
    const host = e.host;
    const version = await this.nginxVersion(host);
    if (!version) throw httpError(400, 'nginx is not installed on this server (Deploy → Prepare server)');
    const http2 = version[0] > 1 || (version[0] === 1 && (version[1] > 25 || (version[1] === 25 && version[2] >= 1))) ? 'directive' : 'listen';
    const conf = site.rawConfig ? site.rawConfig : renderNginx(site, {
      ipv6: await this.hasIpv6(host), upstreamUrl: this.upstreamUrl(site), app: this.appCtx(site), tlsActive: !!site.tls, letsencryptDir: this.config.letsencryptDir,
      acmeRoot: this.config.acmeRoot, logDir: this.config.nginxLogDir, http2,
    });
    const p = this.confPath(site);
    const prev = await this.readFile(host, p);
    await host.runPriv('mkdir', ['-p', this.config.acmeRoot]);
    if ((await this.readFile(host, this.mapPath())) !== MAP_CONF) await this.writeFile(host, this.mapPath(), MAP_CONF);
    await this.writeFile(host, p, conf);
    const t = await this.nginxTest(host);
    if (!t.ok) {
      if (prev === null) await host.runPriv('rm', ['-f', p]); else await this.writeFile(host, p, prev);
      throw httpError(400, `nginx rejected the configuration, so nothing was changed:\n${t.output}`);
    }
    await this.reload(host);
    return { config: conf, test: t.output };
  }

  async removeConfig(site) {
    const host = this.servers.entry(site.serverId).host;
    await host.runPriv('rm', ['-f', this.confPath(site)]);
    const t = await this.nginxTest(host).catch(() => ({ ok: false }));
    if (t.ok) await this.reload(host).catch(() => {});
  }

  async preview(site) {
    if (site.rawConfig) return site.rawConfig;
    const host = this.servers.entry(site.serverId).host;
    const version = (await this.nginxVersion(host).catch(() => null)) || [1, 28, 0];
    const http2 = version[0] > 1 || version[1] > 25 || (version[1] === 25 && version[2] >= 1) ? 'directive' : 'listen';
    return renderNginx(site, { ipv6: await this.hasIpv6(host), upstreamUrl: this.upstreamUrl(site), app: this.appCtx(site), tlsActive: !!site.tls, letsencryptDir: this.config.letsencryptDir, acmeRoot: this.config.acmeRoot, logDir: this.config.nginxLogDir, http2 });
  }

  // ------------------------------------------------------------------ editing nginx files directly

  mainConfPath() { return this.config.nginxConf || '/etc/nginx/nginx.conf'; }
  isManaged(name) { return /^panel-.*\.conf$/.test(name) || name === MAP_FILE; }

  /** name -> absolute path, only for nginx.conf and plain *.conf files directly inside conf.d */
  filePath(name) {
    const n = String(name || '');
    if (n === 'nginx.conf') return this.mainConfPath();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.conf$/.test(n)) throw httpError(400, 'File names must look like my-site.conf (letters, digits, dots, dashes; no folders)');
    return `${this.config.nginxConfDir}/${n}`;
  }

  async listFiles(serverId) {
    const host = this.servers.entry(serverId).host;
    const r = await host.runPriv('find', [this.config.nginxConfDir, '-maxdepth', '1', '-type', 'f', '-name', '*.conf', '-printf', '%f\t%s\t%T@\n']);
    const files = [{ name: 'nginx.conf', path: this.mainConfPath(), main: true, managed: false }];
    for (const line of r.stdout.split('\n')) {
      const [name, size, mtime] = line.split('\t');
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.conf$/.test(name)) continue;
      files.push({ name, path: `${this.config.nginxConfDir}/${name}`, size: Number(size), mtime: Math.round(parseFloat(mtime) * 1000), managed: this.isManaged(name) });
    }
    return files.sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || a.name.localeCompare(b.name));
  }

  async readConfFile(serverId, name) {
    const host = this.servers.entry(serverId).host;
    const content = await this.readFile(host, this.filePath(name));
    if (content === null) throw httpError(404, 'File not found');
    return { name, managed: this.isManaged(name), content };
  }

  /** Write + `nginx -t` + reload; the previous content is restored if nginx rejects the result. */
  async saveConfFile(serverId, name, content) {
    if (typeof content !== 'string' || content.length > 500000 || content.includes('\0')) throw httpError(400, 'Invalid or too large file content (max 500 KB)');
    if (this.isManaged(name)) throw httpError(400, 'This file is generated by the panel. Change it from the domain\'s page (Configuration → manual mode) instead.');
    const host = this.servers.entry(serverId).host;
    const p = this.filePath(name);
    const prev = await this.readFile(host, p);
    const body = content.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
    if (prev !== null) await host.runPriv('cp', ['-p', p, `${p}.panel-bak`]);
    await this.writeFile(host, p, body);
    const t = await this.nginxTest(host);
    if (!t.ok) {
      if (prev === null) await host.runPriv('rm', ['-f', p]); else await this.writeFile(host, p, prev);
      throw httpError(400, `nginx rejected the configuration, so nothing was changed:\n${t.output}`);
    }
    await this.reload(host);
    const owner = this.sites.find((x) => x.serverId === serverId && x.confFile === name);
    if (owner) { owner.rawConfig = body; this.store.save(); }
    return { ok: true, created: prev === null, test: t.output };
  }

  async deleteConfFile(serverId, name) {
    if (name === 'nginx.conf') throw httpError(400, 'nginx.conf cannot be deleted');
    if (this.isManaged(name)) throw httpError(400, 'Managed files are removed by deleting the domain.');
    const host = this.servers.entry(serverId).host;
    const p = this.filePath(name);
    const prev = await this.readFile(host, p);
    if (prev === null) throw httpError(404, 'File not found');
    await host.runPriv('rm', ['-f', p]);
    const t = await this.nginxTest(host);
    if (!t.ok) { await this.writeFile(host, p, prev); throw httpError(400, `Deleting this file breaks the nginx configuration, so it was restored:\n${t.output}`); }
    await this.reload(host);
    return { ok: true };
  }

  // ------------------------------------------------------------------ adopting hand-written sites

  /** Unmanaged files in conf.d that define real sites, with what we could read from them. */
  async discover(serverId) {
    const host = this.servers.entry(serverId).host;
    const files = (await this.listFiles(serverId)).filter((f) => !f.main && !f.managed);
    const out = [];
    for (const f of files) {
      const text = await this.readFile(host, f.path);
      if (text === null) continue;
      const sum = summarizeFile(text);
      if (!sum.servers || sum.onlyDefault || !sum.names.length) continue;
      const adopted = this.sites.find((x) => x.serverId === serverId && x.confFile === f.name);
      out.push({
        file: f.name, size: f.size, names: sum.names, kind: sum.kind, root: sum.root, target: sum.proxy || sum.fastcgi,
        https: !!sum.sslCert, redirectsToHttps: sum.redirectsToHttps, cert: sum.sslCert,
        laravelPath: sum.kind === 'php' && sum.root && /\/public\/?$/.test(sum.root) ? sum.root.replace(/\/public\/?$/, '') : null,
        adopted: adopted ? adopted.id : null,
      });
    }
    return out;
  }

  /** Take over an existing nginx file in place: nothing is rewritten, the panel just starts managing it. */
  async adopt(serverId, file, user) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.conf$/.test(String(file || '')) || this.isManaged(file)) throw httpError(400, 'Choose one of the existing nginx files');
    if (this.sites.some((x) => x.serverId === serverId && x.confFile === file)) throw httpError(409, 'That file is already managed by the panel');
    const host = this.servers.entry(serverId).host;
    const text = await this.readFile(host, `${this.config.nginxConfDir}/${file}`);
    if (text === null) throw httpError(404, 'File not found');
    const sum = summarizeFile(text);
    const valid = sum.names.filter((n) => HOST_RE.test(n));
    if (!valid.length) throw httpError(400, 'No domain names (server_name) found in that file');
    const [domain, ...aliases] = valid;
    this.validateOwnership(serverId, { domain, aliases });
    let tls = null;
    if (sum.sslCert) {
      const m = sum.sslCert.match(new RegExp(`^${this.config.letsencryptDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/live/([^/]+)/fullchain\\.pem$`));
      tls = m ? { certName: m[1], email: null, staging: false, adopted: true, issuedAt: null } : { external: true, certFile: sum.sslCert, adopted: true };
    }
    const site = {
      id: crypto.randomUUID(), serverId, domain, aliases, adopted: true, confFile: file,
      upstream: { type: 'external', kind: sum.kind, root: sum.root, target: sum.proxy || sum.fastcgi },
      forceHttps: sum.redirectsToHttps, hsts: false, maxBodyMb: 10, customConfig: '', rawConfig: text.replace(/\n*$/, '\n'),
      tls, created: new Date().toISOString(), createdBy: user,
    };
    // the stored copy must equal the file byte for byte, otherwise "in sync" would lie
    site.rawConfig = text;
    this.sites.push(site);
    this.store.save();
    return site;
  }

  // ------------------------------------------------------------------ CRUD

  async create(serverId, input, user) {
    const v = cleanSite(input);
    this.validateOwnership(serverId, v);
    const site = {
      id: crypto.randomUUID(), serverId, aliases: [], forceHttps: true, hsts: false, maxBodyMb: 10, customConfig: '', ...v,
      tls: null, created: new Date().toISOString(), createdBy: user,
    };
    await this.apply(site); // validates against the real nginx before anything is saved
    this.sites.push(site);
    this.store.save();
    return site;
  }

  async update(id, input) {
    const site = this.find(id);
    const v = cleanSite(input, { partial: true });
    if (v.domain && v.domain !== site.domain) throw httpError(400, 'The primary domain cannot be changed; add a new domain instead');
    this.validateOwnership(site.serverId, v, id);
    const next = { ...site, ...v };
    await this.apply(next);
    Object.assign(site, v);
    this.store.save();
    return site;
  }

  async remove(id, { removeCert = false, keepFile } = {}) {
    const site = this.find(id);
    // an adopted (hand-written) site is only forgotten by default: its nginx file is left exactly as it was
    if (!(site.adopted && keepFile !== false)) await this.removeConfig(site);
    if (removeCert && site.tls) await this.certDelete(site).catch(() => {});
    this.store.data.sites = this.sites.filter((s) => s.id !== id);
    this.store.save();
  }

  // ------------------------------------------------------------------ certificates (certbot / Let's Encrypt)

  async certInfo(site) {
    if (!site.tls) return null;
    const host = this.servers.entry(site.serverId).host;
    const r = await host.runPriv('openssl', ['x509', '-in', site.tls.certFile || `${this.certDir(site)}/fullchain.pem`, '-noout', '-enddate', '-issuer', '-subject', '-ext', 'subjectAltName']);
    if (!r.ok) return { present: false, error: (r.stderr || 'certificate file not readable').trim() };
    const end = (r.stdout.match(/notAfter=(.+)/) || [])[1];
    const issuer = (r.stdout.match(/issuer=(.+)/) || [])[1] || '';
    const names = (r.stdout.match(/DNS:[^\s,]+/g) || []).map((x) => x.slice(4));
    const validTo = end ? Date.parse(end) : NaN;
    return {
      present: true, validTo: Number.isFinite(validTo) ? validTo : null, daysLeft: Number.isFinite(validTo) ? Math.floor((validTo - Date.now()) / 86400000) : null,
      issuer: issuer.replace(/^.*O\s*=\s*/, '').replace(/,.*/, '').trim() || issuer.trim(), names, staging: !!site.tls.staging,
    };
  }

  async issue(id, { email, staging = false }) {
    const site = this.find(id);
    if (site.tls && site.tls.external) throw httpError(400, 'This domain uses a certificate the panel did not issue; manage it where you created it.');
    if (!/^[^\s@'"\\]+@[^\s@'"\\]+\.[A-Za-z]{2,}$/.test(String(email || ''))) throw httpError(400, 'A valid email address is required (Let\'s Encrypt sends expiry warnings there)');
    if (site.rawConfig && !site.rawConfig.includes('.well-known/acme-challenge')) {
      throw httpError(400, `This domain uses a manual nginx configuration without a /.well-known/acme-challenge/ location, so Let's Encrypt cannot validate it. Add:\n\nlocation ^~ /.well-known/acme-challenge/ { root ${this.config.acmeRoot}; }\n\n(or switch back to the generated configuration).`);
    }
    const host = this.servers.entry(site.serverId).host;
    const names = [site.domain, ...(site.aliases || [])];
    const args = ['certonly', '--webroot', '-w', this.config.acmeRoot, '--cert-name', site.domain, ...names.flatMap((n) => ['-d', n]),
      '--email', email, '--agree-tos', '--no-eff-email', '--non-interactive', '--deploy-hook', 'systemctl reload nginx'];
    if (staging) args.push('--staging');
    if (this.config.letsencryptDir !== '/etc/letsencrypt') args.push('--config-dir', this.config.letsencryptDir);
    await this.apply(site); // make sure port 80 currently serves the ACME challenge path
    const r = await host.runPriv('certbot', args, { timeout: 240000 });
    if (r.missing || /command not found/.test(r.stderr)) throw httpError(400, 'certbot is not installed on this server (Deploy → Prepare server)');
    const output = (r.stdout + '\n' + r.stderr).trim().slice(-6000);
    if (!r.ok) throw Object.assign(httpError(400, `Certificate request failed:\n${output.slice(-1800)}`), { output });
    site.tls = { certName: site.domain, email, staging: !!staging, issuedAt: new Date().toISOString() };
    try { await this.apply(site); } catch (e) { site.tls = null; throw e; }
    this.store.save();
    return { output, manual: !!site.rawConfig, certDir: this.certDir(site) };
  }

  async renew(id) {
    const site = this.find(id);
    if (!site.tls) throw httpError(400, 'No certificate to renew');
    if (site.tls.external) throw httpError(400, 'This certificate is not managed by certbot, so the panel cannot renew it.');
    const host = this.servers.entry(site.serverId).host;
    const args = ['renew', '--cert-name', site.tls.certName, '--force-renewal', '--non-interactive'];
    if (this.config.letsencryptDir !== '/etc/letsencrypt') args.push('--config-dir', this.config.letsencryptDir);
    const r = await host.runPriv('certbot', args, { timeout: 240000 });
    const output = (r.stdout + '\n' + r.stderr).trim().slice(-6000);
    if (!r.ok) throw Object.assign(httpError(400, `Renewal failed:\n${output.slice(-1800)}`), { output });
    await this.reload(host).catch(() => {});
    return { output };
  }

  async certDelete(site) {
    const host = this.servers.entry(site.serverId).host;
    const args = ['delete', '--cert-name', site.tls.certName, '--non-interactive'];
    if (this.config.letsencryptDir !== '/etc/letsencrypt') args.push('--config-dir', this.config.letsencryptDir);
    const r = await host.runPriv('certbot', args, { timeout: 60000 });
    if (!r.ok) throw httpError(400, (r.stderr || r.stdout).trim().slice(-800));
  }

  async removeCert(id) {
    const site = this.find(id);
    if (!site.tls) throw httpError(400, 'This domain has no certificate');
    const prev = site.tls;
    site.tls = null;
    try { await this.apply(site); } catch (e) { site.tls = prev; throw e; }
    await this.certDelete({ ...site, tls: prev, serverId: site.serverId }).catch(() => {});
    this.store.save();
  }

  // ------------------------------------------------------------------ status & diagnostics

  async nginxStatus(serverId) {
    const host = this.servers.entry(serverId).host;
    const [v, t, active, timer] = await Promise.all([
      this.nginxVersion(host).catch(() => null), this.nginxTest(host).catch((e) => ({ ok: false, output: e.message, missing: true })),
      host.run('systemctl', ['is-active', 'nginx']), host.run('systemctl', ['is-active', 'certbot-renew.timer']),
    ]);
    return {
      installed: !!v, version: v ? v.join('.') : null, configOk: t.ok, configOutput: t.output || '',
      active: active.stdout.trim() === 'active', renewalTimer: timer.stdout.trim() === 'active',
    };
  }

  async serverIps(serverId) {
    const e = this.servers.entry(serverId);
    const aws = this.servers.awsMeta(e);
    const ips = new Set();
    if (aws && aws.publicIp) ips.add(aws.publicIp);
    const addr = e.host.address;
    if (addr) {
      if (net.isIP(addr)) ips.add(addr);
      else { try { for (const ip of await dns.promises.resolve4(addr)) ips.add(ip); } catch { /* ignore */ } }
    }
    return [...ips];
  }

  async status(site) {
    const e = this.servers.entry(site.serverId);
    const [current, cert] = await Promise.all([this.readFile(e.host, this.confPath(site)), this.certInfo(site).catch((er) => ({ present: false, error: er.message }))]);
    let inSync = false;
    try { inSync = current !== null && current === await this.preview(site); } catch { /* ignore */ }
    return { configPresent: current !== null, inSync, certificate: cert };
  }

  async dns(site, opts = {}) {
    const ips = await this.serverIps(site.serverId);
    const names = [site.domain, ...(site.aliases || [])];
    const reports = [];
    const extra = this.config.dnsResolverFactory ? { resolverFactory: this.config.dnsResolverFactory } : {}; // test seam
    for (const n of names) reports.push(await dnsReport(n, { expectedIps: ips, includeRecords: n === site.domain, ...extra, ...opts }));
    return { serverIps: ips, reports };
  }

  async http(site, opts = {}) {
    opts = { ...(this.config.httpCheckOptions || {}), ...opts }; // test seam (ports / forced address)
    const ips = await this.serverIps(site.serverId);
    const viaDns = await httpReport(site.domain, opts);
    const direct = ips[0] ? await httpReport(site.domain, { ...opts, resolveTo: ips[0] }) : null;
    return { viaDns, direct, serverIps: ips };
  }

  async logs(site, kind, lines = 200) {
    if (!['access', 'error'].includes(kind)) throw httpError(400, 'kind must be access or error');
    const host = this.servers.entry(site.serverId).host;
    const n = Math.max(1, Math.min(2000, Number(lines) || 200));
    const r = await host.runPriv('tail', ['-n', String(n), `${this.config.nginxLogDir}/${site.domain}.${kind}.log`]);
    return { output: r.ok ? r.stdout : (r.stderr || 'No log file yet.').trim() };
  }
}

module.exports = { DomainManager, renderNginx, cleanSite, MAP_CONF, HOST_RE };
