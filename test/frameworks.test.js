'use strict';
/**
 * Framework presets and run modes, end to end with REAL toolchains on a real sshd:
 *   static SPA (build output served by nginx), Go and Java services (real go build / javac+jar / real JVM),
 *   Python (real venv), PHP with real composer + real PHP (shared storage, release command, running as another user).
 * Only systemd/certbot are fake (test/shims). .NET and Maven/Gradle cannot be installed here; their presets are
 * covered by script-syntax and detection tests instead.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { canTarget, hasBin, makeStack, waitDeploy, freePort, get, tmp } = require('./helpers');
const P = require('../server/lib/presets');
const S = require('../server/lib/scripts');

const skip = !canTarget() || !hasBin('nginx');
let st;
const repos = [];

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
/** A throw-away git repo with the given files; returns {dir, url, commit(files)}. */
function gitRepo(files) {
  const dir = tmp('fw-repo-'); repos.push(dir);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV }).toString().trim();
  git('init', '-q', '-b', 'main');
  const write = (fs_) => { for (const [f, c] of Object.entries(fs_)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c, f === 'artisan' || f === 'build.sh' ? { mode: 0o755 } : undefined); } };
  const commit = (fs_, msg = 'update') => { write(fs_); git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  commit(files, 'initial');
  return { dir, url: 'file://' + dir, commit };
}

const mkApp = async (over) => {
  const r = await st.call('POST', '/api/apps', { branch: 'main', healthTimeout: 30, ...over });
  assert.equal(r.status, 200, r.raw);
  return r.json.app;
};
const deploy = async (appId, extra = {}) => {
  const r = await st.call('POST', '/api/apps/deploy', { id: appId, ...extra });
  assert.equal(r.status, 200, r.raw);
  return waitDeploy(st, r.json.deploy.id, 180000);
};
const detail = async (id) => (await st.call('GET', `/api/apps/detail?id=${id}`)).json;
const appsDir = () => st.target.dirs.apps;
const conf = (d) => fs.readFileSync(path.join(st.target.dirs.conf, `panel-${d}.conf`), 'utf8');

before(async () => { if (!skip) { st = await makeStack(); fs.chmodSync(st.target.dir, 0o755); fs.chmodSync(appsDir(), 0o755); } });
after(() => { if (!skip) { st.stop(); for (const d of repos) fs.rmSync(d, { recursive: true, force: true }); } });

// ------------------------------------------------------------------ unit tests (no server needed)

test('presets: every framework produces valid scripts in every mode', () => {
  const dir = tmp('syntax-');
  for (const p of P.PRESETS) {
    const app = { name: 'demo', framework: p.id, unit: 'panel-app-demo.service', port: 3000, keepReleases: 5, repoUrl: 'https://x/y.git', authType: 'none', healthHost: 'demo.example.com' };
    const cfg = P.resolve(app);
    const ctx = { appDir: '/srv/apps/demo', unitDir: '/etc/systemd/system', relId: '20260101000000-ab12', ref: 'main', useSudo: true, appUser: 'nginx', fpmUnit: 'php-fpm.service', secrets: {}, envFile: 'A=1\n', envShell: 'export A=1\n', startSh: '#!/bin/bash\n', unit: 'u', repoLabel: 'x', release: '20260101000000-ab12' };
    for (const [name, text] of [['deploy', S.deployScript(app, cfg, ctx)], ['rollback', S.rollbackScript(app, cfg, ctx)], ['env', S.envApplyScript(app, cfg, ctx)]]) {
      fs.writeFileSync(path.join(dir, 'x.sh'), text);
      const r = spawnSync('bash', ['-n', path.join(dir, 'x.sh')]);
      assert.equal(r.status, 0, `${p.id}/${name}: ${r.stderr}`);
    }
  }
  const all = S.installScript(P.PRESETS.flatMap((p) => p.tools).concat(['maven', 'nginx', 'certbot', 'git']), { useSudo: true, acmeRoot: '/var/www/letsencrypt', unitDir: '/etc/systemd/system' });
  fs.writeFileSync(path.join(dir, 'i.sh'), all);
  assert.equal(spawnSync('bash', ['-n', path.join(dir, 'i.sh')]).status, 0);
  for (const needle of ['dotnet-sdk-8.0', 'java-21-amazon-corretto-devel', 'php8.3-fpm', 'installer.sig', 'golang', 'python3-pip']) assert.ok(all.includes(needle), needle);
  fs.writeFileSync(path.join(dir, 't.sh'), S.TOOLS_CHECK);
  assert.equal(spawnSync('bash', ['-n', path.join(dir, 't.sh')]).status, 0);
});

