'use strict';
/** Backups end to end: real sshd, real mysqldump/tar/gzip, fake systemd timers and a fake `aws`. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync, execFileSync } = require('child_process');
const { canTarget, makeStack, tmp } = require('./helpers');
const { onCalendar } = require('../server/lib/backups');

const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: 'utf8', ...o });
const mysqlUp = sh('mysql', ['-N', '-B', '-e', 'select 1']).status === 0;
const skip = !canTarget();
let st; const src = tmp('bk-src-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (m, p, b) => st.call(m, p, b);

before(async () => {
  if (skip) return;
  st = await makeStack();
  fs.mkdirSync(path.join(src, 'data/sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'data/a.txt'), 'alpha\n'); fs.writeFileSync(path.join(src, 'data/sub/b.txt'), 'beta\n');
  fs.mkdirSync(path.join(src, 'data/node_modules'), { recursive: true }); fs.writeFileSync(path.join(src, 'data/node_modules/junk.js'), 'x');
  if (mysqlUp) { sh('mysql', ['-e', 'DROP DATABASE IF EXISTS bkdb; CREATE DATABASE bkdb; CREATE TABLE bkdb.t (n int); INSERT INTO bkdb.t VALUES (7);']); }
});
after(() => { if (!skip) { st.stop(); fs.rmSync(src, { recursive: true, force: true }); if (mysqlUp) sh('mysql', ['-e', 'DROP DATABASE IF EXISTS bkdb']); } });

async function runJob(id) {
  const r = await api('POST', '/api/backups/run', { id });
  assert.equal(r.status, 200, r.raw);
  let log = ''; let off = 0;
  for (let i = 0; i < 240; i++) {
    const l = (await api('GET', `/api/jobs/log?id=${r.json.id}&offset=${off}`)).json;
    log += l.text; off = l.offset;
    if (l.done) break;
    await sleep(250);
  }
  await sleep(100);
  return log;
}
const mk = async (over) => { const r = await api('POST', '/api/backups', { name: 'nightly', sources: [{ type: 'path', path: path.join(src, 'data') }], keep: 7, schedule: { kind: 'manual' }, ...over }); assert.equal(r.status, 200, r.raw); return r.json.job; };
const runs = async (id) => (await api('GET', `/api/backups/runs?id=${id}`)).json.runs;
const del = (id, files = true) => api('DELETE', `/api/backups?id=${id}${files ? '&deleteFiles=1' : ''}`);

test('onCalendar builds the systemd schedule', () => {
  assert.equal(onCalendar({ kind: 'daily', hour: 3, minute: 5 }), '*-*-* 03:05:00');
  assert.equal(onCalendar({ kind: 'weekly', hour: 4, minute: 0, weekday: 1 }), 'Mon *-*-* 04:00:00');
  assert.equal(onCalendar({ kind: 'hourly', minute: 15 }), '*-*-* *:15:00');
  assert.equal(onCalendar({ kind: 'manual' }), '');
});

test('input is validated', { skip }, async () => {
  const bad = async (over, re) => { const r = await api('POST', '/api/backups', { name: 'x1', sources: [{ type: 'path', path: '/etc' }], ...over }); assert.equal(r.status, 400, JSON.stringify(over)); if (re) assert.match(r.json.error, re); };
  await bad({ name: 'Bad Name' });
  await bad({ sources: [] });
  await bad({ sources: [{ type: 'path', path: '/' }] });
  await bad({ sources: [{ type: 'path', path: '/etc/../root' }] });
  await bad({ sources: [{ type: 'path', path: '/tmp/a b;rm' }] });
  await bad({ sources: [{ type: 'db', engine: 'mysql', name: 'mysql' }] });
  await bad({ keep: 0 }); await bad({ keep: 1000 });
  await bad({ schedule: { kind: 'daily', hour: 25 } });
  await bad({ s3: { enabled: true, bucket: 'Bad_Bucket', accessKey: 'AKIAEXAMPLE1234', secretKey: 'secretsecretsecret' } });
  await bad({ excludes: ['a b'] });
});

test('a folder backup runs, is verified, excludes patterns, downloads and restores', { skip }, async () => {
  const job = await mk({ name: 'files', excludes: ['node_modules'] });
  const log = await runJob(job.id);
  assert.match(log, /Backup finished/);
  const [m] = await runs(job.id);
  assert.equal(m.status, 'ok');
  assert.equal(m.items.length, 1); assert.equal(m.items[0].status, 'ok'); assert.ok(m.items[0].bytes > 0);
  const d = await fetch(`${st.base}/api/backups/download?server=${st.serverId}&id=${job.id}&run=${m.run}&file=${m.items[0].file}`, { headers: { Cookie: st.cookie } });
  assert.equal(d.status, 200);
  const f = path.join(st.target.dir, 'dl.tar.gz'); fs.writeFileSync(f, Buffer.from(await d.arrayBuffer()));
  const listing = execFileSync('tar', ['-tzf', f]).toString();
  assert.match(listing, /data\/a\.txt/); assert.match(listing, /data\/sub\/b\.txt/); assert.doesNotMatch(listing, /node_modules/, 'excluded');
  // path traversal in the download is refused
  assert.equal((await fetch(`${st.base}/api/backups/download?server=${st.serverId}&id=${job.id}&run=${m.run}&file=..%2F..%2Fetc%2Fpasswd`, { headers: { Cookie: st.cookie } })).status, 400);
  // staged restore does not touch the live folder
  fs.writeFileSync(path.join(src, 'data/a.txt'), 'CHANGED\n');
  const rs = await api('POST', '/api/backups/restore', { id: job.id, run: m.run, file: m.items[0].file });
  assert.equal(rs.status, 200, rs.raw);
  assert.equal(rs.json.inPlace, false);
  assert.equal(fs.readFileSync(path.join(rs.json.path, 'a.txt'), 'utf8'), 'alpha\n');
  assert.equal(fs.readFileSync(path.join(src, 'data/a.txt'), 'utf8'), 'CHANGED\n', 'live files untouched');
  // in-place restore needs the folder typed back, saves the current files first, then overwrites
  assert.equal((await api('POST', '/api/backups/restore', { id: job.id, run: m.run, file: m.items[0].file, inPlace: true, confirm: 'nope' })).status, 400);
  const ip = await api('POST', '/api/backups/restore', { id: job.id, run: m.run, file: m.items[0].file, inPlace: true, confirm: path.join(src, 'data') });
  assert.equal(ip.status, 200, ip.raw);
  assert.equal(fs.readFileSync(path.join(src, 'data/a.txt'), 'utf8'), 'alpha\n');
  assert.match(execFileSync('tar', ['-xzOf', ip.json.savedAs, `${path.join(src, 'data/a.txt').slice(1)}`]).toString(), /CHANGED/, 'the previous version was saved');
  await del(job.id);
});

test('retention keeps only the newest N backups', { skip }, async () => {
  const job = await mk({ name: 'rotate', keep: 2 });
  for (let i = 0; i < 4; i++) { await runJob(job.id); await sleep(1100); }
  const r = await runs(job.id);
  assert.equal(r.filter((x) => x.status === 'ok').length, 2);
  assert.ok(r[0].run > r[1].run, 'newest first');
  assert.equal((await api('DELETE', `/api/backups/runs?id=${job.id}&run=${r[1].run}`)).status, 200);
  assert.equal((await runs(job.id)).length, 1);
  await del(job.id);
});

test('a failing item is reported, the others are still backed up, nothing is deleted', { skip }, async () => {
  const job = await mk({ name: 'partial', sources: [{ type: 'path', path: path.join(src, 'data') }, { type: 'path', path: path.join(src, 'does-not-exist') }] });
  const log = await runJob(job.id);
  assert.match(log, /missing/); assert.match(log, /finished with errors/);
  const [m] = await runs(job.id);
  assert.equal(m.status, 'failed');
  assert.deepEqual(m.items.map((x) => x.status), ['ok', 'failed']);
  assert.match(m.items[1].error, /missing/);
  assert.ok(fs.existsSync(path.join(src, 'data/a.txt')));
  await del(job.id);
});

test('schedules are real systemd timers that follow edits and disappear on delete', { skip }, async () => {
  const job = await mk({ name: 'timed', schedule: { kind: 'daily', hour: 3, minute: 15 } });
  const u = path.join(st.target.dirs.units, `panel-backup-${job.id}`);
  assert.match(fs.readFileSync(`${u}.timer`, 'utf8'), /OnCalendar=\*-\*-\* 03:15:00/);
  assert.match(fs.readFileSync(`${u}.service`, 'utf8'), new RegExp(`ExecStart=/bin/bash .*${job.id}\\.sh`));
  assert.ok(fs.existsSync(path.join(st.target.dir, 'backup-scripts', `${job.id}.sh`)));
  let list = (await api('GET', '/api/backups')).json.jobs.find((j) => j.id === job.id);
  assert.equal(list.timer.scheduled, true); assert.equal(list.timer.active, true);
  const up = await api('POST', '/api/backups/update', { id: job.id, schedule: { kind: 'weekly', hour: 5, minute: 0, weekday: 2 }, keep: 3 });
  assert.equal(up.status, 200, up.raw);
  assert.match(fs.readFileSync(`${u}.timer`, 'utf8'), /OnCalendar=Tue \*-\*-\* 05:00:00/);
  assert.match(fs.readFileSync(path.join(st.target.dir, 'backup-scripts', `${job.id}.sh`), 'utf8'), /KEEP=3/);
  await api('POST', '/api/backups/update', { id: job.id, schedule: { kind: 'manual' } });
  assert.ok(!fs.existsSync(`${u}.timer`)); assert.ok(!fs.existsSync(`${u}.service`));
  await api('POST', '/api/backups/update', { id: job.id, schedule: { kind: 'daily' } });
  assert.equal((await del(job.id)).status, 200);
  assert.ok(!fs.existsSync(`${u}.timer`)); assert.ok(!fs.existsSync(path.join(st.target.dir, 'backup-scripts', `${job.id}.sh`)));
  assert.ok(!fs.existsSync(path.join(st.target.dir, 'backups', job.id)), 'files removed with deleteFiles');
  assert.equal((await api('GET', '/api/backups')).json.jobs.some((j) => j.id === job.id), false);
});

test('the script written to the server is what a timer would run (no panel needed)', { skip }, async () => {
  const job = await mk({ name: 'selfrun' });
  const script = path.join(st.target.dir, 'backup-scripts', `${job.id}.sh`);
  assert.equal(sh('bash', ['-n', script]).status, 0);
  const r = sh('bash', [script]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((await runs(job.id)).length, 1);
  await del(job.id);
});

test('S3: uploads after a good backup, keeps secrets out of the API and off world-readable disk, and survives an upload failure', { skip }, async () => {
  const job = await mk({ name: 's3job', s3: { enabled: true, bucket: 'my-backups', prefix: 'prod', region: 'eu-west-1', accessKey: 'AKIAEXAMPLEKEY1', secretKey: 'SuperSecretKeyValue123' } });
  assert.equal(job.s3.hasSecret, true); assert.ok(!JSON.stringify(job).includes('SuperSecret'));
  assert.ok(!JSON.stringify((await api('GET', '/api/backups')).json).includes('SuperSecret'));
  const envf = path.join(st.target.dir, 'backup-scripts', `${job.id}.env`);
  assert.equal((fs.statSync(envf).mode & 0o777).toString(8), '600');
  assert.ok(!fs.readFileSync(path.join(st.target.dir, 'backup-scripts', `${job.id}.sh`), 'utf8').includes('SuperSecret'), 'the script itself holds no secret');
  const log = await runJob(job.id);
  assert.match(log, /Uploading to s3:\/\/my-backups\/prod\//);
  const [m] = await runs(job.id);
  assert.equal(m.uploaded, 'yes');
  assert.ok(fs.existsSync(path.join(st.target.state, 's3/my-backups/prod', job.id, m.run, 'manifest.json')) || fs.existsSync(path.join(st.target.state, 's3/my-backups/prod', job.id, m.run, m.items[0].file)));
  assert.match(fs.readFileSync(path.join(st.target.state, 'aws.log'), 'utf8'), /key=AKIAEXAMPLEKEY1 region=eu-west-1/);
  assert.ok(!fs.readFileSync(path.join(st.dataDir, 'audit.log'), 'utf8').includes('SuperSecret'), 'audit log never holds the secret');
  fs.writeFileSync(path.join(st.target.state, 'aws.fail'), '');
  const log2 = await runJob(job.id);
  assert.match(log2, /Upload to S3 failed/);
  const r2 = await runs(job.id);
  assert.equal(r2[0].status, 'ok-not-uploaded'); assert.equal(r2[0].uploaded, 'failed');
  fs.rmSync(path.join(st.target.state, 'aws.fail'));
  // editing without a new secret keeps the old one
  assert.equal((await api('POST', '/api/backups/update', { id: job.id, keep: 4, s3: { enabled: true, bucket: 'my-backups', prefix: 'prod', region: 'eu-west-1', accessKey: 'AKIAEXAMPLEKEY1' } })).status, 200);
  assert.match(fs.readFileSync(envf, 'utf8'), /SuperSecretKeyValue123/);
  // a job with S3 on needs a secret
  assert.equal((await api('POST', '/api/backups', { name: 'nos3secret', sources: [{ type: 'path', path: '/etc' }], s3: { enabled: true, bucket: 'my-backups', accessKey: 'AKIAEXAMPLEKEY1' } })).status, 400);
  await del(job.id);
});

test('database backup and restore (MariaDB)', { skip: skip || !mysqlUp }, async () => {
  const job = await mk({ name: 'dbjob', sources: [{ type: 'db', engine: 'mysql', name: 'bkdb' }] });
  await runJob(job.id);
  const [m] = await runs(job.id);
  assert.equal(m.status, 'ok'); assert.equal(m.items[0].type, 'db'); assert.equal(m.items[0].source, 'mysql:bkdb');
  const dump = zlib.gunzipSync(execFileSync('cat', [path.join(st.target.dir, 'backups', job.id, m.run, m.items[0].file)])).toString();
  assert.match(dump, /CREATE TABLE `t`/);
  sh('mysql', ['-e', 'DROP TABLE bkdb.t; CREATE TABLE bkdb.other (x int)']);
  assert.equal((await api('POST', '/api/backups/restore', { id: job.id, run: m.run, file: m.items[0].file, confirm: 'wrong' })).status, 400);
  const rs = await api('POST', '/api/backups/restore', { id: job.id, run: m.run, file: m.items[0].file, confirm: 'bkdb' });
  assert.equal(rs.status, 200, rs.raw);
  assert.equal(sh('mysql', ['-N', '-B', '-e', 'select n from bkdb.t']).stdout.trim(), '7');
  assert.notEqual(sh('mysql', ['-N', '-B', '-e', 'select * from bkdb.other']).status, 0, 'database replaced, not merged');
  assert.ok(rs.json.safetyDump, 'a safety dump was taken first');
  await del(job.id);
});
