'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const sandbox = {}; vm.createContext(sandbox);
vm.runInContext(pub('cheatsheet.js').replace('const CHEATS', 'var CHEATS'), sandbox);
const CHEATS = sandbox.CHEATS;
const routes = new Set([...pub('app.js').matchAll(/\{ id: '([a-z]+)', label: '[^']+', icon/g)].map((m) => m[1]));

test('the cheat sheet is comprehensive and well formed', () => {
  assert.ok(CHEATS.length >= 18, `sections: ${CHEATS.length}`);
  assert.ok(CHEATS.reduce((n, s) => n + s.items.length, 0) >= 180);
  const ids = CHEATS.map((s) => s.id); assert.equal(new Set(ids).size, ids.length, 'unique section ids');
  for (const need of ['system', 'services', 'logs', 'nginx', 'tls', 'php', 'docker', 'db', 'backup', 'security', 'trouble', 'panel']) assert.ok(ids.includes(need), need);
  for (const sec of CHEATS) for (const it of sec.items) {
    assert.ok(Array.isArray(it) && it.length >= 2 && it[0] && it[1], JSON.stringify(it));
    for (const f of String(it[2] || '').split(',').filter(Boolean)) {
      if (f.startsWith('p:')) assert.ok(routes.has(f.slice(2)), `${it[0]} links to a page that does not exist: ${f}`);
      else assert.equal(f, 'd', `unknown flag ${f}`);
    }
  }
});

test('commands that delete or overwrite are flagged as careful', () => {
  const flagged = (cmd) => CHEATS.flatMap((s) => s.items).filter((i) => i[0].includes(cmd)).every((i) => String(i[2] || '').split(',').includes('d'));
  for (const risky of ['rm -rf', 'docker system prune', 'dnf -y remove', 'migrate --force', 'kill -KILL', 'certbot delete', 'sudo reboot']) assert.ok(flagged(risky), risky);
});

test('every page script has command tooltips on the buttons that change the server', () => {
  const need = { 'app.js': 25, 'deploy.js': 15, 'domains.js': 15, 'databases.js': 12, 'backups.js': 8, 'security.js': 14, 'laravel.js': 8 };
  for (const [f, n] of Object.entries(need)) assert.ok((pub(f).match(/\bcmd:/g) || []).length >= n, `${f} has fewer than ${n} tooltips`);
  assert.match(pub('app.js'), /k === 'cmd'/); assert.match(pub('style.css'), /\.cmdtip/);
});