test('presets: resolve() merges the app\'s overrides with the preset defaults', () => {
  assert.deepEqual([P.resolve({ framework: 'nextjs' }).mode, P.resolve({ framework: 'static-spa' }).mode, P.resolve({ framework: 'laravel' }).mode, P.resolve({ framework: 'spring' }).mode, P.resolve({ framework: 'dotnet' }).mode], ['service', 'static', 'php', 'service', 'service']);
  assert.equal(P.resolve({ framework: 'nestjs' }).start, 'node dist/main.js');
  assert.equal(P.resolve({ framework: 'nestjs', startCmd: 'node dist/src/main' }).start, 'node dist/src/main', 'an override wins');
  assert.equal(P.resolve({ framework: 'laravel' }).releaseCmd, 'php artisan migrate --force', 'migrations on by default');
  assert.equal(P.resolve({ framework: 'laravel', releaseCmd: '' }).releaseCmd, '', 'an explicit empty value turns the default off');
  assert.deepEqual(P.resolve({ framework: 'laravel' }).sharedPaths, ['storage']);
  assert.equal(P.resolve({ framework: 'static-spa' }).spa, true);
  assert.equal(P.resolve({ framework: 'static-spa', spa: false }).spa, false);
  assert.equal(P.resolve({ framework: 'does-not-exist' }).preset, 'node', 'unknown frameworks fall back safely');
  assert.ok(P.resolve({ framework: 'spring' }).healthTimeout >= 60, 'JVM apps get a longer start-up allowance');
  assert.ok(!JSON.stringify(P.publicPresets()).includes('detect'), 'detection snippets stay on the server');
});

test('presets: file-based detection picks the right framework (and the right one when several match)', () => {
  const dir = tmp('detect-');
  fs.writeFileSync(path.join(dir, 'd.sh'), 'set -euo pipefail\n' + P.detectScript() + '\n');
  const pkg = (deps) => JSON.stringify({ dependencies: deps });
  const detect = (files) => {
    const d = fs.mkdtempSync(path.join(dir, 'p-'));
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
    return execFileSync('bash', [path.join(dir, 'd.sh')], { cwd: d }).toString().trim();
  };
  const cases = [
    ['laravel', { artisan: '', 'composer.json': '{}', 'package.json': pkg({ vite: '5' }) }], ['nextjs', { 'package.json': pkg({ next: '14', vite: '5' }) }], ['nestjs', { 'package.json': pkg({ '@nestjs/core': '10' }) }],
    ['nuxt', { 'package.json': pkg({ nuxt: '3' }) }], ['static-spa', { 'package.json': pkg({ react: '18', 'react-scripts': '5' }) }], ['static-spa', { 'package.json': pkg({ vite: '5', vue: '3' }) }],
    ['static-spa', { 'package.json': pkg({ '@angular/core': '17' }) }], ['node', { 'package.json': pkg({ express: '4' }) }], ['spring', { 'pom.xml': '<project/>' }], ['spring', { 'build.gradle.kts': '' }],
    ['dotnet', { 'src/Api/Api.csproj': '<Project/>' }], ['dotnet', { 'My.sln': '' }], ['go', { 'go.mod': 'module x' }], ['python', { 'requirements.txt': 'flask' }], ['python', { 'manage.py': '' }],
    ['php', { 'index.php': '<?php' }], ['static-html', { 'index.html': '<html>' }], ['custom', { 'README.md': 'x' }],
  ];
  for (const [want, files] of cases) assert.equal(detect(files), want, JSON.stringify(Object.keys(files)));
});

// ------------------------------------------------------------------ API + server-side detection

