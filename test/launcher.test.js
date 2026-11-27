'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createApp } = require('../server/index');
const { setupUrl } = require('../server/launch');
const { tmp } = require('./helpers');

test('launcher: first-run URL carries the setup token in the fragment (never sent to a server); afterwards it is plain', () => {
  const app = createApp({ dataDir: tmp('launch-'), port: 8123, host: '127.0.0.1' });
  const url = setupUrl(app);
  assert.match(url, /^http:\/\/127\.0\.0\.1:8123\/#setup=[0-9a-f]{24}$/);
  assert.equal(url.split('#setup=')[1], app.auth.setupToken);
  assert.equal(setupUrl(createApp({ dataDir: tmp('launch2-'), port: 80, host: '0.0.0.0' })).startsWith('http://127.0.0.1:80/#setup='), true, 'wildcard bind addresses are not browsable');
  app.auth.createUser('admin', 'longenoughpass', 'admin');
  assert.equal(setupUrl(app), 'http://127.0.0.1:8123/', 'no token once an admin exists');
  app.servers.closeAll();
});

test('Windows launcher: a double-clickable .bat with CRLF endings that checks for Node.js and runs the launcher', () => {
  const bat = fs.readFileSync('Start Server Panel.bat', 'utf8');
  assert.ok(bat.includes('\r\n') && !/[^\r]\n/.test(bat), 'CRLF line endings (cmd.exe requires them)');
  assert.match(bat, /where node/);
  assert.match(bat, /node server\\launch\.js/);
  assert.ok(fs.statSync('start-panel.sh').mode & 0o111, 'start-panel.sh is executable');
});
