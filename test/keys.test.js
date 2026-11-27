'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadKey, loadKeyAsync } = require('../server/lib/keys');
const { argon2, blake2b } = require('../server/lib/argon2');
const crypto = require('crypto');
const { Vault } = require('../server/lib/vault');
const { shq, fingerprint } = require('../server/lib/host');
const { hasBin, tmp, genKey, toPpk } = require('./helpers');

const keygen = hasBin('ssh-keygen');
const putty = keygen && hasBin('puttygen');

test('vault round-trips, uses fresh IVs and detects tampering or the wrong key', () => {
  const dir = tmp('vault-');
  const v = new Vault(dir);
  const a = v.encrypt('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret');
  assert.ok(!a.includes('secret'));
  assert.notEqual(a, v.encrypt('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret'));
  assert.equal(v.decrypt(a), '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret');
  assert.equal(fs.statSync(dir + '/master.key').mode & 0o777, 0o600);
  assert.equal(new Vault(dir).decrypt(a), '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret'); // key persisted on disk
  const raw = Buffer.from(a.slice(3), 'base64'); raw[raw.length - 1] ^= 1;
  assert.throws(() => v.decrypt('v1.' + raw.toString('base64')), /Could not decrypt/);
  assert.throws(() => new Vault(tmp('vault2-'), 'other-secret').decrypt(a), /Could not decrypt/);
  assert.equal(new Vault(tmp('v3-'), 'pw').source, 'env');
  assert.equal(new Vault(tmp('v3-'), 'pw').decrypt(new Vault(tmp('v4-'), 'pw').encrypt('x')), 'x');
});

test('shell quoting neutralises metacharacters', () => {
  assert.equal(shq("a'b; rm -rf /"), `'a'\\''b; rm -rf /'`);
  assert.equal(shq('$(id)'), `'$(id)'`);
});

test('fingerprint format matches OpenSSH', { skip: !keygen }, () => {
  const dir = tmp('fp-');
  const k = genKey(dir, 'k');
  const blob = Buffer.from(k.pub.split(' ')[1], 'base64');
  assert.equal(fingerprint(blob), k.fp);
});

test('loadKey accepts OpenSSH, PEM and passphrase-protected keys', { skip: !keygen }, () => {
  const dir = tmp('keys-');
  const ed = genKey(dir, 'ed', 'ed25519');
  const rsaPem = genKey(dir, 'rsa', 'rsa', { pem: true, bits: 2048 });
  const ecdsa = genKey(dir, 'ec', 'ecdsa', { bits: 256 });
  const protectedKey = genKey(dir, 'pw', 'ed25519', { pass: 's3cret-pass' });
  for (const k of [ed, rsaPem, ecdsa]) assert.equal(loadKey(k.text).fingerprint, k.fp);
  assert.equal(loadKey(protectedKey.text, 's3cret-pass').fingerprint, protectedKey.fp);
  assert.throws(() => loadKey(protectedKey.text), /passphrase-protected/);
  assert.throws(() => loadKey(protectedKey.text, 'wrong'), /Wrong passphrase/);
  // CRLF + BOM (Windows downloads) must still work
  assert.equal(loadKey('﻿' + rsaPem.text.replace(/\n/g, '\r\n')).fingerprint, rsaPem.fp);
});

test('loadKey rejects public keys, garbage and empty input', { skip: !keygen }, () => {
  const k = genKey(tmp('bad-'), 'k');
  assert.throws(() => loadKey(k.pub), /Unrecognised key format/);
  assert.throws(() => loadKey('hello world'), /Unrecognised key format/);
  assert.throws(() => loadKey(''), /No private key/);
  assert.throws(() => loadKey('x'.repeat(70000)), /too large/);
});

test('PuTTY .ppk v2 and v3 convert to the same key (RSA, ECDSA, Ed25519)', { skip: !putty }, () => {
  const dir = tmp('ppk-');
  for (const [type, opts] of [['rsa', { bits: 2048 }], ['ecdsa', { bits: 256 }], ['ed25519', {}]]) {
    const k = genKey(dir, `k_${type}`, type, opts);
    for (const version of [2, 3]) {
      assert.equal(loadKey(toPpk(dir, k, version)).fingerprint, k.fp, `${type} v${version}`);
    }
  }
});

test('PPK: passphrase handling and integrity', { skip: !putty }, () => {
  const dir = tmp('ppk2-');
  const k = genKey(dir, 'k', 'rsa', { bits: 2048 });
  const v2pw = toPpk(dir, k, 2, 'hunter22');
  assert.equal(loadKey(v2pw, 'hunter22').fingerprint, k.fp);
  const ed = genKey(dir, 'e', 'ed25519');
  assert.equal(loadKey(toPpk(dir, ed, 2, 'hunter22'), 'hunter22').fingerprint, ed.fp);
  assert.throws(() => loadKey(v2pw), /passphrase-protected/);
  assert.throws(() => loadKey(v2pw, 'nope'), /Wrong passphrase/);
  const v3 = toPpk(dir, k, 3);
  const tampered = v3.replace(/^Comment: .*/m, 'Comment: evil');
  assert.throws(() => loadKey(tampered), /integrity check/);
});

test('Argon2 matches the RFC 9106 test vector and BLAKE2b matches Node', () => {
  const tag = argon2({ type: 'id', password: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), ad: Buffer.alloc(12, 4), memory: 32, passes: 3, parallelism: 4, tagLength: 32 });
  assert.equal(tag.toString('hex'), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  for (const n of [0, 1, 128, 129, 1000]) {
    const d = crypto.randomBytes(n);
    assert.ok(blake2b(d, 64).equals(crypto.createHash('blake2b512').update(d).digest()), `blake2b ${n}`);
  }
});

test('passphrase-protected PPK v3 (PuTTYgen default: Argon2id) opens with the right passphrase only', { skip: !putty }, async () => {
  const dir = tmp('ppk3-');
  for (const [type, opts] of [['rsa', { bits: 2048 }], ['ecdsa', { bits: 256 }], ['ed25519', {}]]) {
    const k = genKey(dir, `k_${type}`, type, opts);
    const ppk = toPpk(dir, k, 3, 'correct horse');
    assert.match(ppk, /Key-Derivation: Argon2id/);
    assert.equal((await loadKeyAsync(ppk, 'correct horse')).fingerprint, k.fp, type);
    await assert.rejects(loadKeyAsync(ppk, 'wrong horse'), /Wrong passphrase/);
    await assert.rejects(loadKeyAsync(ppk), /passphrase-protected/);
    const tampered = ppk.replace(/^Comment: .*/m, 'Comment: evil');
    await assert.rejects(loadKeyAsync(tampered, 'correct horse'), /Wrong passphrase|damaged/);
  }
});

test('hostile Argon2 parameters inside a .ppk are refused before any work happens', { skip: !putty }, async () => {
  const dir = tmp('ppk3b-');
  const ppk = toPpk(dir, genKey(dir, 'k', 'ed25519'), 3, 'pw-pw-pw');
  for (const [from, to] of [[/Argon2-Memory: \d+/, 'Argon2-Memory: 4000000'], [/Argon2-Passes: \d+/, 'Argon2-Passes: 100000'], [/Argon2-Parallelism: \d+/, 'Argon2-Parallelism: 500']]) {
    const t0 = Date.now();
    await assert.rejects(loadKeyAsync(ppk.replace(from, to), 'pw-pw-pw'), /expensive Argon2|integrity|Wrong passphrase/);
    assert.ok(Date.now() - t0 < 1500, 'must be rejected immediately');
  }
});