test('GET /api/presets lists every framework by group', { skip }, async () => {
  const r = await st.call('GET', '/api/presets');
  assert.equal(r.status, 200);
  assert.ok(r.json.presets.length >= 13);
  const groups = new Set(r.json.presets.map((p) => p.group));
  for (const g of ['Node.js', 'Frontend', 'PHP', 'Java', '.NET']) assert.ok(groups.has(g), g);
  const next = r.json.presets.find((p) => p.id === 'nextjs');
  assert.equal(next.mode, 'service');
  assert.deepEqual(next.tools, ['node']);
});

test('detection clones the repository on the server and names the framework', { skip }, async () => {
  const detect = (repo, extra = {}) => st.call('POST', '/api/apps/detect', { repoUrl: repo.url, branch: 'main', ...extra });
  const cases = [
    ['laravel', { artisan: '', 'composer.json': '{}' }], ['spring', { 'pom.xml': '<project/>' }], ['dotnet', { 'App.csproj': '<Project/>' }],
    ['static-spa', { 'package.json': JSON.stringify({ devDependencies: { vite: '5' } }) }], ['go', { 'go.mod': 'module x' }], ['nestjs', { 'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '10' } }) }],
  ];
  for (const [want, files] of cases) {
    const r = await detect(gitRepo(files));
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.preset, want);
    assert.ok(r.json.label && r.json.mode);
  }
  assert.equal((await detect({ url: 'file:///no/such/repo' })).status, 400);
  const bad = await detect({ url: 'file:///no/such/repo' });
  assert.match(bad.json.error, /Could not read the repository/);
  assert.equal((await detect(gitRepo({ 'a.txt': 'x' }), { authType: 'token' })).status, 400, 'private repositories need credentials');
  assert.equal((await detect({ url: '--upload-pack=x' })).status, 400);
  const vc = await st.loginViewer();
  assert.equal((await st.call('POST', '/api/apps/detect', { repoUrl: 'file:///x' }, { cookieOverride: vc })).status, 403);
  assert.equal((await st.call('GET', '/api/presets', undefined, { cookieOverride: vc })).status, 200);
});

test('tools: every runtime a preset needs can be checked and installed from the panel', { skip }, async () => {
  const r = await st.call('GET', '/api/provision/status');
  for (const t of ['git', 'node', 'java', 'maven', 'dotnet', 'php', 'composer', 'go', 'python', 'nginx', 'certbot']) assert.ok(t in r.json.tools, t);
  assert.ok(r.json.tools.go.installed && r.json.tools.java.installed && r.json.tools.php.installed && r.json.tools.composer.installed);
  assert.equal(r.json.tools.dotnet.installed, false, 'not installed in this environment');
  for (const ok of [['java'], ['dotnet', 'php', 'composer'], ['go', 'python']]) {
    // validation only: do not actually run dnf here
    const { DeployManager } = require('../server/lib/deploy');
    assert.ok(ok.every((t) => DeployManager.INSTALLABLE.includes(t)));
  }
  assert.equal((await st.call('POST', '/api/provision/install', { tools: ['bash -c evil'] })).status, 400);
});

// ------------------------------------------------------------------ static sites (React / Vue / Angular / Vite ...)

const SPA = (v, extra = {}) => ({
  'package.json': JSON.stringify({ name: 'spa', version: '1.0.0', scripts: { build: 'node build.js' } }),
  'build.js': [
    "const fs = require('fs');",
    "if (process.env.FAIL_BUILD) { console.error('build exploded'); process.exit(1); }",
    "const out = process.env.OUT_DIR || 'dist';",
    "fs.mkdirSync(out + '/assets', { recursive: true });",
    "fs.writeFileSync(out + '/index.html', '<h1>' + (process.env.VITE_TITLE || 'untitled') + ' v' + fs.readFileSync('version.txt', 'utf8').trim() + '</h1>');",
    "fs.writeFileSync(out + '/assets/app.js', 'console.log(1)');",
  ].join('\n'),
  'version.txt': String(v), ...extra,
});

test('static site: build, serve the output folder, no process, no port', { skip }, async () => {
  const repo = gitRepo(SPA(1));
  const app = await mkApp({ name: 'spa', framework: 'static-spa', repoUrl: repo.url, env: { VITE_TITLE: 'Hello SPA' } });
  assert.equal(app.mode, 'static');
  assert.equal(app.port, undefined, 'no port needed');
  assert.ok(!app.unit, 'no service unit');
  const r = await deploy(app.id);
  assert.equal(r.deploy.status, 'success', r.log);
  assert.ok(r.log.includes('Serving the folder: dist'));
  const live = path.join(appsDir(), 'spa/live');
  assert.equal(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), '<h1>Hello SPA v1</h1>', 'build-time environment variables reach the build');
  assert.ok(fs.lstatSync(live).isSymbolicLink() && fs.readlinkSync(live).endsWith('/dist'));
  assert.ok(!fs.existsSync(path.join(st.target.dirs.units, 'panel-app-spa.service')), 'no systemd unit for a static site');
  const d = await detail(app.id);
  assert.equal(d.status.mode, 'static');
  assert.equal(d.status.active, 'serving');
  assert.equal((await st.call('POST', '/api/apps/service', { id: app.id, action: 'restart' })).status, 400, 'nothing to restart');
  assert.equal((await st.call('GET', `/api/apps/logs?id=${app.id}`)).status, 400);
  const env = await st.call('POST', '/api/apps/env/apply', { id: app.id });
  assert.equal(env.status, 400);
  assert.match(env.json.error, /deploy again/i, 'static sites bake the environment in at build time');

  // domain: nginx serves the live folder with SPA fallback; real nginx validates it
  const site = await st.call('POST', '/api/sites', { domain: 'spa.test.example', upstream: { type: 'app', appId: app.id } });
  assert.equal(site.status, 200, site.raw);
  const c = conf('spa.test.example');
  assert.ok(c.includes(`root ${appsDir()}/spa/live;`));
  assert.match(c, /try_files \$uri \/index\.html;/, 'client-side routes fall back to index.html');
  assert.ok(!c.includes('proxy_pass'));

  // new version goes live atomically; rollback switches the served folder too
  repo.commit(SPA(2));
  assert.equal((await deploy(app.id)).deploy.status, 'success');
  assert.ok(fs.readFileSync(path.join(live, 'index.html'), 'utf8').includes('v2'));
  const releases = (await detail(app.id)).releases;
  const old = releases.find((x) => !x.current);
  const rb = await st.call('POST', '/api/apps/rollback', { id: app.id, release: old.id });
  assert.equal((await waitDeploy(st, rb.json.deploy.id)).deploy.status, 'success');
  assert.ok(fs.readFileSync(path.join(live, 'index.html'), 'utf8').includes('v1'), 'rolled back');
  await st.call('DELETE', `/api/sites?id=${site.json.site.id}`);
});

