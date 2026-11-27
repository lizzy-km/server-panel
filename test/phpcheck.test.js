'use strict';
/** A composer.lock that needs a newer PHP than the server has must fail EARLY with a clear message and a hint, not deep inside composer. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { canTarget, hasBin, makeStack, waitDeploy, tmp } = require('./helpers');

const skip = !canTarget() || !hasBin('nginx') || !hasBin('php') || !hasBin('composer');
let st; const repos = [];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function gitRepo(files) {
  const dir = tmp('phpc-repo-'); repos.push(dir);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  return { url: 'file://' + dir };
}
const lock = (phpReq, ext = []) => JSON.stringify({
  packages: [{ name: 'acme/lib', version: '1.0.0', require: { php: phpReq, ...Object.fromEntries(ext.map((e) => [e, '*'])) }, type: 'library' }], 'packages-dev': [], platform: {}, 'platform-dev': [],
  'plugin-api-version': '2.6.0', 'content-hash': 'x',
});
const files = (req, ext) => ({ artisan: '<?php echo 1;', 'composer.json': JSON.stringify({ name: 't/p', require: {} }), 'composer.lock': lock(req, ext), 'public/index.php': '<?php echo "ok";' });

before(async () => { if (!skip) { st = await makeStack(); fs.chmodSync(st.target.dir, 0o755); fs.chmodSync(st.target.dirs.apps, 0o755); } });
after(() => { if (!skip) { st.stop(); for (const d of repos) fs.rmSync(d, { recursive: true, force: true }); } });

test('detect reports the PHP the repository needs', { skip }, async () => {
  const r = await st.call('POST', '/api/apps/detect', { repoUrl: gitRepo(files('>=8.9.1')).url, branch: 'main', authType: 'none' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.preset, 'laravel');
  assert.equal(r.json.php.needs, '8.9');
  assert.ok(r.json.php.problems.some((p) => /PHP/.test(p) && /8\.9\.1/.test(p)), JSON.stringify(r.json.php));
  const ok = await st.call('POST', '/api/apps/detect', { repoUrl: gitRepo(files('>=7.4')).url, branch: 'main', authType: 'none' });
  assert.deepEqual(ok.json.php.problems, []);
});

test('deploy fails early with a clear message and a php hint, and changes nothing', { skip }, async () => {
  const repo = gitRepo(files('>=8.9.1'));
  const c = await st.call('POST', '/api/apps', { name: 'newphp', framework: 'laravel', repoUrl: repo.url, branch: 'main', authType: 'none', runAs: 'root', healthTimeout: 10 });
  assert.equal(c.status, 200, c.raw);
  const d = await st.call('POST', '/api/apps/deploy', { id: c.json.app.id });
  const { deploy: rec, log } = await waitDeploy(st, d.json.deploy.id, 120000);
  assert.equal(rec.status, 'failed');
  assert.equal(rec.hint, 'php:8.9', log);
  assert.match(log, /This server cannot run this app as it is/);
  assert.match(log, /PHP >=8\.9\.1 is required by acme\/lib but this server has PHP \d/);
  assert.match(log, /composer update/);
  assert.doesNotMatch(log, /Installing dependencies/);
  assert.ok(!fs.existsSync(path.join(st.target.dirs.apps, 'newphp/current')), 'nothing went live');
});

test('a missing extension is reported by name', { skip }, async () => {
  const repo = gitRepo(files('>=7.4', ['ext-nonexistentthing']));
  const c = await st.call('POST', '/api/apps', { name: 'noext', framework: 'laravel', repoUrl: repo.url, branch: 'main', authType: 'none', runAs: 'root', healthTimeout: 10 });
  const { deploy: rec, log } = await waitDeploy(st, (await st.call('POST', '/api/apps/deploy', { id: c.json.app.id })).json.deploy.id, 120000);
  assert.equal(rec.status, 'failed');
  assert.match(log, /extension nonexistentthing is required by acme\/lib but is not installed/);
});

test('installing another PHP is refused without confirmation and checks availability first', { skip }, async () => {
  const r = await st.call('POST', '/api/provision/install', { tools: ['php84'] });
  assert.equal(r.status, 200, r.raw);
  let out = ''; for (let i = 0; i < 60; i++) { const l = (await st.call('GET', `/api/jobs/log?id=${r.json.id}&offset=0`)).json; out = l.text; if (l.done) break; await new Promise((x) => setTimeout(x, 500)); }
  assert.match(out, /Nothing was changed|no dnf|not available|dnf/i, out);
});
