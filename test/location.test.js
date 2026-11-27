'use strict';
/** Apps can live in any folder (like /var/www); a folder that already holds someone else's files is never mixed with. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { canTarget, makeStack, waitDeploy, tmp } = require('./helpers');

const skip = !canTarget();
let st; const repos = [];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function repo() {
  const dir = tmp('loc-repo-'); repos.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  return 'file://' + dir;
}
before(async () => { if (!skip) st = await makeStack(); });
after(() => { if (!skip) { st.stop(); for (const d of repos) fs.rmSync(d, { recursive: true, force: true }); } });

const deploy = async (over) => {
  const c = await st.call('POST', '/api/apps', { framework: 'static-html', branch: 'main', authType: 'none', ...over });
  assert.equal(c.status, 200, c.raw);
  const d = await st.call('POST', '/api/apps/deploy', { id: c.json.app.id });
  return { app: c.json.app, ...(await waitDeploy(st, d.json.deploy.id, 60000)) };
};

test('an app can be created under a web-root style folder such as /var/www', { skip }, async () => {
  const www = path.join(st.target.dir, 'var-www'); fs.mkdirSync(www, { recursive: true });
  const r = await deploy({ name: 'site', repoUrl: repo(), baseDir: www });
  assert.equal(r.deploy.status, 'success', r.log);
  assert.ok(fs.existsSync(path.join(www, 'site/current/index.html')));
  assert.equal(r.app.baseDir, www);
});

test('a folder that already has other files is left alone', { skip }, async () => {
  const www = path.join(st.target.dir, 'var-www2'); fs.mkdirSync(path.join(www, 'old'), { recursive: true });
  fs.writeFileSync(path.join(www, 'old/precious.txt'), 'keep me');
  const r = await deploy({ name: 'old', repoUrl: repo(), baseDir: www });
  assert.equal(r.deploy.status, 'failed');
  assert.match(r.log, /already exists and contains files that are not managed by the panel/);
  assert.equal(fs.readFileSync(path.join(www, 'old/precious.txt'), 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(path.join(www, 'old')), ['precious.txt']);
});
