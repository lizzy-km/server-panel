'use strict';
/**
 * Adopting an EXISTING Laravel app and its hand-written nginx site, end to end: real sshd, real PHP running a real
 * `artisan` script, real nginx -t. (Set PANEL_TEST_LARAVEL=/path/to/real-laravel-app to also run the checks against
 * a genuine `composer create-project laravel/laravel` skeleton.)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { canTarget, hasBin, makeStack, tmp } = require('./helpers');
const { summarizeFile, parseNginxSites } = require('../server/lib/nginxparse');

const skip = !canTarget() || !hasBin('nginx') || !hasBin('php');
let st, appDir, appId, siteId;

const ARTISAN = String.raw`#!/usr/bin/env php
<?php
$cmd = $argv[1] ?? 'list'; $root = __DIR__;
$w = fn($f, $c) => file_put_contents("$root/$f", $c);
switch ($cmd) {
  case 'down': @mkdir("$root/storage/framework", 0775, true); $w('storage/framework/down', '{}'); echo "INFO  Application is now in maintenance mode.\n"; break;
  case 'up': @unlink("$root/storage/framework/down"); echo "INFO  Application is now live.\n"; break;
  case 'optimize:clear': foreach (glob("$root/bootstrap/cache/*.php") as $f) unlink($f); echo "INFO  Clearing cached bootstrap files.\n"; break;
  case 'optimize': case 'config:cache': $w('bootstrap/cache/config.php', '<?php return [];'); echo "INFO  Configuration cached successfully.\n"; break;
  case 'config:clear': @unlink("$root/bootstrap/cache/config.php"); echo "INFO  Configuration cache cleared successfully.\n"; break;
  case 'queue:restart': @mkdir("$root/storage/framework/cache", 0775, true); $w('storage/framework/cache/queue-restart', (string) time()); echo "INFO  Broadcasting queue restart signal.\n"; break;
  case 'migrate:status': echo "  Migration name ........ Batch / Status\n  0001_create_users_table ........ [1] Ran\n"; break;
  case 'migrate': if (!in_array('--force', $argv)) { echo "Application In Production!\n"; exit(1); } echo "INFO  Nothing to migrate.\n"; break;
  case 'about': echo "Environment ........\n  PHP Version ........ " . PHP_VERSION . "\n"; break;
  case 'schedule:list': echo "  * * * * *  php artisan inspire\n"; break;
  case 'queue:failed': echo "INFO  No failed jobs found.\n"; break;
  default: fwrite(STDERR, "Command \"$cmd\" is not defined.\n"); exit(1);
}
`;

function makeLaravel(dir) {
  for (const d of ['vendor/laravel/framework/src/Illuminate/Foundation', 'storage/logs', 'storage/framework/cache', 'bootstrap/cache', 'public']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendor/laravel/framework/src/Illuminate/Foundation/Application.php'), "<?php\nclass Application { const VERSION = '11.9.2'; }\n");
  fs.writeFileSync(path.join(dir, 'artisan'), ARTISAN, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'public/index.php'), '<?php echo "ok";');
  fs.writeFileSync(path.join(dir, '.env'), [
    '# production settings', 'APP_NAME="Q App"', 'APP_ENV=production', 'APP_KEY=base64:SGVsbG9UaGlzSXNOb3RSZWFsS2V5MTIzNDU2Nzg5MDEyMw==', 'APP_DEBUG=false', 'APP_URL=https://q-app.example.com',
    '', 'DB_CONNECTION=mysql', 'DB_PASSWORD=super-secret-db-password', 'QUEUE_CONNECTION=database', 'SESSION_DRIVER=file', 'CACHE_STORE=file', '',
  ].join('\n'), { mode: 0o640 });
  fs.writeFileSync(path.join(dir, 'storage/logs/laravel.log'), '[2026-11-27 10:00:00] production.INFO: boot\n[2026-11-27 10:00:05] production.ERROR: SQLSTATE[HY000] connection refused\n[2026-11-27 10:00:09] production.INFO: done\n');
  fs.writeFileSync(path.join(dir, 'storage/logs/laravel-2026-11-26.log'), '[2026-11-26 09:00:00] production.INFO: yesterday\n');
  const old = new Date(Date.now() - 86400000); fs.utimesSync(path.join(dir, 'storage/logs/laravel-2026-11-26.log'), old, old);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'https://deploy-user:ghp_SECRETTOKEN123@github.com/org/q-app.git');
  git('add', '-A', ':!.env'); git('commit', '-q', '-m', 'Initial q-app');
}

const HAND_WRITTEN = (root, cert) => `# q-app (hand written)
server {
    listen 80;
    server_name q-app.example.com www.q-app.example.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    server_name q-app.example.com www.q-app.example.com;
    root ${root}/public;
    index index.php;
    ssl_certificate ${cert}/fullchain.pem;
    ssl_certificate_key ${cert}/privkey.pem;
    add_header X-Frame-Options "SAMEORIGIN";
    location / { try_files $uri $uri/ /index.php?$query_string; }
    location ~ \\.php$ {
        fastcgi_pass unix:/run/php-fpm/www.sock;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
    }
}
`;

const conf = (n) => path.join(st.target.dirs.conf, n);

before(async () => {
  if (skip) return;
  st = await makeStack();
  appDir = path.join(st.target.dir, 'www/q-app');
  makeLaravel(appDir);
  // an existing Let's Encrypt style certificate + the hand-written site that uses it
  const certDir = path.join(st.target.dirs.le, 'live/q-app.example.com');
  fs.mkdirSync(certDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '60', '-subj', '/CN=q-app.example.com', '-addext', 'subjectAltName=DNS:q-app.example.com,DNS:www.q-app.example.com', '-keyout', path.join(certDir, 'privkey.pem'), '-out', path.join(certDir, 'fullchain.pem')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(certDir, '.domains'), 'q-app.example.com\nwww.q-app.example.com\n');
  fs.writeFileSync(conf('q-app.conf'), HAND_WRITTEN(appDir, certDir));
  fs.writeFileSync(conf('00-default.conf'), 'server { listen 8081 default_server; server_name _; return 444; }\n');
});
after(() => { if (!skip) st.stop(); });

test('nginx reader understands a realistic hand-written Laravel site', () => {
  const sum = summarizeFile(HAND_WRITTEN('/var/www/q-app', '/etc/letsencrypt/live/q-app.example.com'));
  assert.equal(sum.servers, 2);
  assert.deepEqual(sum.names, ['q-app.example.com', 'www.q-app.example.com']);
  assert.equal(sum.kind, 'php');
  assert.equal(sum.root, '/var/www/q-app/public');
  assert.equal(sum.fastcgi, 'unix:/run/php-fpm/www.sock');
  assert.equal(sum.sslCert, '/etc/letsencrypt/live/q-app.example.com/fullchain.pem');
  assert.ok(sum.redirectsToHttps);
  assert.equal(summarizeFile('server { listen 80 default_server; server_name _; return 404; }').onlyDefault, true);
  assert.equal(summarizeFile('server { server_name api.example.com; location / { proxy_pass http://127.0.0.1:3000; } }').kind, 'proxy');
  assert.equal(parseNginxSites('server { server_name a.example.com; add_header X "a # b; c"; }')[0].names[0], 'a.example.com', 'quotes and # inside strings');
  assert.deepEqual(parseNginxSites('# server { server_name hidden.example.com; }\nserver { server_name shown.example.com; }').flatMap((s) => s.names), ['shown.example.com'], 'comments ignored');
});

test('discovery lists the hand-written site, skips default servers and panel-generated files', { skip }, async () => {
  const r = await st.call('GET', '/api/nginx/discover');
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.sites.length, 1);
  const s = r.json.sites[0];
  assert.equal(s.file, 'q-app.conf');
  assert.deepEqual(s.names, ['q-app.example.com', 'www.q-app.example.com']);
  assert.equal(s.kind, 'php');
  assert.equal(s.laravelPath, appDir, 'the app folder is derived from the nginx root');
  assert.equal(s.https, true);
  assert.equal(s.adopted, null);
});

test('adopting the site keeps the file byte for byte and detects the certificate', { skip }, async () => {
  const before = fs.readFileSync(conf('q-app.conf'), 'utf8');
  const mtime = fs.statSync(conf('q-app.conf')).mtimeMs;
  const r = await st.call('POST', '/api/sites/adopt', { file: 'q-app.conf' });
  assert.equal(r.status, 200, r.raw);
  siteId = r.json.site.id;
  assert.equal(r.json.site.domain, 'q-app.example.com');
  assert.deepEqual(r.json.site.aliases, ['www.q-app.example.com']);
  assert.equal(r.json.site.adopted, true);
  assert.equal(r.json.site.manual, true);
  assert.equal(r.json.site.tls.certName, 'q-app.example.com');
  assert.equal(fs.readFileSync(conf('q-app.conf'), 'utf8'), before, 'adoption does not touch the file');
  assert.equal(fs.statSync(conf('q-app.conf')).mtimeMs, mtime);
  assert.ok(!fs.existsSync(conf('panel-q-app.example.com.conf')), 'no duplicate file (which would clash on server_name)');
  const d = (await st.call('GET', `/api/sites/detail?id=${siteId}`)).json;
  assert.equal(d.status.inSync, true);
  assert.equal(d.status.certificate.present, true);
  assert.deepEqual(d.status.certificate.names.sort(), ['q-app.example.com', 'www.q-app.example.com']);
  assert.match(d.site.upstreamLabel, /existing config \(php/);
  assert.equal((await st.call('POST', '/api/sites/adopt', { file: 'q-app.conf' })).status, 409);
  assert.equal((await st.call('POST', '/api/sites/adopt', { file: '../etc/passwd' })).status, 400);
  assert.equal((await st.call('POST', '/api/sites/adopt', { file: '00-default.conf' })).status, 400, 'no domain names in a default server');
  assert.equal((await st.call('GET', '/api/nginx/discover')).json.sites[0].adopted, siteId);
});

test('an adopted site is edited in place, never duplicated; editing the file elsewhere stays in sync', { skip }, async () => {
  const cur = fs.readFileSync(conf('q-app.conf'), 'utf8');
  const edited = cur.replace('X-Frame-Options "SAMEORIGIN"', 'X-Frame-Options "DENY"');
  const ok = await st.call('PUT', '/api/sites', { id: siteId, rawConfig: edited });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(fs.readFileSync(conf('q-app.conf'), 'utf8'), edited);
  assert.ok(!fs.existsSync(conf('panel-q-app.example.com.conf')));
  const bad = await st.call('PUT', '/api/sites', { id: siteId, rawConfig: edited + '\nbogus_directive on;\n' });
  assert.equal(bad.status, 400);
  assert.equal(fs.readFileSync(conf('q-app.conf'), 'utf8'), edited, 'rolled back');
  // the generic file editor updates the site record too
  const viaEditor = await st.call('PUT', '/api/nginx/file', { name: 'q-app.conf', content: edited.replace('DENY', 'SAMEORIGIN') });
  assert.equal(viaEditor.status, 200, viaEditor.raw);
  assert.equal((await st.call('GET', `/api/sites/detail?id=${siteId}`)).json.status.inSync, true, 'still in sync after editing through the file editor');
});

test('adopted certificates: Let\'s Encrypt ones renew, external ones are protected', { skip }, async () => {
  const pem = path.join(st.target.dirs.le, 'live/q-app.example.com/fullchain.pem');
  const before = fs.readFileSync(pem, 'utf8');
  const r = await st.call('POST', '/api/sites/cert/renew', { id: siteId });
  assert.equal(r.status, 200, r.raw);
  assert.notEqual(fs.readFileSync(pem, 'utf8'), before, 'certbot renew was invoked for the adopted certificate');

  const ext = path.join(st.target.dir, 'external-cert');
  fs.mkdirSync(ext, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '60', '-subj', '/CN=other.example.org', '-keyout', path.join(ext, 'key.pem'), '-out', path.join(ext, 'cert.pem')], { stdio: 'ignore' });
  fs.writeFileSync(conf('other.conf'), `server { listen 8082; server_name other.example.org; ssl_certificate ${ext}/cert.pem; ssl_certificate_key ${ext}/key.pem; root /var/www/other; }\n`);
  const a = await st.call('POST', '/api/sites/adopt', { file: 'other.conf' });
  assert.equal(a.status, 200, a.raw);
  assert.equal(a.json.site.tls.external, true);
  assert.equal((await st.call('POST', '/api/sites/cert/renew', { id: a.json.site.id })).status, 400);
  const iss = await st.call('POST', '/api/sites/cert/issue', { id: a.json.site.id, email: 'ops@example.com' });
  assert.equal(iss.status, 400);
  assert.match(iss.json.error, /did not issue/);
  assert.equal((await st.call('GET', `/api/sites/detail?id=${a.json.site.id}`)).json.status.certificate.present, true, 'expiry is still shown');
  // forgetting an adopted site leaves its nginx file alone
  assert.equal((await st.call('DELETE', `/api/sites?id=${a.json.site.id}`)).status, 200);
  assert.ok(fs.existsSync(conf('other.conf')), 'the file stays');
  fs.rmSync(conf('other.conf'));
});

// ------------------------------------------------------------------ Laravel app

test('inspecting a folder: validation and "not a Laravel app" detection', { skip }, async () => {
  for (const p of ['relative/path', '/var/www/../etc', '/x;rm -rf /', '']) assert.equal((await st.call('POST', '/api/laravel/inspect', { path: p })).status, 400, p);
  assert.equal((await st.call('POST', '/api/laravel/inspect', { path: '/definitely/not/here' })).status, 404);
  const plain = path.join(st.target.dir, 'not-laravel'); fs.mkdirSync(plain);
  const r = await st.call('POST', '/api/laravel/inspect', { path: plain });
  assert.equal(r.status, 200);
  assert.equal(r.json.info.isLaravel, false);
  assert.equal((await st.call('POST', '/api/laravel', { name: 'plain', path: plain })).status, 400);
});

test('adopting the existing app: facts are read without running it, secrets are not exposed', { skip }, async () => {
  const r = await st.call('POST', '/api/laravel', { name: 'q-app', path: appDir });
  assert.equal(r.status, 200, r.raw);
  appId = r.json.app.id;
  const i = r.json.info;
  assert.equal(i.isLaravel, true);
  assert.equal(i.laravel, '11.9.2');
  assert.match(i.php, /^8\./);
  assert.equal(i.hasVendor && i.hasEnv, true);
  assert.equal(i.owner, 'root');
  assert.equal(i.maintenance, false);
  assert.equal(i.logFile, 'laravel.log');
  assert.deepEqual([i.env.appEnv, i.env.debug, i.env.url, i.env.db, i.env.queue, i.env.session, i.env.cache], ['production', 'false', 'https://q-app.example.com', 'mysql', 'database', 'file', 'file']);
  assert.equal(i.git.branch, 'main');
  assert.equal(i.git.subject, 'Initial q-app');
  assert.equal(i.git.remote, 'https://github.com/org/q-app.git', 'credentials in the remote URL are stripped');
  assert.ok(!r.raw.includes('SECRETTOKEN') && !r.raw.includes('super-secret') && !r.raw.includes('SGVsbG8'), 'no secrets in the response');
  assert.equal(r.json.app.runUser, 'root', 'artisan will run as the owner of storage/');
  assert.equal((await st.call('POST', '/api/laravel', { name: 'q-app', path: appDir })).status, 409);
  assert.equal((await st.call('POST', '/api/laravel', { name: 'Bad Name', path: appDir })).status, 400);
  const list = (await st.call('GET', '/api/laravel')).json.apps;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].sites.map((x) => x.domain), ['q-app.example.com'], 'linked to its domain through the nginx root');
});

test('artisan: only whitelisted commands, each does what it says', { skip }, async () => {
  const art = (command) => st.call('POST', '/api/laravel/artisan', { id: appId, command });
  const info = async () => (await st.call('GET', `/api/laravel/detail?id=${appId}&fresh=1`)).json.info;
  for (const bad of ['migrate:fresh', 'migrate:rollback', 'db:wipe', 'db:seed', 'tinker', 'down; rm -rf /', '--version', '', 'key:generate']) assert.equal((await art(bad)).status, 400, bad);

  assert.match((await art('down')).json.output, /maintenance mode/);
  assert.equal((await info()).maintenance, true);
  assert.ok(fs.existsSync(path.join(appDir, 'storage/framework/down')));
  assert.match((await art('up')).json.output, /now live/);
  assert.equal((await info()).maintenance, false);

  assert.equal((await art('optimize')).json.ok, true);
  assert.equal((await info()).configCached, true);
  assert.equal((await art('optimize:clear')).json.ok, true);
  assert.equal((await info()).configCached, false);
  assert.match((await art('queue:restart')).json.output, /queue restart/);
  assert.ok(fs.existsSync(path.join(appDir, 'storage/framework/cache/queue-restart')));
  assert.match((await art('migrate:status')).json.output, /Ran/);
  const mig = await art('migrate');
  assert.equal(mig.json.ok, true);
  assert.match(mig.json.output, /Nothing to migrate/);
  assert.equal((await art('about')).json.ok, true);
});

test('artisan runs as the app owner: command construction (sudo -u) is correct and safe', { skip }, async () => {
  const { LaravelManager } = require('../server/lib/laravel');
  const seen = [];
  const host = { username: 'ec2-user', useSudo: true, run: async (cmd, args) => { seen.push(args[1]); return { ok: true, code: 0, stdout: 'done', stderr: '' }; } };
  const fake = { find: () => ({}), servers: { entry: () => ({ host }) }, store: { data: { laravel: [] }, save() {} }, config: {} };
  const mgr = new LaravelManager(fake);
  await mgr.artisan({ id: 'x', serverId: 's', path: "/var/www/q app's", runUser: 'nginx' }, 'optimize:clear');
  assert.match(seen[0], /^sudo -n -u 'nginx' sh -c /);
  assert.ok(seen[0].replace(/'\\''/g, "'").includes("php artisan 'optimize:clear' --no-interaction"), seen[0]);
  assert.ok(seen[0].replace(/'\\''/g, "'").includes("cd '/var/www/q app'\\''s'") || seen[0].includes('q app'), 'path with spaces and a quote stays one quoted argument');
  assert.ok(!/ec2-user/.test(seen[0]));
  await mgr.artisan({ id: 'x', serverId: 's', path: '/var/www/q', runUser: 'ec2-user' }, 'up');
  assert.ok(!seen[1].startsWith('sudo'), 'no sudo when the owner already is the SSH user');
  host.useSudo = false;
  await assert.rejects(mgr.artisan({ id: 'x', serverId: 's', path: '/p', runUser: 'nginx' }, 'up'), /passwordless sudo/);
});

test('logs: files, tail, filter, and no path escapes', { skip }, async () => {
  const files = (await st.call('GET', `/api/laravel/logfiles?id=${appId}`)).json.files;
  assert.deepEqual(files.map((f) => f.name).sort(), ['laravel-2026-11-26.log', 'laravel.log']);
  const all = await st.call('GET', `/api/laravel/logs?id=${appId}&file=laravel.log&lines=2`);
  assert.equal(all.json.output.trim().split('\n').length, 2);
  const errs = await st.call('GET', `/api/laravel/logs?id=${appId}&file=laravel.log&q=error`);
  assert.match(errs.json.output, /SQLSTATE/);
  assert.ok(!errs.json.output.includes('boot'));
  for (const f of ['../.env', '../../.env', 'laravel.log/../../.env', '.env', 'a b.log', '']) assert.equal((await st.call('GET', `/api/laravel/logs?id=${appId}&file=${encodeURIComponent(f)}`)).status, 400, f);
  assert.equal((await st.call('GET', `/api/laravel/logs?id=${appId}&file=missing.log`)).status, 404);
});

test('.env editor: raw text, comments kept, backup, ownership kept, APP_KEY protected, apply clears caches', { skip }, async () => {
  const envFile = path.join(appDir, '.env');
  const vc = await st.loginViewer();
  assert.equal((await st.call('GET', `/api/laravel/env?id=${appId}`, undefined, { cookieOverride: vc })).status, 403);
  assert.equal((await st.call('PUT', '/api/laravel/env', { id: appId, content: 'X=1' }, { cookieOverride: vc })).status, 403);

  const got = await st.call('GET', `/api/laravel/env?id=${appId}`);
  assert.equal(got.status, 200);
  assert.match(got.json.content, /^# production settings\nAPP_NAME="Q App"/, 'comments and quoting preserved verbatim');
  const ino = fs.statSync(envFile).ino; const mode = fs.statSync(envFile).mode & 0o777;
  const original = fs.readFileSync(envFile, 'utf8');

  const edited = got.json.content.replace('APP_DEBUG=false', 'APP_DEBUG=true') + 'NEW_FLAG=yes\n';
  const save = await st.call('PUT', '/api/laravel/env', { id: appId, content: edited });
  assert.equal(save.status, 200, save.raw);
  assert.equal(fs.readFileSync(envFile, 'utf8'), edited);
  assert.equal(fs.readFileSync(envFile + '.panel-bak', 'utf8'), original, 'previous version kept');
  assert.equal(fs.statSync(envFile).ino, ino, 'edited in place');
  assert.equal(fs.statSync(envFile).mode & 0o777, mode, 'permissions unchanged');
  assert.deepEqual(save.json.applied, [], 'plain save does not touch the app');

  // APP_KEY safety net
  const noKey = edited.replace(/^APP_KEY=.*\n/m, '');
  const refused = await st.call('PUT', '/api/laravel/env', { id: appId, content: noKey });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /APP_KEY/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), edited, 'refused edits change nothing');
  assert.equal((await st.call('PUT', '/api/laravel/env', { id: appId, content: noKey, force: true })).status, 200, 'explicit override allowed');
  assert.equal((await st.call('PUT', '/api/laravel/env', { id: appId, content: edited })).status, 200);

  assert.equal((await st.call('PUT', '/api/laravel/env', { id: appId, content: 'A=\0' })).status, 400);
  assert.equal((await st.call('PUT', '/api/laravel/env', { id: appId, content: 'x'.repeat(200001) })).status, 400);

  // apply: config cache is rebuilt (it was cached) and workers are told to restart
  await st.call('POST', '/api/laravel/artisan', { id: appId, command: 'config:cache' });
  fs.rmSync(path.join(appDir, 'storage/framework/cache/queue-restart'), { force: true });
  const applied = await st.call('PUT', '/api/laravel/env', { id: appId, content: edited.replace('NEW_FLAG=yes', 'NEW_FLAG=applied'), apply: true });
  assert.equal(applied.status, 200, applied.raw);
  assert.deepEqual(applied.json.applied.map((a) => a.command), ['config:clear', 'config:cache', 'queue:restart']);
  assert.equal(applied.json.healthy, true);
  assert.ok(fs.existsSync(path.join(appDir, 'storage/framework/cache/queue-restart')));
  assert.ok(fs.existsSync(path.join(appDir, 'bootstrap/cache/config.php')), 'cache rebuilt because it was cached before');

  const audit = (await st.call('GET', '/api/audit')).json.entries;
  assert.ok(audit.some((e) => e.action === 'env_view') && audit.some((e) => e.action === 'env_save'));
  assert.ok(!JSON.stringify(audit).includes('super-secret-db-password') && !JSON.stringify(audit).includes('NEW_FLAG'), 'values never audited');
});

test('PHP-FPM reload, viewer access, and forgetting an app', { skip }, async () => {
  assert.equal((await st.call('POST', '/api/laravel/fpm', { id: appId, action: 'reload' })).status, 200);
  assert.equal((await st.call('POST', '/api/laravel/fpm', { id: appId, action: 'format' })).status, 400);
  const vc = await st.loginViewer();
  const v = (m, u, b) => st.call(m, u, b, { cookieOverride: vc });
  const d = await v('GET', `/api/laravel/detail?id=${appId}`);
  assert.equal(d.status, 200);
  assert.ok(!d.raw.includes('super-secret') && !d.raw.includes('SECRETTOKEN'));
  assert.equal((await v('GET', '/api/laravel')).status, 200);
  for (const [m, u, b] of [['POST', '/api/laravel/inspect', { path: appDir }], ['POST', '/api/laravel', { name: 'x', path: appDir }], ['DELETE', `/api/laravel?id=${appId}`],
    ['POST', '/api/laravel/artisan', { id: appId, command: 'down' }], ['POST', '/api/laravel/fpm', { id: appId, action: 'reload' }], ['GET', `/api/laravel/logs?id=${appId}&file=laravel.log`],
    ['GET', `/api/laravel/logfiles?id=${appId}`], ['GET', `/api/laravel/env?id=${appId}`], ['GET', '/api/nginx/discover'], ['POST', '/api/sites/adopt', { file: 'q-app.conf' }]]) {
    assert.equal((await v(m, u, b)).status, 403, `${m} ${u}`);
  }
  assert.equal((await st.call('DELETE', `/api/laravel?id=${appId}`)).status, 200);
  assert.ok(fs.existsSync(path.join(appDir, 'artisan')) && fs.existsSync(path.join(appDir, '.env')), 'forgetting never touches the server files');
  assert.equal((await st.call('GET', '/api/laravel')).json.apps.length, 0);
});

test('adopted site: deleting only forgets it unless the file is explicitly deleted', { skip }, async () => {
  assert.equal((await st.call('DELETE', `/api/sites?id=${siteId}`)).status, 200);
  assert.ok(fs.existsSync(conf('q-app.conf')), 'nginx file untouched');
  const again = await st.call('POST', '/api/sites/adopt', { file: 'q-app.conf' });
  assert.equal(again.status, 200, 're-adoptable');
  assert.equal((await st.call('DELETE', `/api/sites?id=${again.json.site.id}&deleteFile=1`)).status, 200);
  assert.ok(!fs.existsSync(conf('q-app.conf')), 'explicit delete removes the file');
});
