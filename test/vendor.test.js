'use strict';
/** Guards the vendored node_modules/: it must stay portable, small and free of key material. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('vendored dependencies load and are the pinned production set', () => {
  const lock = require('../package-lock.json');
  for (const name of ['ssh2', 'asn1', 'bcrypt-pbkdf', 'safer-buffer', 'tweetnacl']) {
    const v = require(`../node_modules/${name}/package.json`).version;
    assert.equal(v, lock.packages[`node_modules/${name}`].version, `${name} must match package-lock.json`);
  }
  const { Client, utils } = require('ssh2');
  assert.equal(typeof Client, 'function');
  assert.equal(typeof utils.parseKey, 'function');
});

test('vendored tree has no private keys, native binaries or build leftovers', () => {
  const files = walk(root);
  const bad = [];
  for (const f of files) {
    const rel = path.relative(root, f);
    if (/\.(node|so|dll|dylib|exe)$/.test(f) || /(^|[\\/])build[\\/]/.test(rel) || /\.gypi$/.test(f)) bad.push(`${rel} (binary/build artifact)`);
    if (/[\\/](test|tests|fixtures)[\\/]/.test(rel)) bad.push(`${rel} (test data: secret scanners flag its sample keys)`);
    const text = fs.readFileSync(f, 'utf8');
    // a real key has a long base64 body right after the header; library source only mentions the header text
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n[A-Za-z0-9+/=\s]{64,}/.test(text) || /^PuTTY-User-Key-File-\d:/m.test(text)) bad.push(`${rel} (private key material)`);
  }
  assert.deepEqual(bad, []);
  const size = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  assert.ok(size < 4 * 1024 * 1024, `vendored deps grew to ${(size / 1048576).toFixed(1)} MB`);
});