test('static site: failures never touch what is live', { skip }, async () => {
  const repo = gitRepo(SPA(1));
  const app = await mkApp({ name: 'spa2', framework: 'static-spa', repoUrl: repo.url });
  assert.equal((await deploy(app.id)).deploy.status, 'success');
  const live = path.join(appsDir(), 'spa2/live');
  const before = fs.readlinkSync(live);
  // build failure
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: app.id, vars: { FAIL_BUILD: '1' } })).status, 200);
  const bad = await deploy(app.id);
  assert.equal(bad.deploy.status, 'failed');
  assert.ok(bad.log.includes('build exploded'));
  assert.equal(fs.readlinkSync(live), before, 'previous version still served');
  assert.equal(fs.readdirSync(path.join(appsDir(), 'spa2/releases')).length, 1, 'partial release removed');
  // build that produces no index.html in a known place
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: app.id, vars: { OUT_DIR: 'weird' } })).status, 200);
  const none = await deploy(app.id);
  assert.equal(none.deploy.status, 'failed');
  assert.match(none.log, /Could not find the build output/);
  // ...which an explicit output folder fixes
  assert.equal((await st.call('PUT', '/api/apps', { id: app.id, outputDir: 'weird' })).status, 200);
  assert.equal((await deploy(app.id)).deploy.status, 'success');
  assert.ok(fs.readlinkSync(live).endsWith('/weird'));
  assert.equal((await st.call('PUT', '/api/apps', { id: app.id, outputDir: '../etc' })).status, 400);
  assert.equal((await st.call('PUT', '/api/apps', { id: app.id, outputDir: '/etc' })).status, 400);
});

