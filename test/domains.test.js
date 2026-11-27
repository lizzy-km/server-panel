'use strict';
/**
 * Domain management: unit tests (renderer, validators, DNS and HTTP diagnostics) plus end-to-end tests
 * against a real sshd with REAL nginx validation (`nginx -t`) and a fake certbot that mints self-signed certs.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');
const { canTarget, hasBin, makeStack, tmp, freePort } = require('./helpers');
const { renderNginx, cleanSite } = require('../server/lib/domains');
const { dnsReport, httpReport } = require('../server/lib/netcheck');

const baseCtx = { upstreamUrl: 'http://127.0.0.1:3000', tlsActive: false, letsencryptDir: '/etc/letsencrypt', acmeRoot: '/var/www/letsencrypt', logDir: '/var/log/nginx', http2: 'directive' };
const site = (over = {}) => ({ id: 'sid', domain: 'app.example.com', aliases: ['www.example.com'], upstream: { type: 'url', url: 'http://127.0.0.1:3000' }, forceHttps: true, hsts: false, maxBodyMb: 10, customConfig: '', tls: null, ...over });

test('renderNginx: HTTP-only site proxies and serves the ACME challenge path', () => {
  const c = renderNginx(site(), baseCtx);
  assert.match(c, /listen 80;/);
  assert.match(c, /server_name app\.example\.com www\.example\.com;/);
  assert.match(c, /location \^~ \/\.well-known\/acme-challenge\/ \{\s+root \/var\/www\/letsencrypt;/);
  assert.match(c, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(c, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(c, /client_max_body_size 10m;/);
  assert.ok(!c.includes('443'), 'no TLS block without a certificate');
});

test('renderNginx: with a certificate it redirects HTTP to HTTPS and serves 443', () => {
  const tls = { certName: 'app.example.com' };
  const c = renderNginx(site({ tls, hsts: true }), { ...baseCtx, tlsActive: true });
  assert.match(c, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(c, /listen 443 ssl;/);
  assert.match(c, /http2 on;/);
  assert.match(c, /ssl_certificate\s+\/etc\/letsencrypt\/live\/app\.example\.com\/fullchain\.pem;/);
  assert.match(c, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/app\.example\.com\/privkey\.pem;/);
  assert.match(c, /Strict-Transport-Security/);
  const old = renderNginx(site({ tls }), { ...baseCtx, tlsActive: true, http2: 'listen' });
  assert.match(old, /listen 443 ssl http2;/);
  assert.ok(!old.includes('http2 on;'), 'older nginx gets the listen-parameter form');
  const noForce = renderNginx(site({ tls, forceHttps: false }), { ...baseCtx, tlsActive: true });
  assert.ok(!noForce.includes('return 301'), 'HTTP is proxied when forceHttps is off');
});

test('renderNginx: IPv6 listeners are omitted on hosts without IPv6', () => {
  const tls = { certName: 'app.example.com' };
  assert.match(renderNginx(site(), baseCtx), /listen \[::\]:80;/);
  assert.ok(!renderNginx(site(), { ...baseCtx, ipv6: false }).includes('[::]'));
  const c = renderNginx(site({ tls }), { ...baseCtx, tlsActive: true, ipv6: false });
  assert.ok(!c.includes('[::]') && c.includes('listen 443 ssl;') && c.includes('listen 80;'));
  assert.equal((renderNginx(site({ tls }), { ...baseCtx, tlsActive: true }).match(/\[::\]/g) || []).length, 2, 'one :80 and one :443 listener when IPv6 is available');
});

test('renderNginx: static sites (with SPA fallback) and custom snippets', () => {
  const st = renderNginx(site({ upstream: { type: 'static', root: '/var/www/site', spa: true } }), baseCtx);
  assert.match(st, /root \/var\/www\/site;/);
  assert.match(st, /try_files \$uri \/index\.html;/);
  assert.ok(!st.includes('proxy_pass'));
  assert.match(renderNginx(site({ upstream: { type: 'static', root: '/var/www/s', spa: false } }), baseCtx), /try_files \$uri \$uri\/ =404;/);
  const cu = renderNginx(site({ customConfig: 'add_header X-Test "1";' }), baseCtx);
  assert.match(cu, /custom configuration[\s\S]*add_header X-Test "1";/);
});

test('domain input is validated (no config injection)', () => {
  for (const d of ['a.com; rm -rf /', 'evil.com}{', 'with space.com', '*.example.com', 'localhost', 'UPPER..case', '-bad.example.com', 'a'.repeat(64) + '.com', '', 'x.com\nserver {']) {
    assert.throws(() => cleanSite({ domain: d, upstream: { type: 'url', url: 'http://127.0.0.1:1' } }), /valid domain/, JSON.stringify(d));
  }
  assert.equal(cleanSite({ domain: 'App.Example.COM', upstream: { type: 'url', url: 'http://127.0.0.1:1' } }).domain, 'app.example.com');
  for (const url of ['http://127.0.0.1:3000;', 'http://a b', 'ftp://x:1', 'http://x/$y', 'http://127.0.0.1:99999', '']) assert.throws(() => cleanSite({ domain: 'a.example.com', upstream: { type: 'url', url } }), /Upstream|port/, url);
  for (const root of ['/var/www/a b', '/var/../etc', 'relative', '/x;y']) assert.throws(() => cleanSite({ domain: 'a.example.com', upstream: { type: 'static', root } }), /Static root/, root);
  assert.throws(() => cleanSite({ domain: 'a.example.com', aliases: 'ok.example.com, bad domain', upstream: { type: 'url', url: 'http://127.0.0.1:1' } }), /Invalid alias/);
  assert.throws(() => cleanSite({ domain: 'a.example.com', upstream: { type: 'url', url: 'http://127.0.0.1:1' }, maxBodyMb: 0 }), /Max upload/);
  assert.deepEqual(cleanSite({ domain: 'a.example.com', aliases: 'www.a.example.com b.example.com', upstream: { type: 'app', appId: 'x' } }).aliases, ['www.a.example.com', 'b.example.com']);
});

// ---- DNS diagnostics with injected resolvers ----

const answers = (map) => (server) => {
  const a = map[server || 'system'] || map.system;
  const rr = (key) => async () => { const v = a[key]; if (v instanceof Error) throw v; if (!v || !v.length) { const e = new Error('nodata'); e.code = 'ENODATA'; throw e; } return v; };
  return { resolve4: rr('a'), resolve6: rr('aaaa'), resolveCname: rr('cname'), resolveNs: rr('ns'), resolveMx: rr('mx'), resolveTxt: rr('txt'), resolveCaa: rr('caa') };
};

test('dnsReport: verdicts for correct, wrong, missing and error DNS', async () => {
  const same = { a: ['203.0.113.9'] };
  const ok = await dnsReport('app.example.com', { expectedIps: ['203.0.113.9'], resolverFactory: answers({ system: same, '1.1.1.1': same, '8.8.8.8': same }) });
  assert.equal(ok.verdict, 'ok');
  assert.equal(ok.resolvers.length, 3);
  assert.deepEqual(ok.notes, []);

  const wrong = await dnsReport('app.example.com', { expectedIps: ['203.0.113.9'], resolverFactory: answers({ system: { a: ['198.51.100.1'] }, '1.1.1.1': { a: ['203.0.113.9'] }, '8.8.8.8': { a: ['198.51.100.1'] } }) });
  assert.equal(wrong.verdict, 'mismatch');
  assert.ok(wrong.notes.some((n) => /198\.51\.100\.1.*203\.0\.113\.9/.test(n)));
  assert.ok(wrong.notes.some((n) => /propagating/.test(n)), 'resolver disagreement is called out');

  const nx = Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  const none = await dnsReport('app.example.com', { expectedIps: ['203.0.113.9'], resolverFactory: answers({ system: { a: nx, aaaa: nx, cname: nx } }) });
  assert.equal(none.verdict, 'none');
  assert.ok(none.resolvers[0].nxdomain);

  const timeout = Object.assign(new Error('t'), { code: 'ETIMEOUT' });
  assert.equal((await dnsReport('x.example.com', { expectedIps: ['1.1.1.1'], resolverFactory: answers({ system: { a: timeout } }) })).verdict, 'error');
  assert.equal((await dnsReport('x.example.com', { expectedIps: [], resolverFactory: answers({ system: same }) })).verdict, 'unknown');
});

test('dnsReport: warns about AAAA records and CAA records that block Let\'s Encrypt', async () => {
  const sys = { a: ['203.0.113.9'], aaaa: ['2001:db8::1'], ns: ['ns1.example.com'], mx: [{ priority: 20, exchange: 'b.mx' }, { priority: 10, exchange: 'a.mx' }], txt: [['v=spf1 ', '-all']], caa: [{ critical: 0, issue: 'digicert.com' }] };
  const r = await dnsReport('app.example.com', { expectedIps: ['203.0.113.9'], resolverFactory: answers({ system: sys, '1.1.1.1': sys, '8.8.8.8': sys }) });
  assert.ok(r.notes.some((n) => /AAAA/.test(n)));
  assert.ok(r.notes.some((n) => /CAA.*letsencrypt\.org/.test(n)));
  assert.deepEqual(r.records.mx.map((m) => m.exchange), ['a.mx', 'b.mx'], 'MX sorted by priority');
  assert.deepEqual(r.records.txt, ['v=spf1 -all']);
  const allowed = { ...sys, aaaa: [], caa: [{ critical: 0, issue: 'letsencrypt.org' }] };
  const ok = await dnsReport('app.example.com', { expectedIps: ['203.0.113.9'], resolverFactory: answers({ system: allowed, '1.1.1.1': allowed, '8.8.8.8': allowed }) });
  assert.deepEqual(ok.notes, []);
});

// ---- HTTP diagnostics against local servers ----

const haveOpenssl = hasBin('openssl');
function selfSigned(dir, cn) {
  const key = path.join(dir, `${cn}.key`); const crt = path.join(dir, `${cn}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`, '-keyout', key, '-out', crt], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('httpReport: redirect, certificate details, untrusted and mismatched certificates', { skip: !haveOpenssl }, async () => {
  const dir = tmp('http-');
  const httpSrv = http.createServer((q, r) => { r.writeHead(301, { Location: 'https://app.test.example/', Server: 'nginx' }); r.end(); });
  const httpsSrv = https.createServer(selfSigned(dir, 'app.test.example'), (q, r) => { r.writeHead(200, { 'Strict-Transport-Security': 'max-age=1' }); r.end('ok'); });
  const [hp, sp] = [await listen(httpSrv), await listen(httpsSrv)];
  try {
    const r = await httpReport('app.test.example', { httpPort: hp, httpsPort: sp, resolveTo: '127.0.0.1' });
    assert.equal(r.via, 'direct to 127.0.0.1');
    assert.equal(r.http.status, 301);
    assert.equal(r.http.location, 'https://app.test.example/');
    assert.equal(r.https.status, 200);
    assert.equal(r.https.cert.subject, 'app.test.example');
    assert.ok(r.https.cert.daysLeft >= 29 && r.https.cert.daysLeft <= 30);
    assert.equal(r.https.cert.authorized, false);
    assert.ok(r.notes.some((n) => /not trusted/.test(n)));
    assert.ok(!r.notes.some((n) => /redirect to HTTPS/.test(n)), 'redirect present, so no warning');
    const wrongName = await httpReport('other.test.example', { httpPort: hp, httpsPort: sp, resolveTo: '127.0.0.1' });
    assert.ok(wrongName.notes.some((n) => /does not cover other\.test\.example/.test(n)));
  } finally { httpSrv.close(); httpsSrv.close(); }
});

test('httpReport: a port that speaks plain HTTP on 443 gets a readable explanation', async () => {
  const plain = http.createServer((q, r) => r.end('hi'));
  const port = await listen(plain);
  try {
    const r = await httpReport('app.test.example', { httpPort: port, httpsPort: port, resolveTo: '127.0.0.1' });
    assert.equal(r.https.ok, false);
    assert.match(r.https.error, /did not answer with TLS/);
    assert.ok(!/openssl|deps\//i.test(r.https.error), 'no raw OpenSSL text');
  } finally { plain.close(); }
});

test('httpReport: flags a missing HTTPS redirect and reports closed ports clearly', async () => {
  const plain = http.createServer((q, r) => r.end('hi'));
  const port = await listen(plain);
  const closed = await freePort();
  try {
    const r = await httpReport('app.test.example', { httpPort: port, httpsPort: closed, resolveTo: '127.0.0.1' });
    assert.equal(r.http.status, 200);
    assert.equal(r.https.ok, false);
    assert.equal(r.https.error, 'Connection refused');
    assert.ok(r.notes.some((n) => /HTTPS \(port 443\): Connection refused/.test(n)));
    const both = await httpReport('app.test.example', { httpPort: closed, httpsPort: closed, resolveTo: '127.0.0.1' });
    assert.ok(both.notes.some((n) => /security group/.test(n)));
  } finally { plain.close(); }
});

// ---- end to end ----

const skip = !canTarget() || !hasBin('nginx');
let st, hp, sp, httpSrv, httpsSrv;
const conf = (domain) => path.join(st.target.dirs.conf, `panel-${domain}.conf`);
const readConf = (d) => fs.readFileSync(conf(d), 'utf8');
const reloads = () => { try { return fs.readFileSync(path.join(st.target.state, 'nginx.reloads'), 'utf8').trim().split('\n').length; } catch { return 0; } };
let siteId;

before(async () => {
  if (skip) return;
  st = await makeStack();
  // diagnostics endpoints must not touch the real network
  st.app.config.dnsResolverFactory = answers({ system: { a: ['127.0.0.1'] }, '1.1.1.1': { a: ['127.0.0.1'] }, '8.8.8.8': { a: ['127.0.0.1'] } });
  httpSrv = http.createServer((q, r) => { r.writeHead(301, { Location: 'https://web.test.example/' }); r.end(); });
  hp = await listen(httpSrv);
  if (haveOpenssl) { httpsSrv = https.createServer(selfSigned(tmp('e2e-cert-'), 'web.test.example'), (q, r) => r.end('ok')); sp = await listen(httpsSrv); }
  st.app.config.httpCheckOptions = { httpPort: hp, httpsPort: sp || hp, resolveTo: '127.0.0.1' };
});
after(() => { if (!skip) { st.stop(); httpSrv.close(); if (httpsSrv) httpsSrv.close(); } });

test('nginx status before any site exists', { skip }, async () => {
  const r = await st.call('GET', '/api/nginx/status');
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.installed, true);
  assert.match(r.json.version, /^1\.\d+\.\d+$/);
  assert.equal(r.json.configOk, true);
  assert.equal(r.json.active, false);
  assert.equal(r.json.renewalTimer, false);
});

test('adding a domain writes an nginx config, validates it with nginx -t and reloads', { skip }, async () => {
  const before = reloads();
  const r = await st.call('POST', '/api/sites', { domain: 'Web.Test.Example', aliases: 'www.web.test.example', upstream: { type: 'url', url: 'http://127.0.0.1:3999' }, maxBodyMb: 25 });
  assert.equal(r.status, 200, r.raw);
  siteId = r.json.site.id;
  assert.equal(r.json.site.domain, 'web.test.example', 'normalised to lower case');
  const c = readConf('web.test.example');
  assert.match(c, /server_name web\.test\.example www\.web\.test\.example;/);
  assert.match(c, /proxy_pass http:\/\/127\.0\.0\.1:3999;/);
  assert.match(c, /client_max_body_size 25m;/);
  assert.ok(fs.existsSync(path.join(st.target.dirs.conf, '00-panel-upgrade-map.conf')), 'websocket map installed once');
  assert.ok(reloads() > before, 'nginx was reloaded');
  assert.ok(fs.existsSync(st.target.dirs.acme), 'ACME webroot created');
  const nginx = execFileSync('nginx', ['-t', '-c', path.join(st.target.dir, 'nginx/nginx.conf')], { stdio: 'pipe' }).toString();
  assert.ok(nginx === '' || /ok|successful/.test(nginx));
});

test('duplicates and invalid input are rejected without touching the server', { skip }, async () => {
  const dup = await st.call('POST', '/api/sites', { domain: 'web.test.example', upstream: { type: 'url', url: 'http://127.0.0.1:1' } });
  assert.equal(dup.status, 409);
  const aliasClash = await st.call('POST', '/api/sites', { domain: 'other.test.example', aliases: ['www.web.test.example'], upstream: { type: 'url', url: 'http://127.0.0.1:1' } });
  assert.equal(aliasClash.status, 409);
  const inj = await st.call('POST', '/api/sites', { domain: 'x.test.example; }', upstream: { type: 'url', url: 'http://127.0.0.1:1' } });
  assert.equal(inj.status, 400);
  assert.equal((await st.call('POST', '/api/sites', { domain: 'noapp.test.example', upstream: { type: 'app', appId: 'does-not-exist' } })).status, 400);
  assert.deepEqual(fs.readdirSync(st.target.dirs.conf).filter((f) => f.startsWith('panel-')).sort(), ['panel-web.test.example.conf']);
});

test('an invalid custom config is rejected by nginx and the previous config is restored', { skip }, async () => {
  const before = readConf('web.test.example');
  const r = await st.call('PUT', '/api/sites', { id: siteId, customConfig: 'this_is_not_a_directive on;' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /nginx rejected the configuration, so nothing was changed/);
  assert.match(r.json.error, /unknown directive/);
  assert.equal(readConf('web.test.example'), before, 'file restored byte for byte');
  assert.equal((await st.call('GET', `/api/sites/detail?id=${siteId}`)).json.site.customConfig, '', 'record unchanged');
  const ok = await st.call('PUT', '/api/sites', { id: siteId, customConfig: 'add_header X-Panel-Test "1" always;' });
  assert.equal(ok.status, 200, ok.raw);
  assert.match(readConf('web.test.example'), /add_header X-Panel-Test "1" always;/);
  assert.equal((await st.call('PUT', '/api/sites', { id: siteId, domain: 'changed.test.example' })).status, 400, 'primary domain is immutable');
});

test('a domain can point at a deployed app (port follows the app) or at static files', { skip }, async () => {
  const app = await st.call('POST', '/api/apps', { name: 'shop', repoUrl: 'https://github.com/o/r.git', port: 4100 });
  assert.equal(app.status, 200, app.raw);
  const r = await st.call('POST', '/api/sites', { domain: 'shop.test.example', upstream: { type: 'app', appId: app.json.app.id } });
  assert.equal(r.status, 200, r.raw);
  assert.match(readConf('shop.test.example'), /proxy_pass http:\/\/127\.0\.0\.1:4100;/);
  assert.equal(r.json.site.appName, 'shop');
  const d = await st.call('GET', `/api/apps/detail?id=${app.json.app.id}`);
  assert.deepEqual(d.json.sites.map((x) => x.domain), ['shop.test.example'], 'app page lists its domains');
  const sp1 = await st.call('POST', '/api/sites', { domain: 'docs.test.example', upstream: { type: 'static', root: '/var/www/docs', spa: true } });
  assert.equal(sp1.status, 200, sp1.raw);
  assert.match(readConf('docs.test.example'), /try_files \$uri \/index\.html;/);
  // deleting the app keeps the domain working by converting it to a plain URL upstream
  assert.equal((await st.call('DELETE', `/api/apps?id=${app.json.app.id}`)).status, 200);
  const after2 = (await st.call('GET', '/api/sites')).json.sites.find((x) => x.domain === 'shop.test.example');
  assert.deepEqual(after2.upstream, { type: 'url', url: 'http://127.0.0.1:4100' });
  assert.equal((await st.call('DELETE', `/api/sites?id=${sp1.json.site.id}`)).status, 200);
  assert.equal((await st.call('DELETE', `/api/sites?id=${after2.id}`)).status, 200);
});

test('Let\'s Encrypt: issue → HTTPS config with redirect → certificate details', { skip }, async () => {
  assert.equal((await st.call('POST', '/api/sites/cert/issue', { id: siteId, email: 'not-an-email' })).status, 400);
  const r = await st.call('POST', '/api/sites/cert/issue', { id: siteId, email: 'ops@example.com', staging: true });
  assert.equal(r.status, 200, r.raw);
  assert.match(r.json.output, /Successfully received certificate/);
  const c = readConf('web.test.example');
  assert.match(c, /listen 443 ssl http2;/, 'nginx 1.24 form (real nginx accepted it)');
  assert.match(c, new RegExp(`ssl_certificate\\s+${st.target.dirs.le}/live/web\\.test\\.example/fullchain\\.pem;`));
  assert.match(c, /return 301 https:\/\/\$host\$request_uri;/);
  assert.ok(fs.existsSync(path.join(st.target.dirs.le, 'live/web.test.example/fullchain.pem')));
  const d = (await st.call('GET', `/api/sites/detail?id=${siteId}`)).json;
  assert.equal(d.site.tls.certName, 'web.test.example');
  assert.equal(d.site.tls.staging, true);
  assert.equal(d.status.certificate.present, true);
  assert.ok(d.status.certificate.daysLeft >= 89 && d.status.certificate.daysLeft <= 90, `daysLeft ${d.status.certificate.daysLeft}`);
  assert.deepEqual(d.status.certificate.names.sort(), ['web.test.example', 'www.web.test.example']);
  assert.equal(d.status.inSync, true);
  assert.equal(d.status.configPresent, true);
});

test('a failed certificate request changes nothing', { skip }, async () => {
  const s = await st.call('POST', '/api/sites', { domain: 'fail.test.example', upstream: { type: 'url', url: 'http://127.0.0.1:3998' } });
  assert.equal(s.status, 200, s.raw);
  const before = readConf('fail.test.example');
  const r = await st.call('POST', '/api/sites/cert/issue', { id: s.json.site.id, email: 'ops@example.com' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Certificate request failed[\s\S]*Challenge failed/);
  assert.equal(readConf('fail.test.example'), before, 'still the HTTP-only config');
  assert.equal((await st.call('GET', `/api/sites/detail?id=${s.json.site.id}`)).json.site.tls, null);
  assert.equal((await st.call('POST', '/api/sites/cert/renew', { id: s.json.site.id })).status, 400, 'nothing to renew');
  assert.equal((await st.call('DELETE', `/api/sites?id=${s.json.site.id}`)).status, 200);
});

test('renewing replaces the certificate; removing it returns to HTTP-only', { skip }, async () => {
  const stamp = () => fs.readFileSync(path.join(st.target.dirs.le, 'live/web.test.example/.stamp'), 'utf8');
  const before = stamp();
  const r = await st.call('POST', '/api/sites/cert/renew', { id: siteId });
  assert.equal(r.status, 200, r.raw);
  assert.notEqual(stamp(), before, 'certificate was re-issued');
  const rm = await st.call('POST', '/api/sites/cert/remove', { id: siteId });
  assert.equal(rm.status, 200, rm.raw);
  assert.ok(!readConf('web.test.example').includes('443'));
  assert.ok(!fs.existsSync(path.join(st.target.dirs.le, 'live/web.test.example')), 'certificate files deleted');
  assert.equal((await st.call('GET', `/api/sites/detail?id=${siteId}`)).json.site.tls, null);
});

test('drift detection: manual edits are noticed and re-applying fixes them', { skip }, async () => {
  const original = readConf('web.test.example');
  fs.writeFileSync(conf('web.test.example'), original + '\n# someone edited this by hand\n');
  assert.equal((await st.call('GET', `/api/sites/detail?id=${siteId}`)).json.status.inSync, false);
  const cfg = await st.call('GET', `/api/sites/config?id=${siteId}`);
  assert.equal(cfg.json.config, original, 'preview shows what the panel would write');
  assert.equal((await st.call('POST', '/api/sites/apply', { id: siteId })).status, 200);
  assert.equal(readConf('web.test.example'), original);
  assert.equal((await st.call('GET', `/api/sites/detail?id=${siteId}`)).json.status.inSync, true);
});

test('DNS and HTTP checks through the API', { skip }, async () => {
  const dns = await st.call('GET', `/api/sites/dns?id=${siteId}`);
  assert.equal(dns.status, 200, dns.raw);
  assert.deepEqual(dns.json.serverIps, ['127.0.0.1']);
  assert.equal(dns.json.reports.length, 2, 'primary domain and its alias');
  assert.equal(dns.json.reports[0].verdict, 'ok');
  const h = await st.call('GET', `/api/sites/http?id=${siteId}`);
  assert.equal(h.status, 200, h.raw);
  assert.equal(h.json.direct.http.status, 301);
  assert.equal(h.json.viaDns.domain, 'web.test.example');
  if (haveOpenssl) assert.equal(h.json.direct.https.cert.subject, 'web.test.example');
});

test('access and error logs are readable, reload endpoint validates first', { skip }, async () => {
  fs.writeFileSync(path.join(st.target.dirs.logs, 'web.test.example.access.log'), '1.2.3.4 GET /one\n1.2.3.4 GET /two\n');
  const l = await st.call('GET', `/api/sites/logs?id=${siteId}&kind=access&lines=1`);
  assert.equal(l.json.output.trim(), '1.2.3.4 GET /two');
  assert.equal((await st.call('GET', `/api/sites/logs?id=${siteId}&kind=../../etc/passwd`)).status, 400);
  const rl = await st.call('POST', '/api/nginx/reload', {});
  assert.equal(rl.status, 200, rl.raw);
  fs.appendFileSync(conf('web.test.example'), '\nbroken {{{\n');
  const bad = await st.call('POST', '/api/nginx/reload', {});
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /not reloading/);
  await st.call('POST', '/api/sites/apply', { id: siteId });
});

test('manual mode: edit the whole nginx file, nginx validates it, bad edits are rolled back', { skip }, async () => {
  const gen = (await st.call('GET', `/api/sites/config?id=${siteId}`)).json.config;
  const manual = gen.replace('client_max_body_size 25m;', 'client_max_body_size 99m;') + '\n# hand written\n';
  const ok = await st.call('PUT', '/api/sites', { id: siteId, rawConfig: manual });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(ok.json.site.manual, true);
  assert.equal(readConf('web.test.example'), manual.replace(/\n*$/, '\n'), 'written verbatim');
  assert.equal((await st.call('GET', `/api/sites/config?id=${siteId}`)).json.config, manual.replace(/\n*$/, '\n'), 'preview shows the manual file');
  assert.equal((await st.call('GET', `/api/sites/detail?id=${siteId}`)).json.status.inSync, true);

  const before = readConf('web.test.example');
  const bad = await st.call('PUT', '/api/sites', { id: siteId, rawConfig: before + '\nserver { listen 80; bogus_directive 1; }\n' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /nginx rejected the configuration, so nothing was changed/);
  assert.match(bad.json.error, /unknown directive/);
  assert.equal(readConf('web.test.example'), before, 'previous manual config restored');
  assert.equal((await st.call('PUT', '/api/sites', { id: siteId, rawConfig: 'x'.repeat(100001) })).status, 400);

  // other settings can still be saved; the manual file stays in charge
  assert.equal((await st.call('PUT', '/api/sites', { id: siteId, maxBodyMb: 5 })).status, 200);
  assert.match(readConf('web.test.example'), /client_max_body_size 99m;/);

  // certificates need the ACME location: refuse early with an actionable message (this manual file keeps the generated one, so a bare file is used)
  assert.equal((await st.call('PUT', '/api/sites', { id: siteId, rawConfig: 'server { listen 80; server_name web.test.example; location / { return 200 "bare"; } }' })).status, 200);
  const noAcme = await st.call('POST', '/api/sites/cert/issue', { id: siteId, email: 'ops@example.com' });
  assert.equal(noAcme.status, 400);
  assert.match(noAcme.json.error, /acme-challenge/);
  assert.equal((await st.call('GET', `/api/sites/detail?id=${siteId}`)).json.site.tls, null, 'nothing changed');
  assert.equal((await st.call('PUT', '/api/sites', { id: siteId, rawConfig: manual })).status, 200);

  // viewers do not receive the raw text
  const vc = await st.loginViewer();
  const vd = await st.call('GET', `/api/sites/detail?id=${siteId}`, undefined, { cookieOverride: vc });
  assert.equal(vd.json.site.rawConfig, undefined);
  assert.equal(vd.json.site.manual, true);
  assert.ok(!(await st.call('GET', '/api/sites', undefined, { cookieOverride: vc })).raw.includes('hand written'));

  // switching back to the generated configuration
  const reset = await st.call('PUT', '/api/sites', { id: siteId, rawConfig: null });
  assert.equal(reset.status, 200, reset.raw);
  assert.equal(reset.json.site.manual, false);
  assert.equal(readConf('web.test.example'), gen.replace('client_max_body_size 25m;', 'client_max_body_size 5m;'), 'generated again from settings');
});

test('nginx files: edit nginx.conf and conf.d files with validation, backup and rollback', { skip }, async () => {
  const list = await st.call('GET', '/api/nginx/files');
  assert.equal(list.status, 200, list.raw);
  const names = list.json.files.map((f) => f.name);
  assert.equal(names[0], 'nginx.conf');
  assert.ok(names.includes('panel-web.test.example.conf') && list.json.files.find((f) => f.name === 'panel-web.test.example.conf').managed);

  // create a new file
  const created = await st.call('PUT', '/api/nginx/file', { name: 'extra.conf', content: 'server { listen 8089; return 204; }' });
  assert.equal(created.status, 200, created.raw);
  assert.equal(created.json.created, true);
  assert.equal(fs.readFileSync(path.join(st.target.dirs.conf, 'extra.conf'), 'utf8'), 'server { listen 8089; return 204; }\n');
  assert.equal((await st.call('GET', '/api/nginx/file?name=extra.conf')).json.content, 'server { listen 8089; return 204; }\n');

  // update keeps a backup of the previous content
  const upd = await st.call('PUT', '/api/nginx/file', { name: 'extra.conf', content: 'server { listen 8090; return 204; }' });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.created, false);
  assert.equal(fs.readFileSync(path.join(st.target.dirs.conf, 'extra.conf.panel-bak'), 'utf8'), 'server { listen 8089; return 204; }\n');

  // invalid edit: nginx rejects it and the file is restored
  const bad = await st.call('PUT', '/api/nginx/file', { name: 'extra.conf', content: 'server { listen 8091; nonsense on; }' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unknown directive/);
  assert.equal(fs.readFileSync(path.join(st.target.dirs.conf, 'extra.conf'), 'utf8'), 'server { listen 8090; return 204; }\n');
  // a bad NEW file leaves nothing behind
  assert.equal((await st.call('PUT', '/api/nginx/file', { name: 'broken.conf', content: 'this is not nginx' })).status, 400);
  assert.ok(!fs.existsSync(path.join(st.target.dirs.conf, 'broken.conf')));

  // nginx.conf itself
  const main = await st.call('GET', '/api/nginx/file?name=nginx.conf');
  assert.match(main.json.content, /include .*conf\.d/);
  const mainOk = await st.call('PUT', '/api/nginx/file', { name: 'nginx.conf', content: main.json.content.replace('worker_connections 16;', 'worker_connections 32;') });
  assert.equal(mainOk.status, 200, mainOk.raw);
  assert.match(fs.readFileSync(path.join(st.target.dir, 'nginx/nginx.conf'), 'utf8'), /worker_connections 32;/);
  const mainBad = await st.call('PUT', '/api/nginx/file', { name: 'nginx.conf', content: 'events {}\nhttp { not_a_thing; }' });
  assert.equal(mainBad.status, 400);
  assert.match(fs.readFileSync(path.join(st.target.dir, 'nginx/nginx.conf'), 'utf8'), /worker_connections 32;/, 'nginx.conf restored');
  assert.equal((await st.call('GET', '/api/nginx/status')).json.configOk, true, 'nginx is left in a valid state');

  // refused names and managed files
  for (const name of ['../etc/passwd', 'a/b.conf', 'nginx.conf.bak', '.hidden.conf', 'x.txt', '', 'a b.conf', 'x'.repeat(100) + '.conf']) {
    assert.equal((await st.call('PUT', '/api/nginx/file', { name, content: 'x' })).status, 400, JSON.stringify(name));
    assert.equal((await st.call('GET', `/api/nginx/file?name=${encodeURIComponent(name)}`)).status, 400);
  }
  const managed = await st.call('PUT', '/api/nginx/file', { name: 'panel-web.test.example.conf', content: 'x' });
  assert.equal(managed.status, 400);
  assert.match(managed.json.error, /generated by the panel/);
  assert.equal((await st.call('PUT', '/api/nginx/file', { name: 'x.conf', content: 'a\0b' })).status, 400);
  assert.equal((await st.call('GET', '/api/nginx/file?name=missing.conf')).status, 404);

  // delete (and refuse to delete nginx.conf / managed files)
  assert.equal((await st.call('DELETE', '/api/nginx/file?name=nginx.conf')).status, 400);
  assert.equal((await st.call('DELETE', '/api/nginx/file?name=panel-web.test.example.conf')).status, 400);
  assert.equal((await st.call('DELETE', '/api/nginx/file?name=extra.conf')).status, 200);
  assert.ok(!fs.existsSync(path.join(st.target.dirs.conf, 'extra.conf')));
  assert.equal((await st.call('DELETE', '/api/nginx/file?name=extra.conf')).status, 404);

  // viewers cannot read or write config files
  const vc = await st.loginViewer();
  for (const [m, u, b] of [['GET', '/api/nginx/files'], ['GET', '/api/nginx/file?name=nginx.conf'], ['PUT', '/api/nginx/file', { name: 'x.conf', content: 'x' }], ['DELETE', '/api/nginx/file?name=x.conf']]) {
    assert.equal((await st.call(m, u, b, { cookieOverride: vc })).status, 403, `${m} ${u}`);
  }
  const audit = (await st.call('GET', '/api/audit')).json.entries;
  assert.ok(audit.some((e) => e.action === 'nginx_file_save' && /extra\.conf/.test(e.detail)));
  assert.ok(audit.some((e) => e.action === 'nginx_file_delete'));
});

test('viewers can inspect domains but not change them', { skip }, async () => {
  const vc = await st.loginViewer();
  const v = (m, u, b) => st.call(m, u, b, { cookieOverride: vc });
  for (const u of ['/api/sites', `/api/sites/detail?id=${siteId}`, `/api/sites/dns?id=${siteId}`, `/api/sites/http?id=${siteId}`, '/api/nginx/status']) assert.equal((await v('GET', u)).status, 200, u);
  for (const [m, u, b] of [['POST', '/api/sites', {}], ['PUT', '/api/sites', { id: siteId }], ['DELETE', `/api/sites?id=${siteId}`], ['POST', '/api/sites/apply', { id: siteId }],
    ['POST', '/api/sites/cert/issue', { id: siteId }], ['POST', '/api/sites/cert/renew', { id: siteId }], ['POST', '/api/sites/cert/remove', { id: siteId }],
    ['GET', `/api/sites/config?id=${siteId}`], ['GET', `/api/sites/logs?id=${siteId}`], ['POST', '/api/nginx/reload', {}]]) assert.equal((await v(m, u, b)).status, 403, `${m} ${u}`);
});

test('deleting a domain removes its config and reloads nginx', { skip }, async () => {
  const before = reloads();
  assert.equal((await st.call('DELETE', `/api/sites?id=${siteId}`)).status, 200);
  assert.ok(!fs.existsSync(conf('web.test.example')));
  assert.ok(reloads() > before);
  assert.equal((await st.call('GET', '/api/sites')).json.sites.length, 0);
});

test('changing an app\'s port repoints its domains once the new port is live', { skip }, async () => {
  const { makeRepo, waitDeploy, get } = require('./helpers');
  const repo = makeRepo(tmp('port-repo-'));
  repo.commit(1);
  const [p1, p2] = [await freePort(), await freePort()];
  const app = (await st.call('POST', '/api/apps', { name: 'mover', repoUrl: 'file://' + repo.dir, port: p1, healthTimeout: 15 })).json.app;
  const s = await st.call('POST', '/api/sites', { domain: 'mover.test.example', upstream: { type: 'app', appId: app.id } });
  assert.equal(s.status, 200, s.raw);
  const dep = async () => waitDeploy(st, (await st.call('POST', '/api/apps/deploy', { id: app.id })).json.deploy.id);
  assert.equal((await dep()).deploy.status, 'success');
  assert.match(readConf('mover.test.example'), new RegExp(`proxy_pass http://127.0.0.1:${p1};`));
  assert.equal((await st.call('PUT', '/api/apps', { id: app.id, port: p2 })).status, 200);
  assert.match(readConf('mover.test.example'), new RegExp(`:${p1};`), 'nginx keeps the old port until the new one is live (no outage window)');
  assert.equal((await dep()).deploy.status, 'success');
  assert.match(readConf('mover.test.example'), new RegExp(`proxy_pass http://127.0.0.1:${p2};`), 'repointed after the deploy');
  assert.equal(await get(p2), 'hello 1');
  const audit = (await st.call('GET', '/api/audit')).json.entries;
  assert.ok(audit.some((e) => e.action === 'site_apply' && /repointed to port/.test(e.detail)));
  await st.call('DELETE', `/api/sites?id=${s.json.site.id}`);
  await st.call('DELETE', `/api/apps?id=${app.id}&deleteFiles=1`);
  fs.rmSync(repo.dir, { recursive: true, force: true });
});

test('removing a server forgets its apps and domains', { skip }, async () => {
  await st.call('POST', '/api/sites', { domain: 'gone.test.example', upstream: { type: 'url', url: 'http://127.0.0.1:1' } });
  await st.call('POST', '/api/apps', { name: 'gone', repoUrl: 'https://github.com/o/r.git', port: 4200 });
  assert.equal((await st.call('DELETE', `/api/servers?id=${st.serverId}`)).status, 200);
  assert.equal(st.app.store.data.sites.length, 0);
  assert.equal(st.app.store.data.apps.length, 0);
});
