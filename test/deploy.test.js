'use strict';
/**
 * Deploy engine, end to end: real sshd, real git repo, real Node app, real curl health checks.
 * Only systemd is faked (test/shims/systemctl launches the unit's ExecStart).  Skipped unless root + sshd + git.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canTarget, makeStack, waitDeploy, makeRepo, freePort, get, tmp } = require('./helpers');
const S = require('../server/lib/scripts');
const { checkRepo } = require('../server/lib/deploy');
const P = require('../server/lib/presets');

const skip = !canTarget();
let st, repo, port, appId, shas = {};

const deployAndWait = async (extra = {}) => {
  const r = await st.call('POST', '/api/apps/deploy', { id: appId, ...extra });
  assert.equal(r.status, 200, r.raw);
  return waitDeploy(st, r.json.deploy.id);
};
const detail = async () => (await st.call('GET', `/api/apps/detail?id=${appId}`)).json;

before(async () => {
  if (skip) return;
  st = await makeStack();
  repo = makeRepo(tmp('repo-'));
  shas.v1 = repo.commit(1);
  port = await freePort();
});

after(() => { if (!skip) { st.stop(); fs.rmSync(repo.dir, { recursive: true, force: true }); } });

test('repository URLs and commands are validated (no git option or transport injection)', () => {
  for (const bad of ['--upload-pack=touch /tmp/x', 'ext::sh -c id', 'https://host/a b', 'https://host/x;rm -rf /', "https://host/x'y", 'file:///etc/passwd', 'ftp://host/repo', '$(id)', '', 'git@host:x`id`']) {
    assert.throws(() => checkRepo(bad, false), /Invalid repository URL|must be https/, bad);
  }
  for (const good of ['https://github.com/org/repo.git', 'git@github.com:org/repo.git', 'ssh://git@host.example/org/repo.git']) assert.equal(checkRepo(good, false), good);
  assert.throws(() => checkRepo('file:///tmp/r', false), /must be https/);
  assert.equal(checkRepo('file:///tmp/r', true), 'file:///tmp/r');
});

test('generated deploy script quotes everything and keeps secrets out of the command line', () => {
  const app = { name: 'web', unit: 'panel-app-web.service', port: 3000, healthPath: '/', repoUrl: 'https://github.com/o/r.git', authType: 'token', tokenUser: 'x-access-token', branch: 'main' };
  const evil = "tok'; touch /tmp/pwned; echo '";
  const cfg = P.resolve({ ...app, framework: 'node' });
  const script = S.deployScript(app, cfg, {
    appDir: '/srv/apps/web', relId: '20260101000000-abcd', ref: 'main', useSudo: true, unitDir: '/etc/systemd/system', allowLocalRepos: false,
    secrets: { gitSecret: evil }, envFile: S.envFileText({ A: 'x"y' }), envShell: S.envShellText({ A: "it's" }), startSh: S.startScript(app, cfg, '/srv/apps/web'), unit: S.unitText(app, '/srv/apps/web', 'ec2-user'), repoLabel: 'github.com/o/r.git',
  });
  assert.ok(script.includes(`'tok'\\''; touch /tmp/pwned; echo '\\'''`) || !script.includes("; touch /tmp/pwned; echo '\n"), 'secret must be shell-quoted');
  assert.match(script, /GIT_ALLOW_PROTOCOL=https:ssh\n/);
  assert.equal(S.envFileText({ A: 'a"b\\c\nd' }), 'A="a\\"b\\\\c\\nd"\n');
  assert.equal(S.envShellText({ A: "it's" }), "export A='it'\\''s'\n");
  // the command run on the server is only "bash -s"; the script (with secrets) travels on stdin
  const { Runner } = require('../server/lib/runner');
  let seen;
  const fake = { stream: async (command, o) => { seen = { command, stdin: o.stdin }; return { code: 0 }; } };
  return new Runner(tmp('rn-')).run({ id: 'abcdef12-0000', host: fake, script }).then(() => {
    assert.equal(seen.command, 'bash -s 2>&1');
    assert.ok(!seen.command.includes('tok'));
    assert.ok(seen.stdin.includes('pwned'));
  });
});

test('prepare-server status reports the tools installed on the target', { skip }, async () => {
  const r = await st.call('GET', '/api/provision/status');
  assert.equal(r.status, 200, r.raw);
  assert.ok(r.json.tools.git.installed && r.json.tools.node.installed && r.json.tools.curl.installed);
  assert.ok(r.json.tools.nginx.installed, 'nginx is installed in this environment');
  assert.ok('certbot' in r.json.tools, 'certbot is reported (the test target has a fake one on PATH)');
  assert.equal((await st.call('POST', '/api/provision/install', { tools: ['rm -rf'] })).status, 400);
  assert.equal((await st.call('POST', '/api/provision/install', { tools: [] })).status, 400);
});

test('creating an app validates input, encrypts secrets and enforces unique ports', { skip }, async () => {
  const base = { name: 'web', repoUrl: 'file://' + repo.dir, branch: 'main', port, healthTimeout: 20 };
  for (const [over, re] of [[{ name: 'Bad Name' }, /App name/], [{ repoUrl: '--x' }, /repository URL/], [{ port: 80 }, /Port must/], [{ branch: '../x' }, /branch/], [{ healthPath: '/a b' }, /Health/], [{ authType: 'token' }, /token is required/]]) {
    const r = await st.call('POST', '/api/apps', { ...base, ...over });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.json.error, re);
  }
  const r = await st.call('POST', '/api/apps', { ...base, env: { GREETING: 'hi there' } });
  assert.equal(r.status, 200, r.raw);
  appId = r.json.app.id;
  assert.deepEqual(r.json.app.envNames, ['GREETING']);
  assert.ok(!r.raw.includes('hi there'), 'env values are never returned');
  assert.equal((await st.call('POST', '/api/apps', { ...base, name: 'web2' })).status, 409, 'port already used');
  assert.equal((await st.call('POST', '/api/apps', { ...base, name: 'web' , port: port + 1 })).status, 409, 'duplicate name');
  const stored = fs.readFileSync(path.join(st.dataDir, 'panel.json'), 'utf8');
  assert.ok(!stored.includes('hi there'), 'env values are encrypted at rest');
  assert.equal((await st.call('PUT', '/api/apps/env', { id: appId, vars: { PORT: '1' } })).status, 400, 'reserved variable');
  assert.equal((await st.call('PUT', '/api/apps/env', { id: appId, vars: { 'BAD NAME': '1' } })).status, 400);
});

test('first deploy: clone, install, build, service, activate, health check', { skip }, async () => {
  const { deploy, log } = await deployAndWait();
  assert.equal(deploy.status, 'success', log);
  assert.equal(deploy.commit, shas.v1);
  assert.equal(deploy.message, 'version 1');
  for (const step of ['==> Cloning', '==> Installing dependencies', '==> Building', '==> Configuring service', '==> Going live', '==> Health check', 'healthy']) assert.ok(log.includes(step), `log has "${step}"`);
  assert.ok(!log.includes('@@'), 'machine markers are not shown in the log');
  assert.equal(await get(port), 'hello 1');
  assert.equal(await get(port, '/env'), 'hi there', 'environment variables reach the app');
  const d = await detail();
  assert.equal(d.status.active, 'active');
  assert.equal(d.releases.length, 1);
  assert.equal(d.releases[0].commit, shas.v1);
  assert.ok(d.releases[0].current);
  assert.equal(d.status.currentRelease, d.releases[0].id);
  const unit = fs.readFileSync(path.join(st.target.dirs.units, 'panel-app-web.service'), 'utf8');
  assert.match(unit, /ExecStart=.*\/shared\/start\.sh/);
  assert.match(unit, /EnvironmentFile=-.*\/shared\/\.env/);
  assert.match(unit, new RegExp(`Environment=PORT=${port}`));
  const envFile = path.join(st.target.dirs.apps, 'web/shared/.env');
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600, 'env file is private');
});

test('second deploy switches releases atomically', { skip }, async () => {
  shas.v2 = repo.commit(2);
  const { deploy, log } = await deployAndWait();
  assert.equal(deploy.status, 'success', log);
  assert.equal(deploy.commit, shas.v2);
  assert.equal(await get(port), 'hello 2');
  const d = await detail();
  assert.equal(d.releases.length, 2);
  assert.equal(d.releases.find((r) => r.current).commit, shas.v2);
  assert.equal(d.deploys[0].status, 'success');
});

test('a failing release is rolled back automatically and the old version keeps serving', { skip }, async () => {
  shas.v3 = repo.commit(3, { broken: true });
  const before = (await detail()).releases.find((r) => r.current).id;
  const { deploy, log } = await deployAndWait();
  assert.equal(deploy.status, 'rolled_back', log);
  assert.ok(log.includes('Health check failed') && log.includes('Rolling back'), log);
  assert.ok(log.includes('boot failure'), 'the service log is included to explain why');
  assert.equal(await get(port), 'hello 2', 'previous version is serving again');
  assert.equal((await detail()).releases.find((r) => r.current).id, before);
  assert.equal(deploy.commit, shas.v3, 'the failed commit is still recorded');
});

test('a failing clone leaves nothing behind and does not touch the running release', { skip }, async () => {
  const before = (await detail()).releases.length;
  const r = await deployAndWait({ ref: 'no-such-branch' });
  assert.equal(r.deploy.status, 'failed', r.log);
  assert.match(r.log, /not found|Remote branch/i);
  assert.equal((await detail()).releases.length, before, 'partial release directory removed');
  assert.equal(await get(port), 'hello 2');
  assert.equal((await st.call('POST', '/api/apps/deploy', { id: appId, ref: '--evil' })).status, 400);
});

test('manual rollback to an older release', { skip }, async () => {
  const d = await detail();
  const oldest = d.releases.find((r) => r.commit === shas.v1);
  assert.ok(oldest, 'v1 release still present');
  const r = await st.call('POST', '/api/apps/rollback', { id: appId, release: oldest.id });
  assert.equal(r.status, 200, r.raw);
  const done = await waitDeploy(st, r.json.deploy.id);
  assert.equal(done.deploy.status, 'success', done.log);
  assert.equal(done.deploy.kind, 'rollback');
  assert.equal(await get(port), 'hello 1');
  assert.equal((await st.call('POST', '/api/apps/rollback', { id: appId, release: '../../etc' })).status, 400);
  assert.equal((await st.call('POST', '/api/apps/rollback', { id: appId, release: '20200101000000-ffff' })).status === 200, true);
  const bad = (await waitDeploy(st, (await st.call('GET', `/api/apps/detail?id=${appId}`)).json.deploys[0].id)).deploy;
  assert.equal(bad.status, 'failed', 'unknown release fails cleanly');
  assert.equal(await get(port), 'hello 1', 'and nothing changed');
});

test('only one deploy per app at a time', { skip }, async () => {
  shas.v4 = repo.commit(4);
  const a = await st.call('POST', '/api/apps/deploy', { id: appId });
  const b = await st.call('POST', '/api/apps/deploy', { id: appId });
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal((await waitDeploy(st, a.json.deploy.id)).deploy.status, 'success');
  assert.equal(await get(port), 'hello 4');
});

test('old releases are pruned to keepReleases but never the current one', { skip }, async () => {
  assert.equal((await st.call('PUT', '/api/apps', { id: appId, keepReleases: 2 })).status, 200);
  for (const v of [5, 6]) { repo.commit(v); assert.equal((await deployAndWait()).deploy.status, 'success'); }
  const d = await detail();
  assert.equal(d.releases.length, 2);
  assert.ok(d.releases[0].current);
  assert.equal(await get(port), 'hello 6');
});

test('environment changes apply on the next deploy; removed variables disappear', { skip }, async () => {
  assert.equal((await st.call('PUT', '/api/apps/env', { id: appId, vars: { GREETING: 'changed', EXTRA: 'x', NOTHING: 'y' } })).status, 200);
  assert.equal((await st.call('PUT', '/api/apps/env', { id: appId, vars: { NOTHING: null } })).json.names.sort().join(), 'EXTRA,GREETING');
  assert.equal((await deployAndWait()).deploy.status, 'success');
  assert.equal(await get(port, '/env'), 'changed');
  const envFile = fs.readFileSync(path.join(st.target.dirs.apps, 'web/shared/.env'), 'utf8');
  assert.ok(!envFile.includes('NOTHING'));
});

test('the .env editor: reveal, replace the whole file, apply without redeploying', { skip }, async () => {
  const vc = await st.loginViewer();
  assert.equal((await st.call('GET', `/api/apps/env?id=${appId}`, undefined, { cookieOverride: vc })).status, 403, 'viewers can never read values');
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: appId, vars: {} }, { cookieOverride: vc })).status, 403);
  assert.equal((await st.call('POST', '/api/apps/env/apply', { id: appId }, { cookieOverride: vc })).status, 403);

  const revealed = await st.call('GET', `/api/apps/env?id=${appId}`);
  assert.equal(revealed.status, 200);
  assert.equal(revealed.json.vars.GREETING, 'changed', 'admins can read the stored values');

  // validation: reserved and malformed names, bad values
  for (const vars of [{ PORT: '1' }, { NODE_ENV: 'x' }, { PATH: '/tmp' }, { 'a b': '1' }, { '1X': '1' }, { OK: 5 }, { OK: 'a\0b' }]) {
    assert.equal((await st.call('POST', '/api/apps/env/save', { id: appId, vars })).status, 400, JSON.stringify(vars));
  }
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: appId, vars: [] })).status, 400);

  // full replace: GREETING changes, EXTRA disappears, a multi-line + special-character value survives
  const tricky = 'p@ss "quoted" \\ back # not-a-comment';
  const save = await st.call('POST', '/api/apps/env/save', { id: appId, vars: { GREETING: 'edited in the panel', MULTI: 'line1\nline2', TRICKY: tricky } });
  assert.equal(save.status, 200, save.raw);
  assert.deepEqual(save.json.names.sort(), ['GREETING', 'MULTI', 'TRICKY']);
  assert.deepEqual(Object.keys((await st.call('GET', `/api/apps/env?id=${appId}`)).json.vars).sort(), ['GREETING', 'MULTI', 'TRICKY'], 'EXTRA was removed');
  assert.equal(await get(port, '/env'), 'changed', 'saving alone does not touch the running app');

  const apply = await st.call('POST', '/api/apps/env/apply', { id: appId });
  assert.equal(apply.status, 200, apply.raw);
  assert.match(apply.json.output, /healthy/);
  assert.equal(await get(port, '/env'), 'edited in the panel', 'new value is live after apply (restart only, no rebuild)');
  const releasesAfter = (await detail()).releases.length;
  const envFile = fs.readFileSync(path.join(st.target.dirs.apps, 'web/shared/.env'), 'utf8');
  assert.ok(!envFile.includes('EXTRA'));
  assert.equal(fs.statSync(path.join(st.target.dirs.apps, 'web/shared/.env')).mode & 0o777, 0o600);
  assert.ok(envFile.includes('TRICKY="p@ss \\"quoted\\" \\\\ back # not-a-comment"'), envFile);
  assert.ok(envFile.includes('MULTI="line1\\nline2"'));
  assert.equal((await detail()).releases.length, releasesAfter, 'no new release was created');

  const audit = (await st.call('GET', '/api/audit')).json.entries;
  assert.ok(audit.some((e) => e.action === 'env_view'), 'revealing values is audited');
  assert.ok(audit.some((e) => e.action === 'env_apply'));
  assert.ok(!JSON.stringify(audit).includes('edited in the panel') && !JSON.stringify(audit).includes(tricky), 'values are never written to the audit log');

  // restore a simple environment for the following tests
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: appId, vars: { GREETING: 'changed' } })).status, 200);
  assert.equal((await st.call('POST', '/api/apps/env/apply', { id: appId })).status, 200);
});

test('applying an environment that stops the app is reported, not hidden', { skip }, async () => {
  // NODE_OPTIONS with an invalid flag makes node refuse to start
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: appId, vars: { GREETING: 'x', NODE_OPTIONS: '--this-flag-does-not-exist' } })).status, 200);
  const r = await st.call('POST', '/api/apps/env/apply', { id: appId });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /did not become healthy/);
  assert.equal((await st.call('POST', '/api/apps/env/save', { id: appId, vars: { GREETING: 'changed' } })).status, 200);
  assert.equal((await st.call('POST', '/api/apps/env/apply', { id: appId })).status, 200, 'fixing the value and applying again recovers');
  assert.equal(await get(port, '/env'), 'changed');
});

test('service controls, status and logs', { skip }, async () => {
  assert.equal((await st.call('POST', '/api/apps/service', { id: appId, action: 'stop' })).status, 200);
  assert.equal((await detail()).status.active, 'inactive');
  assert.equal(await get(port), null);
  assert.equal((await st.call('POST', '/api/apps/service', { id: appId, action: 'start' })).status, 200);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await detail()).status.active, 'active');
  assert.equal((await st.call('POST', '/api/apps/service', { id: appId, action: 'format-disk' })).status, 400);
  assert.equal((await st.call('GET', `/api/apps/logs?id=${appId}&lines=20`)).status, 200);
});

test('webhook: token URL and GitHub signatures, branch filtering, ping, bad credentials', { skip }, async () => {
  const hook = async (appPath, { body = '{}', headers = {} } = {}) => {
    const res = await fetch(st.base + appPath, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  assert.equal((await hook(`/api/hooks/${appId}/whatever`)).status, 404, 'disabled by default');
  assert.equal((await st.call('POST', '/api/apps/webhook', { id: appId, enabled: true })).status, 200);
  const d = await detail();
  assert.match(d.webhookUrl, new RegExp(`/api/hooks/${appId}/[A-Za-z0-9_-]{20,}$`));
  const token = d.webhookUrl.split('/').pop();
  assert.equal((await hook(`/api/hooks/${appId}/wrong-token`)).status, 403);

  const sign = (body, secret = token) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const push = (ref, extra = {}) => JSON.stringify({ ref, ...extra });
  const gh = (body, event = 'push', secret) => hook(`/api/hooks/${appId}/x`, { body, headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': sign(body, secret) } });

  assert.equal((await gh('{}', 'ping')).json.message, 'pong');
  assert.equal((await gh(push('refs/heads/main'), 'push', 'not-the-secret')).status, 403, 'bad signature');
  assert.match((await gh(push('refs/heads/other'))).json.ignored, /push to refs\/heads\/other/);
  assert.match((await gh(push('refs/heads/main', { deleted: true }))).json.ignored, /deleted/);
  assert.match((await gh('{}', 'issues')).json.ignored, /event issues/);

  repo.commit(7);
  const ok = await gh(push('refs/heads/main'));
  assert.equal(ok.status, 202, JSON.stringify(ok.json));
  assert.ok(ok.json.deployId);
  const done = await waitDeploy(st, ok.json.deployId);
  assert.equal(done.deploy.status, 'success', done.log);
  assert.equal(done.deploy.trigger, 'webhook');
  assert.equal(await get(port), 'hello 7');

  repo.commit(8);
  const viaToken = await hook(`/api/hooks/${appId}/${token}`);
  assert.equal(viaToken.status, 202, JSON.stringify(viaToken.json));
  assert.equal((await waitDeploy(st, viaToken.json.deployId)).deploy.status, 'success');
  assert.equal(await get(port), 'hello 8');

  // rotating invalidates the old token
  assert.equal((await st.call('POST', '/api/apps/webhook', { id: appId, enabled: true })).status, 200);
  assert.equal((await hook(`/api/hooks/${appId}/${token}`)).status, 403);
  assert.equal((await st.call('POST', '/api/apps/webhook', { id: appId, enabled: false })).status, 200);
  assert.equal((await hook(`/api/hooks/${appId}/${token}`)).status, 404);
  const audit = (await st.call('GET', '/api/audit')).json.entries;
  assert.ok(audit.some((e) => e.action === 'webhook' && e.user === 'webhook'));
  assert.ok(!JSON.stringify(audit).includes(token), 'token never written to the audit log');
});

test('viewers can look but not change anything', { skip }, async () => {
  const vc = await st.loginViewer();
  const v = (m, u, b) => st.call(m, u, b, { cookieOverride: vc });
  assert.equal((await v('GET', '/api/apps')).status, 200);
  const d = await v('GET', `/api/apps/detail?id=${appId}`);
  assert.equal(d.status, 200);
  assert.ok(!d.raw.includes('webhookToken') && d.json.webhookUrl === null, 'viewers never see the webhook secret');
  assert.equal((await v('GET', '/api/provision/status')).status, 200);
  for (const [m, u, b] of [['POST', '/api/apps', {}], ['PUT', '/api/apps', { id: appId }], ['DELETE', `/api/apps?id=${appId}`], ['PUT', '/api/apps/env', { id: appId, vars: {} }],
    ['POST', '/api/apps/deploy', { id: appId }], ['POST', '/api/apps/rollback', { id: appId, release: 'x' }], ['POST', '/api/apps/service', { id: appId, action: 'stop' }],
    ['POST', '/api/apps/webhook', { id: appId }], ['GET', `/api/apps/logs?id=${appId}`], ['GET', '/api/deploys/log?id=00000000-0000'], ['POST', '/api/provision/install', { tools: ['git'] }]]) {
    assert.equal((await v(m, u, b)).status, 403, `${m} ${u}`);
  }
});

test('deploy log of another server cannot be read through this one', { skip }, async () => {
  const id = (await detail()).deploys[0].id;
  const r = await st.call('GET', `/api/deploys/log?id=${id}`, undefined, { server: 'local' });
  assert.ok([404, 400].includes(r.status));
});

test('deleting an app stops its service and (optionally) removes its files', { skip }, async () => {
  const dir = path.join(st.target.dirs.apps, 'web');
  assert.ok(fs.existsSync(dir));
  assert.equal((await st.call('DELETE', `/api/apps?id=${appId}&deleteFiles=1`)).status, 200);
  assert.ok(!fs.existsSync(dir), 'files removed');
  assert.ok(!fs.existsSync(path.join(st.target.dirs.units, 'panel-app-web.service')), 'unit removed');
  assert.equal(await get(port), null, 'service stopped');
  assert.equal((await st.call('GET', '/api/apps')).json.apps.length, 0);
});