test('static site: Angular-style nested output is found automatically', { skip }, async () => {
  const repo = gitRepo(SPA(1, { 'build.js': "const fs=require('fs'); fs.mkdirSync('dist/my-app/browser',{recursive:true}); fs.writeFileSync('dist/my-app/browser/index.html','<app-root></app-root>'); fs.writeFileSync('dist/my-app/3rdpartylicenses.txt','x');" }));
  const app = await mkApp({ name: 'ng', framework: 'static-spa', repoUrl: repo.url });
  const r = await deploy(app.id);
  assert.equal(r.deploy.status, 'success', r.log);
  assert.ok(fs.readlinkSync(path.join(appsDir(), 'ng/live')).endsWith('/dist/my-app/browser'), 'chose the folder that holds index.html');
});

test('plain HTML site: no build at all', { skip }, async () => {
  const repo = gitRepo({ 'index.html': '<h1>plain</h1>', 'about.html': 'x' });
  const app = await mkApp({ name: 'plain', framework: 'static-html', repoUrl: repo.url });
  const r = await deploy(app.id);
  assert.equal(r.deploy.status, 'success', r.log);
  assert.equal(fs.readFileSync(path.join(appsDir(), 'plain/live/index.html'), 'utf8'), '<h1>plain</h1>');
});

// ------------------------------------------------------------------ services built with real toolchains

const serviceDeploy = async (name, files, extra, probe) => {
  const repo = gitRepo(files);
  const port = await freePort();
  const app = await mkApp({ name, repoUrl: repo.url, port, ...extra });
  const r = await deploy(app.id);
  assert.equal(r.deploy.status, 'success', r.log);
  const body = await get(port, probe || '/');
  return { app, r, port, body, repo };
};

test('Go service: real go build, started on the assigned port', { skip: skip || !hasBin('go') }, async () => {
  const files = { 'go.mod': 'module goapp\n\ngo 1.21\n', 'main.go': 'package main\nimport ("fmt";"net/http";"os")\nfunc main(){ http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request){ fmt.Fprint(w, "go-app on "+os.Getenv("PORT")) }); http.ListenAndServe("127.0.0.1:"+os.Getenv("PORT"), nil) }\n' };
  const { port, body, r, app } = await serviceDeploy('goapp', files, { framework: 'go' });
  assert.equal(body, `go-app on ${port}`);
  assert.ok(r.log.includes('Building'));
  assert.equal((await detail(app.id)).status.active, 'active');
});

test('Java service: real JVM, the Spring-style start command passes --server.port', { skip: skip || !hasBin('javac') || !hasBin('java') }, async () => {
  const files = {
    'Main.java': 'import com.sun.net.httpserver.*; import java.net.InetSocketAddress; public class Main { public static void main(String[] a) throws Exception { int port = 0; for (String s : a) if (s.startsWith("--server.port=")) port = Integer.parseInt(s.substring(14)); HttpServer h = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0); h.createContext("/", x -> { byte[] b = "java-app".getBytes(); x.sendResponseHeaders(200, b.length); x.getResponseBody().write(b); x.close(); }); h.start(); } }\n',
    'pom.xml': '<project/>',
  };
  // the preset's build normally calls Maven/Gradle; here a plain javac/jar build stands in, while the DEFAULT start command is exercised for real
  const { body, app } = await serviceDeploy('javaapp', files, { framework: 'spring', buildCmd: 'mkdir -p target/classes && javac -d target/classes Main.java && jar cfe target/app.jar Main -C target/classes .' });
  assert.equal(body, 'java-app');
  assert.ok(P.resolve({ framework: 'spring' }).start.includes('--server.port=$PORT'));
  assert.equal((await detail(app.id)).status.active, 'active');
});

test('Python service: real virtualenv, custom start command', { skip: skip || !hasBin('python3') }, async () => {
  const files = { 'server.py': "import os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\nclass H(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200); self.end_headers(); self.wfile.write(b'py-app')\nHTTPServer(('127.0.0.1', int(os.environ['PORT'])), H).serve_forever()\n" };
  const { body, r } = await serviceDeploy('pyapp', files, { framework: 'python', startCmd: 'exec .venv/bin/python server.py' });
  assert.equal(body, 'py-app');
  assert.ok(r.log.includes('Installing dependencies'));
  assert.ok(fs.existsSync(path.join(appsDir(), 'pyapp/current/.venv/bin/python')), 'virtualenv created in the release');
});

