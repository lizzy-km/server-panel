'use strict';
/**
 * The panel connects as a NORMAL user with sudo (like ec2-user) and deploys apps that run as a DIFFERENT user
 * (like nginx). Running these as root hides every ownership bug, which is how "Permission denied" while cleaning
 * up a failed PHP deploy slipped through. Needs root to create two throw-away Linux users.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { canTarget, hasBin, makeStack, waitDeploy, freePort, get, tmp } = require('./helpers');

const can = canTarget() && hasBin('sudo') && hasBin('useradd') && hasBin('php') && hasBin('composer');
const skip = !can;
const SSH_USER = 'paneldeployer'; const APP_USER = 'panelwebapp';
const SUDOERS = '/etc/sudoers.d/panel-test-deployer';
let st; const repos = [];

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function gitRepo(files) {
  const dir = tmp('perm-repo-'); repos.push(dir);
  const git = (...a) => execFileSync('git', ['-c', 'safe.directory=*', '-C', dir, ...a], { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  const commit = (fs_) => {
    for (const [f, c] of Object.entries(fs_)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c, f === 'artisan' ? { mode: 0o755 } : undefined); }
    git('add', '-A'); git('commit', '-q', '-m', 'update');
    execFileSync('chmod', ['-R', 'a+rX', dir]);
    execFileSync('chown', ['-R', SSH_USER, dir]); // git refuses to clone a local repo owned by someone else ("dubious ownership"); real repos are remote
  };
  commit(files);
  return { url: 'file://' + dir, commit };
}

const ARTISAN = `#!/usr/bin/env php
<?php
$c = $argv[1] ?? ''; $r = __DIR__;
if ($c === 'migrate') { @mkdir("$r/storage/logs", 0775, true); file_put_contents("$r/storage/logs/migrated.log", "ok\\n", FILE_APPEND); echo "migrated\\n"; }
elseif ($c === 'queue:restart') { @mkdir("$r/storage/framework/cache", 0775, true); file_put_contents("$r/storage/framework/cache/queue-restart", '1'); }
elseif (in_array($c, ['config:cache', 'route:cache', 'view:cache'])) { @mkdir("$r/bootstrap/cache", 0775, true); file_put_contents("$r/bootstrap/cache/$c.php", '<?php return [];'); }
else { fwrite(STDERR, "unknown $c\\n"); exit(1); }
`;
const PHP = (v, extra = {}) => ({
  'composer.json': JSON.stringify({ name: 't/p', require: {} }), artisan: ARTISAN, 'public/index.php': '<?php echo "v" . trim(file_get_contents(__DIR__ . "/../version.txt"));', 'version.txt': String(v),
  'storage/logs/.gitignore': '*\n!.gitignore\n', 'storage/framework/cache/.gitignore': '*\n!.gitignore\n', 'bootstrap/cache/.gitignore': '*\n!.gitignore\n', ...extra,
});

const owner = (p) => execFileSync('stat', ['-c', '%U', p]).toString().trim();
const appsDir = () => st.target.dirs.apps;
const mk = async (over) => { const r = await st.call('POST', '/api/apps', { branch: 'main', healthTimeout: 20, ...over }); assert.equal(r.status, 200, r.raw); return r.json.app; };
const deploy = async (id, extra = {}) => { const r = await st.call('POST', '/api/apps/deploy', { id, ...extra }); assert.equal(r.status, 200, r.raw); return waitDeploy(st, r.json.deploy.id, 180000); };
const noPerm = (log, what) => assert.ok(!/permission denied|cannot remove|operation not permitted/i.test(log), `${what}: unexpected permission error:\n${log.split('\n').filter((l) => /denied|cannot|not permitted/i.test(l)).slice(0, 5).join('\n')}`);

before(async () => {
  if (skip) return;
  for (const u of [SSH_USER, APP_USER]) { spawnSync('useradd', ['-m', '-s', '/bin/bash', u]); spawnSync('usermod', ['-p', '*', u]); } // '*' = no password but NOT locked (sshd refuses key logins to locked accounts), like ec2-user
  // passwordless sudo like ec2-user; keep the environment so the fake systemctl (a test shim) is found
  fs.writeFileSync(SUDOERS, `${SSH_USER} ALL=(ALL) NOPASSWD:ALL\nDefaults:${SSH_USER} !env_reset\nDefaults:${SSH_USER} !secure_path\n`, { mode: 0o440 });
  assert.equal(spawnSync('visudo', ['-cf', SUDOERS]).status, 0, 'sudoers drop-in is valid');
  st = await makeStack({ sshUser: SSH_USER });
});
after(() => {
  if (!skip) st.stop();
  for (const d of repos) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(SUDOERS, { force: true });
  for (const u of [SSH_USER, APP_USER]) spawnSync('userdel', ['-r', u]);
});

test('the panel really is connected as a non-root user', { skip }, async () => {
  const r = await st.call('POST', '/api/exec', { command: 'id -un; sudo -n true && echo sudo-ok' });
  assert.match(r.json.output, new RegExp(`^${SSH_USER}\\nsudo-ok`));
});

test('PHP app running as another user: deploy, failed deploy cleanup, pruning, rollback, delete: no permission errors', { skip }, async () => {
  const repo = gitRepo(PHP(1));
  const app = await mk({ name: 'permphp', framework: 'laravel', repoUrl: repo.url, runAs: APP_USER, keepReleases: 2, env: { APP_ENV: 'production' } });
  const dir = path.join(appsDir(), 'permphp');

  const r1 = await deploy(app.id);
  assert.equal(r1.deploy.status, 'success', r1.log);
  noPerm(r1.log, 'first deploy');
  const rel1 = fs.readlinkSync(path.join(dir, 'current'));
  assert.equal(owner(path.join(rel1, 'artisan')), APP_USER, 'the release belongs to the app user');
  assert.equal(owner(path.join(dir, 'shared/storage')), APP_USER);
  assert.equal(owner(path.join(dir, 'shared/storage/logs/migrated.log')), APP_USER, 'artisan ran as the app user');
  assert.equal(owner(path.join(dir, 'shared/.env')), APP_USER);
  assert.ok(fs.existsSync(path.join(rel1, '.outdir')), 'the output folder marker was written even though the release belongs to another user');
  assert.equal(owner(dir), SSH_USER, 'the app folder stays with the SSH user');

  // the case from the real server: a deploy that fails after the release was handed to the app user must clean up after itself
  repo.commit({ 'composer.json': '{ this is not valid json', 'version.txt': '2' });
  const bad = await deploy(app.id);
  assert.equal(bad.deploy.status, 'failed');
  noPerm(bad.log, 'failed deploy cleanup');
  assert.equal(fs.readdirSync(path.join(dir, 'releases')).length, 1, 'the partial release was removed completely');
  assert.equal(fs.readlinkSync(path.join(dir, 'current')), rel1, 'what was live is untouched');

  // more good releases: old ones are pruned (they are owned by the app user)
  for (const v of [3, 4, 5]) {
    repo.commit({ 'composer.json': JSON.stringify({ name: 't/p', require: {} }), 'version.txt': String(v) });
    const r = await deploy(app.id);
    assert.equal(r.deploy.status, 'success', r.log);
    noPerm(r.log, `deploy v${v}`);
  }
  assert.equal(fs.readdirSync(path.join(dir, 'releases')).length, 2, 'only keepReleases releases remain');

  // rollback
  const releases = (await st.call('GET', `/api/apps/detail?id=${app.id}`)).json.releases;
  const old = releases.find((x) => !x.current);
  const rb = await st.call('POST', '/api/apps/rollback', { id: app.id, release: old.id });
  const rbDone = await waitDeploy(st, rb.json.deploy.id);
  assert.equal(rbDone.deploy.status, 'success', rbDone.log);
  noPerm(rbDone.log, 'rollback');

  // environment changes
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: app.id, vars: { APP_NAME: 'X' } })).status, 200);
  const ap = await st.call('POST', '/api/apps/env/apply', { id: app.id });
  assert.equal(ap.status, 200, ap.raw);
  assert.equal(owner(path.join(dir, 'shared/.env')), APP_USER, 'env file keeps the app user as owner after a re-write by the SSH user');

  // delete app + files
  assert.equal((await st.call('DELETE', `/api/apps?id=${app.id}&deleteFiles=1`)).status, 200);
  assert.ok(!fs.existsSync(dir), 'files owned by the app user are really gone');
});

test('static site and service apps running as another user also work without permission errors', { skip }, async () => {
  const spa = gitRepo({ 'package.json': JSON.stringify({ name: 's', scripts: { build: 'node build.js' } }), 'build.js': "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','<h1>x</h1>')" });
  const a1 = await mk({ name: 'permspa', framework: 'static-spa', repoUrl: spa.url, runAs: APP_USER });
  const r1 = await deploy(a1.id);
  assert.equal(r1.deploy.status, 'success', r1.log);
  noPerm(r1.log, 'static deploy');
  assert.ok(fs.readlinkSync(path.join(appsDir(), 'permspa/live')).endsWith('/dist'));
  assert.equal((await deploy(a1.id)).deploy.status, 'success');
  assert.equal((await st.call('DELETE', `/api/apps?id=${a1.id}&deleteFiles=1`)).status, 200);

  const port = await freePort();
  const node = gitRepo({ 'package.json': JSON.stringify({ name: 'n', scripts: { start: 'node server.js' } }), 'server.js': "require('http').createServer((q,r)=>r.end('svc')).listen(process.env.PORT,'127.0.0.1')" });
  const a2 = await mk({ name: 'permsvc', framework: 'node', repoUrl: node.url, port, runAs: APP_USER });
  const r2 = await deploy(a2.id);
  assert.equal(r2.deploy.status, 'success', r2.log);
  noPerm(r2.log, 'service deploy');
  assert.equal(await get(port), 'svc');
  assert.equal((await st.call('DELETE', `/api/apps?id=${a2.id}&deleteFiles=1`)).status, 200);
});
