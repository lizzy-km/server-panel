'use strict';
/**
 * Database management against REAL MariaDB and PostgreSQL servers (whichever are running; the rest is skipped).
 * Every database/user created here is prefixed ptest_ and removed afterwards.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { canTarget, makeStack, tmp, freePort } = require('./helpers');
const { DatabaseManager, genPassword } = require('../server/lib/databases');
const { mergeEnvText } = require('../server/index');

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const up = {
  mysql: sh('mysql', ['-N', '-B', '-e', 'select 1']).status === 0,
  postgres: sh('sudo', ['-n', '-u', 'postgres', 'psql', '-X', '-At', '-c', 'select 1']).status === 0,
};
const skipAll = !canTarget();
let st;
const made = { mysql: { dbs: [], users: [] }, postgres: { dbs: [], users: [] } };

const client = {
  mysql: (user, pw, db, sql) => sh('mysql', ['-N', '-B', '-u', user, `-p${pw}`, db, '-e', sql]),
  postgres: (user, pw, db, sql) => sh('psql', ['-q', '-X', '-At', '-h', '127.0.0.1', '-U', user, '-d', db, '-c', sql], { env: { ...process.env, PGPASSWORD: pw } }),
};
const admin = {
  mysql: (sql) => sh('mysql', ['-N', '-B', '-e', sql]),
  postgres: (sql, db = 'postgres') => sh('sudo', ['-n', '-u', 'postgres', 'psql', '-q', '-X', '-At', '-d', db, '-c', sql]),
};
const uniq = () => 'ptest_' + Math.random().toString(36).slice(2, 8);

before(async () => { if (!skipAll) st = await makeStack(); });
after(() => {
  if (!skipAll) st.stop();
  for (const d of made.mysql.dbs) admin.mysql(`DROP DATABASE IF EXISTS \`${d}\``);
  for (const u of made.mysql.users) admin.mysql(`DROP USER IF EXISTS '${u}'@'localhost'`);
  for (const d of made.postgres.dbs) admin.postgres(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
  for (const u of made.postgres.users) admin.postgres(`DROP ROLE IF EXISTS "${u}"`);
});

test('passwords are random, long and accepted by the validator', () => {
  const a = genPassword(); const b = genPassword();
  assert.equal(a.length, 24);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9]+$/);
  assert.equal(DatabaseManager.connectionEnv('mysql', { database: 'd', user: 'u', password: 'p@ss/w:rd' }).DATABASE_URL, 'mysql://u:p%40ss%2Fw%3Ard@127.0.0.1:3306/d');
  assert.equal(DatabaseManager.connectionEnv('postgres', { database: 'd', user: 'u', password: 'x' }).DB_CONNECTION, 'pgsql');
  assert.ok(DatabaseManager.dumpCommand('mysql', "a'b").includes("'a'\\''b'"), 'database names are shell-quoted in dump commands');
});

test('status reports which engines are installed and running', { skip: skipAll }, async () => {
  const r = await st.call('GET', '/api/db/status');
  assert.equal(r.status, 200, r.raw);
  const by = Object.fromEntries(r.json.engines.map((e) => [e.engine, e]));
  assert.equal(by.mysql.running, up.mysql);
  assert.equal(by.postgres.running, up.postgres);
  if (up.mysql) assert.match(by.mysql.version, /^\d+\.\d+/);
  if (up.postgres) assert.match(by.postgres.version, /^\d+/);
});

for (const engine of ['mysql', 'postgres']) {
  const skip = skipAll || !up[engine];
  const T = (name, fn) => test(`${engine}: ${name}`, { skip }, fn);
  const api = (m, u, b, o) => st.call(m, u, b, o);
  const sysDb = engine === 'mysql' ? 'mysql' : 'postgres';
  let db; let user; let pw;

  T('create a database with its own user; the user works in it and nowhere else', async () => {
    db = uniq(); user = uniq();
    const other = uniq();
    made[engine].dbs.push(db, other); made[engine].users.push(user);
    const r = await api('POST', '/api/db/databases', { engine, name: db, user });
    assert.equal(r.status, 200, r.raw);
    pw = r.json.password;
    assert.equal(pw.length, 24, 'a strong password is generated and returned once');
    assert.equal(r.json.host, '127.0.0.1');
    const c = client[engine](user, pw, db, 'CREATE TABLE notes (id int); INSERT INTO notes VALUES (1); SELECT count(*) FROM notes;');
    assert.equal(c.status, 0, c.stderr);
    assert.equal(c.stdout.trim(), '1');
    // a second database the user was NOT given
    if (engine === 'mysql') admin.mysql(`CREATE DATABASE \`${other}\`; CREATE TABLE \`${other}\`.secret (x int);`); else { admin.postgres(`CREATE DATABASE "${other}"`); admin.postgres('CREATE TABLE secret (x int)', other); }
    const denied = client[engine](user, pw, other, 'SELECT * FROM secret');
    assert.notEqual(denied.status, 0, 'no access to other databases');
    assert.match(denied.stderr, /denied|permission/i);
    // never echoed back anywhere else
    const ov = await api('GET', `/api/db/overview?engine=${engine}`);
    assert.ok(!ov.raw.includes(pw), 'passwords are not part of the overview');
  });

  T('overview lists databases (with sizes, system ones flagged) and users with their databases', async () => {
    const r = await api('GET', `/api/db/overview?engine=${engine}`);
    assert.equal(r.status, 200, r.raw);
    const mine = r.json.databases.find((d) => d.name === db);
    assert.ok(mine && mine.sizeMb >= 0);
    assert.equal(r.json.databases.find((d) => d.name === sysDb).system, true);
    const u = r.json.users.find((x) => x.name === user);
    assert.ok(u, 'user listed');
    assert.ok(u.databases.includes(db), 'the grant is visible');
    assert.equal(u.system, false);
    if (engine === 'mysql') assert.equal(r.json.users.find((x) => x.name === 'root').system, true);
  });

  T('names and passwords are validated; nothing can be injected', async () => {
    for (const name of ['a b', 'x;DROP DATABASE y', "q'r", 'with`tick', '1abc', '', 'a'.repeat(33), 'ünï', '../x']) {
      assert.equal((await api('POST', '/api/db/databases', { engine, name })).status, 400, JSON.stringify(name));
    }
    for (const name of engine === 'mysql' ? ['mysql', 'information_schema', 'sys', 'Performance_Schema'] : ['postgres', 'template0', 'template1']) assert.equal((await api('POST', '/api/db/databases', { engine, name })).status, 400, `reserved ${name}`);
    assert.equal((await api('POST', '/api/db/databases', { engine, name: uniq(), user: engine === 'mysql' ? 'root' : 'postgres' })).status, 400, 'reserved user');
    for (const password of ['short', "has'quote12345", 'has space 12345', 'back\\slash12345', 'x'.repeat(129)]) assert.equal((await api('POST', '/api/db/databases', { engine, name: uniq(), user: uniq(), password })).status, 400, password);
    assert.equal((await api('POST', '/api/db/databases', { engine: 'oracle', name: uniq() })).status, 400);
    assert.equal((await api('DELETE', `/api/db/databases?engine=${engine}&name=${encodeURIComponent('x"; DROP DATABASE y; --')}&confirm=x`)).status, 400);
  });

  T('a failed create leaves nothing half-made (duplicate user rolls the database back)', async () => {
    const d = uniq();
    made[engine].dbs.push(d);
    const dup = await api('POST', '/api/db/databases', { engine, name: d, user });
    assert.equal(dup.status, 400, 'user already exists');
    const ov = await api('GET', `/api/db/overview?engine=${engine}`);
    assert.ok(!ov.json.databases.some((x) => x.name === d), 'the database was removed again');
    assert.equal((await api('POST', '/api/db/databases', { engine, name: db })).status, 400, 'existing database name');
  });

  T('revoke and grant change what the user can reach', async () => {
    assert.equal((await api('POST', '/api/db/grant', { engine, user, database: db, action: 'revoke' })).status, 200);
    assert.notEqual(client[engine](user, pw, db, 'SELECT count(*) FROM notes').status, 0, 'locked out after revoke');
    assert.equal((await api('POST', '/api/db/grant', { engine, user, database: db, action: 'grant' })).status, 200);
    assert.equal(client[engine](user, pw, db, 'SELECT count(*) FROM notes').stdout.trim(), '1', 'access again after grant');
    assert.equal((await api('POST', '/api/db/grant', { engine, user, database: db, action: 'explode' })).status, 400);
    assert.equal((await api('POST', '/api/db/grant', { engine, user: sysDb === 'mysql' ? 'root' : 'postgres', database: db, action: 'revoke' })).status, 400, 'system users are untouchable');
    assert.equal((await api('POST', '/api/db/grant', { engine, user, database: sysDb, action: 'grant' })).status, 400, 'system databases are untouchable');
  });

  T('password reset: the old password stops working, the new one works', async () => {
    const r = await api('POST', '/api/db/users/password', { engine, name: user });
    assert.equal(r.status, 200, r.raw);
    assert.notEqual(r.json.password, pw);
    assert.notEqual(client[engine](user, pw, db, 'SELECT 1').status, 0);
    assert.equal(client[engine](user, r.json.password, db, 'SELECT count(*) FROM notes').stdout.trim(), '1');
    pw = r.json.password;
    const own = 'Chosen-Passw0rd_ok';
    assert.equal((await api('POST', '/api/db/users/password', { engine, name: user, password: own })).status, 200);
    assert.equal(client[engine](user, own, db, 'SELECT 1').status, 0);
    pw = own;
  });

  T('a standalone user can be created, granted and dropped (with confirmation)', async () => {
    const u2 = uniq(); made[engine].users.push(u2);
    const r = await api('POST', '/api/db/users', { engine, name: u2, database: db });
    assert.equal(r.status, 200, r.raw);
    assert.equal(client[engine](u2, r.json.password, db, 'SELECT count(*) FROM notes').stdout.trim(), '1');
    assert.equal((await api('DELETE', `/api/db/users?engine=${engine}&name=${u2}&confirm=wrong`)).status, 400, 'typing the name is required');
    assert.equal((await api('DELETE', `/api/db/users?engine=${engine}&name=${u2}&confirm=${u2}`)).status, 200);
    assert.notEqual(client[engine](u2, r.json.password, db, 'SELECT 1').status, 0);
    assert.equal((await api('DELETE', `/api/db/users?engine=${engine}&name=${engine === 'mysql' ? 'root' : 'postgres'}&confirm=${engine === 'mysql' ? 'root' : 'postgres'}`)).status, 400);
  });

  T('export produces a valid dump; download returns the same bytes; old exports are pruned', async () => {
    const ex = await api('POST', '/api/db/export', { engine, name: db });
    assert.equal(ex.status, 200, ex.raw);
    assert.match(ex.json.file, new RegExp(`^${db}-\\d{14}\\.sql\\.gz$`));
    const onDisk = path.join(st.target.dir, 'exports', ex.json.file);
    const sql = zlib.gunzipSync(fs.readFileSync(onDisk)).toString();
    assert.match(sql, /notes/i);
    assert.equal(fs.statSync(onDisk).mode & 0o777, 0o600, 'exports are private');
    const dl = await fetch(`${st.base}/api/db/download?server=${st.serverId}&file=${ex.json.file}`, { headers: { Cookie: st.cookie } });
    assert.equal(dl.status, 200);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(fs.readFileSync(onDisk)));
    for (const bad of ['../../etc/passwd', 'x.sql.gz', `${db}-1.sql.gz`, 'a/b-20260101000000.sql.gz']) assert.equal((await fetch(`${st.base}/api/db/download?server=${st.serverId}&file=${encodeURIComponent(bad)}`, { headers: { Cookie: st.cookie } })).status, 400, bad);
    for (let i = 0; i < 6; i++) { fs.copyFileSync(onDisk, path.join(st.target.dir, 'exports', `${db}-2026010100000${i}.sql.gz`)); }
    await api('POST', '/api/db/export', { engine, name: db });
    assert.ok(fs.readdirSync(path.join(st.target.dir, 'exports')).filter((f) => f.startsWith(db + '-')).length <= 5, 'only the five newest exports are kept');
  });

  T('import replaces the database after a safety dump, and a bad file restores the old contents automatically', async () => {
    const upload = (name, body, confirm = db) => fetch(`${st.base}/api/db/import?server=${st.serverId}&engine=${engine}&name=${db}&confirm=${confirm}&filename=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Panel-Request': '1', Cookie: st.cookie }, body });
    const good = zlib.gzipSync(engine === 'mysql' ? 'CREATE TABLE imported (n int); INSERT INTO imported VALUES (42);' : 'CREATE TABLE imported (n int); INSERT INTO imported VALUES (42);');
    assert.equal((await upload('d.sql.gz', good, 'wrong')).status, 400, 'confirmation required');
    assert.equal((await upload('d.txt', good)).status, 400, 'only .sql / .sql.gz');
    const ok = await upload('d.sql.gz', good);
    assert.equal(ok.status, 200, await ok.clone().text());
    const body = await ok.json();
    assert.match(body.safetyDump, new RegExp(`^${db}-`));
    assert.equal(client[engine](user, pw, db, 'SELECT n FROM imported').stdout.trim(), '42', 'new contents are in place');
    assert.notEqual(client[engine](user, pw, db, 'SELECT count(*) FROM notes').status, 0, 'the old table is gone: the database was replaced');
    // a broken file must not destroy what is there
    const bad = await upload('broken.sql', 'THIS IS NOT SQL;');
    assert.equal(bad.status, 400);
    const msg = (await bad.json()).error;
    assert.match(msg, /restored to its previous contents/);
    assert.equal(client[engine](user, pw, db, 'SELECT n FROM imported').stdout.trim(), '42', 'previous contents back after the failed import');
    assert.equal(client[engine](user, pw, db, 'SELECT 1').status, 0, 'and the user can still log in');
    // plain (uncompressed) SQL works too
    assert.equal((await upload('p.sql', 'CREATE TABLE plain (n int);')).status, 200);
    assert.equal(client[engine](user, pw, db, 'SELECT count(*) FROM plain').status, 0);
  });

  T('"use in app" writes the connection settings into a panel app\'s environment', async () => {
    const port = await freePort();
    const app = (await api('POST', '/api/apps', { name: 'dbapp', repoUrl: 'https://github.com/o/r.git', port })).json.app;
    const r = await api('POST', '/api/db/use-in-app', { engine, database: db, user, password: pw, target: { type: 'app', id: app.id } });
    assert.equal(r.status, 200, r.raw);
    const env = (await api('GET', `/api/apps/env?id=${app.id}`)).json.vars;
    assert.equal(env.DB_DATABASE, db);
    assert.equal(env.DB_USERNAME, user);
    assert.equal(env.DB_PASSWORD, pw);
    assert.equal(env.DB_HOST, '127.0.0.1');
    assert.match(env.DATABASE_URL, new RegExp(`^${engine === 'mysql' ? 'mysql' : 'postgresql'}://${user}:`));
    assert.equal((await api('POST', '/api/db/use-in-app', { engine, database: 'bad name', user, password: pw, target: { type: 'app', id: app.id } })).status, 400);
    assert.equal((await api('POST', '/api/db/use-in-app', { engine, database: db, user, password: pw, target: { type: 'app', id: 'nope' } })).status, 404);
    await api('DELETE', `/api/apps?id=${app.id}`);
  });

  T('dropping needs the name typed back; system databases are protected; audit never holds passwords', async () => {
    assert.equal((await api('DELETE', `/api/db/databases?engine=${engine}&name=${db}&confirm=nope`)).status, 400);
    assert.equal((await api('DELETE', `/api/db/databases?engine=${engine}&name=${sysDb}&confirm=${sysDb}`)).status, 400);
    assert.equal((await api('DELETE', `/api/db/databases?engine=${engine}&name=${db}&confirm=${db}`)).status, 200);
    assert.notEqual(client[engine](user, pw, db, 'SELECT 1').status, 0);
    const audit = JSON.stringify((await api('GET', '/api/audit')).json.entries);
    assert.ok(audit.includes('db_create') && audit.includes('db_drop') && audit.includes('db_import'));
    assert.ok(!audit.includes(pw), 'passwords never reach the audit log');
  });
}

test('viewers cannot touch databases at all', { skip: skipAll }, async () => {
  const vc = await st.loginViewer();
  for (const [m, u, b] of [['GET', '/api/db/status'], ['GET', '/api/db/overview?engine=mysql'], ['POST', '/api/db/databases', { engine: 'mysql', name: 'x' }], ['DELETE', '/api/db/databases?engine=mysql&name=x&confirm=x'],
    ['POST', '/api/db/users', { engine: 'mysql', name: 'x' }], ['POST', '/api/db/users/password', { engine: 'mysql', name: 'x' }], ['POST', '/api/db/grant', {}], ['DELETE', '/api/db/users?engine=mysql&name=x&confirm=x'],
    ['POST', '/api/db/export', { engine: 'mysql', name: 'x' }], ['GET', '/api/db/download?file=x'], ['POST', '/api/db/import?engine=mysql&name=x', {}], ['POST', '/api/db/use-in-app', {}]]) {
    assert.equal((await st.call(m, u, b, { cookieOverride: vc })).status, 403, `${m} ${u}`);
  }
});