// ------------------------------------------------------------------ PHP (Laravel-style) with real PHP + composer

const ARTISAN = String.raw`#!/usr/bin/env php
<?php
$cmd = $argv[1] ?? ''; $root = __DIR__;
switch ($cmd) {
  case 'config:cache': @mkdir("$root/bootstrap/cache", 0775, true); file_put_contents("$root/bootstrap/cache/config.php", '<?php return [];'); echo "Configuration cached\n"; break;
  case 'route:cache': case 'view:cache': echo "$cmd ok\n"; break;
  case 'migrate':
    if (file_exists("$root/fail-migrate")) { fwrite(STDERR, "SQLSTATE[HY000]: migration failed\n"); exit(1); }
    @mkdir("$root/storage/logs", 0775, true); file_put_contents("$root/storage/logs/migrated.log", date('c') . ' migrated by uid ' . posix_getuid() . "\n", FILE_APPEND); echo "Nothing to migrate.\n"; break;
  case 'queue:restart': @mkdir("$root/storage/framework/cache", 0775, true); file_put_contents("$root/storage/framework/cache/queue-restart", (string) time()); echo "queue restart signalled\n"; break;
  default: fwrite(STDERR, "unknown command $cmd\n"); exit(1);
}
`;
const PHP = (v, extra = {}) => ({
  'composer.json': JSON.stringify({ name: 't/phpapp', require: {}, autoload: { 'psr-4': { 'App\\': 'app/' } } }),
  artisan: ARTISAN, 'public/index.php': '<?php echo "php-app v" . trim(file_get_contents(__DIR__ . "/../version.txt"));',
  'version.txt': String(v), 'storage/logs/.gitignore': '*\n!.gitignore\n', 'storage/framework/cache/.gitignore': '*\n!.gitignore\n', 'bootstrap/cache/.gitignore': '*\n!.gitignore\n', ...extra,
});
const reloads = () => { try { return fs.readFileSync(path.join(st.target.state, 'reloads.log'), 'utf8'); } catch { return ''; } };

test('PHP / Laravel mode: composer, shared storage, release command, PHP-FPM reload, no process', { skip: skip || !hasBin('php') || !hasBin('composer') }, async () => {
  const repo = gitRepo(PHP(1));
  const app = await mkApp({ name: 'phpapp', framework: 'laravel', repoUrl: repo.url, runAs: 'root', env: { APP_ENV: 'production' } });
  assert.equal(app.mode, 'php');
  assert.ok(!app.unit, 'no service unit');
  assert.deepEqual(app.effective.sharedPaths, ['storage']);
  assert.equal(app.effective.releaseCmd, 'php artisan migrate --force', 'the migration step is a visible default');

  const r = await deploy(app.id);
  assert.equal(r.deploy.status, 'success', r.log);
  for (const step of ['Installing dependencies', 'Building', 'Running the release command', 'Going live', 'Running the after-deploy command']) assert.ok(r.log.includes(step), step);
  const dir = path.join(appsDir(), 'phpapp');
  const rel = fs.readlinkSync(path.join(dir, 'current'));
  assert.ok(fs.existsSync(path.join(rel, 'vendor/autoload.php')), 'composer ran');
  assert.ok(fs.lstatSync(path.join(rel, 'storage')).isSymbolicLink() && fs.readlinkSync(path.join(rel, 'storage')) === path.join(dir, 'shared/storage'), 'storage is shared between releases');
  assert.ok(fs.readFileSync(path.join(dir, 'shared/storage/logs/migrated.log'), 'utf8').includes('migrated by uid'), 'the release command ran against the shared storage');
  assert.ok(fs.readlinkSync(path.join(rel, '.env')).endsWith('shared/.env'));
  assert.equal(fs.readlinkSync(path.join(dir, 'live')), path.join(rel, 'public'), 'nginx will serve public/');
  assert.ok(fs.existsSync(path.join(rel, 'bootstrap/cache/config.php')), 'build step cached the config');
  assert.ok(fs.existsSync(path.join(dir, 'shared/storage/framework/cache/queue-restart')), 'after-deploy command restarted the workers');
  assert.match(reloads(), /reload php-fpm\.service/, 'PHP-FPM reloaded so OPcache sees the new code');
  assert.ok(!fs.existsSync(path.join(st.target.dirs.units, 'panel-app-phpapp.service')), 'PHP apps have no systemd unit');
  const d = await detail(app.id);
  assert.equal(d.status.active, 'serving');

  // storage survives a new release
  fs.writeFileSync(path.join(dir, 'shared/storage/uploaded.txt'), 'user upload');
  repo.commit({ 'version.txt': '2' });
  const r2 = await deploy(app.id);
  assert.equal(r2.deploy.status, 'success', r2.log);
  const rel2 = fs.readlinkSync(path.join(dir, 'current'));
  assert.notEqual(rel2, rel);
  assert.equal(fs.readFileSync(path.join(rel2, 'storage/uploaded.txt'), 'utf8'), 'user upload', 'uploads are not lost on deploy');
  assert.equal(execFileSync('php', [path.join(rel2, 'public/index.php')]).toString(), 'php-app v2');

  // a failing migration aborts BEFORE going live: nothing changes
  repo.commit({ 'fail-migrate': 'x', 'version.txt': '3' });
  const bad = await deploy(app.id);
  assert.equal(bad.deploy.status, 'failed');
  assert.ok(bad.log.includes('migration failed'));
  assert.ok(!bad.log.includes('Going live'), 'the release never went live');
  assert.equal(fs.readlinkSync(path.join(dir, 'current')), rel2, 'still on v2');
  assert.equal(fs.readdirSync(path.join(dir, 'releases')).length, 2, 'failed release removed');
});

test('PHP mode: rollback warns about migrations; environment changes refresh the config cache; migrations can be switched off', { skip: skip || !hasBin('php') || !hasBin('composer') }, async () => {
  const repo = gitRepo(PHP(1));
  const app = await mkApp({ name: 'phpapp2', framework: 'laravel', repoUrl: repo.url, runAs: 'root', releaseCmd: '' });
  assert.equal(app.effective.releaseCmd, '', 'migrations switched off by the user');
  const dir = path.join(appsDir(), 'phpapp2');
  const r1 = await deploy(app.id);
  assert.equal(r1.deploy.status, 'success', r1.log);
  assert.ok(!r1.log.includes('Running the release command'));
  assert.ok(!fs.existsSync(path.join(dir, 'shared/storage/logs/migrated.log')), 'no migration ran');

  assert.equal((await st.call('PUT', '/api/apps', { id: app.id, releaseCmd: 'php artisan migrate --force' })).status, 200);
  repo.commit({ 'version.txt': '2' });
  assert.equal((await deploy(app.id)).deploy.status, 'success');
  const old = (await detail(app.id)).releases.find((x) => !x.current);
  const rb = await st.call('POST', '/api/apps/rollback', { id: app.id, release: old.id });
  const rbDone = await waitDeploy(st, rb.json.deploy.id);
  assert.equal(rbDone.deploy.status, 'success', rbDone.log);
  assert.match(rbDone.log, /database changes .* NOT reverted/i);

  fs.rmSync(path.join(dir, 'current/bootstrap/cache/config.php'), { force: true });
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: app.id, vars: { APP_NAME: 'Changed' } })).status, 200);
  const ap = await st.call('POST', '/api/apps/env/apply', { id: app.id });
  assert.equal(ap.status, 200, ap.raw);
  assert.ok(fs.existsSync(path.join(dir, 'current/bootstrap/cache/config.php')), 'config cache rebuilt after the .env change');
  assert.ok(fs.readFileSync(path.join(dir, 'shared/.env'), 'utf8').includes('APP_NAME="Changed"'));
});

test('PHP mode: nginx serves live/ through PHP-FPM; real nginx validates the generated config', { skip: skip || !hasBin('php') || !hasBin('composer') }, async () => {
  const app = (await st.call('GET', '/api/apps')).json.apps.find((a) => a.name === 'phpapp');
  const site = await st.call('POST', '/api/sites', { domain: 'php.test.example', upstream: { type: 'app', appId: app.id } });
  assert.equal(site.status, 200, site.raw);
  const c = conf('php.test.example');
  assert.ok(c.includes(`root ${appsDir()}/phpapp/live;`));
  assert.match(c, /index index\.php index\.html;/);
  assert.match(c, /try_files \$uri \$uri\/ \/index\.php\?\$query_string;/);
  assert.match(c, /fastcgi_pass unix:.*php-fpm\.sock;/);
  assert.match(c, /SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name/, 'realpath_root makes OPcache notice symlink switches');
  assert.match(c, /location ~ \/\\\.\(\?!well-known\)/, 'dotfiles (.env, .git) are not served');
  assert.ok(!c.includes('proxy_pass'));
  assert.equal(site.json.site.upstreamLabel, 'app: phpapp (Laravel / PHP)');
  await st.call('DELETE', `/api/sites?id=${site.json.site.id}`);
});

test('PHP mode as another Linux user: files, storage and artisan belong to the app user (sudo -u)', { skip: skip || !hasBin('php') || !hasBin('composer') || !hasBin('sudo') || !hasBin('useradd') }, async () => {
  const user = 'panelphp';
  spawnSync('useradd', ['-m', '-s', '/bin/bash', user]);
  try {
    const repo = gitRepo(PHP(1));
    const app = await mkApp({ name: 'phpuser', framework: 'laravel', repoUrl: repo.url, runAs: user });
    const r = await deploy(app.id);
    assert.equal(r.deploy.status, 'success', r.log);
    const dir = path.join(appsDir(), 'phpuser');
    const owner = (p) => execFileSync('stat', ['-c', '%U', p]).toString().trim();
    const rel = fs.readlinkSync(path.join(dir, 'current'));
    assert.equal(owner(path.join(rel, 'artisan')), user, 'release files owned by the app user');
    assert.equal(owner(path.join(dir, 'shared/storage')), user, 'shared storage owned by the app user');
    assert.equal(owner(path.join(dir, 'shared/.env')), user);
    assert.equal(fs.statSync(path.join(dir, 'shared/.env')).mode & 0o777, 0o600, '.env is private');
    assert.equal(owner(path.join(dir, 'shared/storage/logs/migrated.log')), user, 'artisan ran as the app user, so web-written and CLI-written files never clash');
    assert.match(fs.readFileSync(path.join(dir, 'shared/storage/logs/migrated.log'), 'utf8'), new RegExp(`uid ${execFileSync('id', ['-u', user]).toString().trim()}`));
    // a second deploy (the SSH user must still be able to replace the app-user-owned env file)
    repo.commit({ 'version.txt': '2' });
    assert.equal((await deploy(app.id)).deploy.status, 'success');
  } finally { spawnSync('userdel', ['-r', user]); }
});

test('apps can be created for every framework without commands; viewers see the mode', { skip }, async () => {
  const repo = gitRepo({ 'a.txt': 'x' });
  for (const p of P.PRESETS) {
    const body = { name: `fw-${p.id}`.slice(0, 30), framework: p.id, repoUrl: repo.url };
    if (p.mode === 'service') body.port = await freePort();
    const r = await st.call('POST', '/api/apps', body);
    assert.equal(r.status, 200, `${p.id}: ${r.raw}`);
    assert.equal(r.json.app.mode, p.mode);
    assert.equal(r.json.app.framework, p.id);
  }
  assert.equal((await st.call('POST', '/api/apps', { name: 'bad-fw', framework: 'cobol', repoUrl: repo.url, port: 4999 })).status, 400);
  const noPort = await st.call('POST', '/api/apps', { name: 'svc-noport', framework: 'node', repoUrl: repo.url });
  assert.equal(noPort.status, 400, 'services need a port');
  const mode = (await st.call('GET', '/api/apps')).json.apps.find((a) => a.name === 'fw-laravel');
  assert.equal((await st.call('PUT', '/api/apps', { id: mode.id, framework: 'node' })).status, 400, 'cannot turn a PHP app into a service');
  assert.equal((await st.call('PUT', '/api/apps', { id: mode.id, framework: 'php' })).status, 200, 'same-mode framework change is fine');
  const vc = await st.loginViewer();
  const list = await st.call('GET', '/api/apps', undefined, { cookieOverride: vc });
  assert.equal(list.status, 200);
  assert.ok(list.json.apps.every((a) => a.mode && a.framework));
});
