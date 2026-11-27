'use strict';
/**
 * Private-key loading for SSH: PEM (PKCS#1/PKCS#8/EC) and OpenSSH keys (via ssh2), and PuTTY .ppk
 * v2 and v3 (with or without passphrase), converted here. Passphrase-protected v3 uses Argon2,
 * which Node 22 lacks, so ./argon2.js provides a pure-JS implementation (run via loadKeyAsync).
 */
const crypto = require('crypto');
const { utils } = require('ssh2');
const { httpError } = require('./auth');
const { argon2Async } = require('./argon2');


function fingerprintOf(blob) {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

// ---- tiny SSH wire-format reader ----
function reader(buf) {
  let off = 0;
  const need = (n) => { if (off + n > buf.length) throw new Error('truncated'); };
  return {
    u32() { need(4); const v = buf.readUInt32BE(off); off += 4; return v; },
    string() { const n = this.u32(); need(n); const v = buf.subarray(off, off + n); off += n; return v; },
    mpint() { const b = this.string(); let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); },
    done() { return off === buf.length; },
  };
}
const lenPrefixed = (b) => { const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
const toBig = (b) => BigInt('0x' + (b.toString('hex') || '0'));
const b64u = (b) => Buffer.from(b).toString('base64url');
const bigToBuf = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
const pad = (b, len) => (b.length >= len ? b : Buffer.concat([Buffer.alloc(len - b.length), b]));

function parsePpkText(text) {
  const lines = text.split(/\r?\n/);
  const hdr = lines[0].match(/^PuTTY-User-Key-File-(\d+):\s*(\S+)/);
  if (!hdr) throw new Error('not a PPK file');
  const fields = {};
  let i = 1;
  const blocks = {};
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9-]+):\s?(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (key === 'Public-Lines' || key === 'Private-Lines') {
      const n = parseInt(m[2], 10);
      if (!(n > 0 && n < 200)) throw new Error('bad PPK');
      blocks[key] = Buffer.from(lines.slice(i + 1, i + 1 + n).join(''), 'base64');
      i += n;
    } else fields[key] = m[2];
  }
  return { version: Number(hdr[1]), algo: hdr[2], fields, pub: blocks['Public-Lines'], priv: blocks['Private-Lines'] };
}

/** ssh2 cannot read PKCS#8 Ed25519, so emit an unencrypted openssh-key-v1 file instead. */
function ed25519ToOpenSsh(pub, seed, comment) {
  const str = (b) => lenPrefixed(Buffer.isBuffer(b) ? b : Buffer.from(b));
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const pubBlob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  const padLen = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(pubBlob), str(priv)]);
  const lines = body.toString('base64').match(/.{1,70}/g).join('\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

const CURVES = { 'nistp256': ['P-256', 32], 'nistp384': ['P-384', 48], 'nistp521': ['P-521', 66] };

function ppkToPem(text, passphrase, derived) {
  let k;
  try { k = parsePpkText(text); } catch { throw httpError(400, 'This does not look like a valid PuTTY .ppk file'); }
  if (!k.pub || !k.priv) throw httpError(400, 'Corrupt PPK file');
  const encryption = k.fields.Encryption || 'none';
  if (k.version === 2 && !['none', 'aes256-cbc'].includes(encryption)) throw httpError(400, `Unsupported PPK encryption: ${encryption}`);
  if (k.version >= 3 && !['none', 'aes256-cbc'].includes(encryption)) throw httpError(400, `Unsupported PPK encryption: ${encryption}`);
  if (encryption !== 'none' && !passphrase) throw httpError(400, 'This key is passphrase-protected — enter the passphrase');
  if (k.version >= 3 && encryption !== 'none' && !derived) throw httpError(500, 'Internal error: PPK v3 key derivation was not performed');

  const sha1 = (...parts) => crypto.createHash('sha1').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
  const counter = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const pw = passphrase || '';
  let macKey = Buffer.alloc(0);
  if (encryption === 'aes256-cbc') {
    let cipherKey; let iv;
    if (k.version >= 3) {
      // PPK v3: Argon2 output (80 bytes) = AES key (32) | IV (16) | MAC key (32)
      cipherKey = derived.subarray(0, 32); iv = derived.subarray(32, 48); macKey = derived.subarray(48, 80);
    } else {
      // PPK v2: key = SHA1(0||pass) || SHA1(1||pass) (first 32 bytes), IV = 0
      cipherKey = Buffer.concat([sha1(counter(0), pw), sha1(counter(1), pw)]).subarray(0, 32); iv = Buffer.alloc(16);
    }
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
      d.setAutoPadding(false);
      k.priv = Buffer.concat([d.update(k.priv), d.final()]);
    } catch { throw httpError(400, 'Wrong passphrase, or the key file is damaged'); }
  }

  // integrity: v3 = HMAC-SHA256 (empty key when unencrypted); v2 = HMAC-SHA1 keyed by SHA1("putty-private-key-file-mac-key"+pass)
  const macData = Buffer.concat([k.algo, encryption, k.fields.Comment || ''].map((x) => lenPrefixed(Buffer.from(x))).concat([lenPrefixed(k.pub), lenPrefixed(k.priv)]));
  const mac = k.version >= 3
    ? crypto.createHmac('sha256', macKey).update(macData).digest('hex')
    : crypto.createHmac('sha1', sha1('putty-private-key-file-mac-key', pw)).update(macData).digest('hex');
  if (k.fields['Private-MAC'] && mac !== k.fields['Private-MAC'].toLowerCase()) {
    throw httpError(400, encryption === 'none' ? 'PPK file failed its integrity check (corrupt or modified)' : 'Wrong passphrase, or the key file is damaged');
  }

  try {
    const pub = reader(k.pub); const priv = reader(k.priv);
    pub.string(); // algorithm name inside the blob
    if (k.algo === 'ssh-rsa') {
      const e = pub.mpint(); const n = pub.mpint();
      const d = priv.mpint(); const p = priv.mpint(); const q = priv.mpint(); const qi = priv.mpint();
      const dB = toBig(d);
      const jwk = { kty: 'RSA', n: b64u(n), e: b64u(e), d: b64u(d), p: b64u(p), q: b64u(q), qi: b64u(qi), dp: b64u(bigToBuf(dB % (toBig(p) - 1n))), dq: b64u(bigToBuf(dB % (toBig(q) - 1n))) };
      return crypto.createPrivateKey({ key: jwk, format: 'jwk' }).export({ type: 'pkcs1', format: 'pem' });
    }
    if (k.algo === 'ssh-ed25519') {
      const x = pub.string();
      let seed = priv.string();
      if (seed.length > 32) seed = seed.subarray(seed.length - 32);
      // PuTTY stores the secret scalar as an mpint; accept either byte order and keep the one matching the public key
      for (const cand of [pad(seed, 32), pad(Buffer.from(seed).reverse(), 32)]) {
        try {
          const key = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64u(cand), x: b64u(x) }, format: 'jwk' });
          const derived = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
          if (derived === b64u(x)) return ed25519ToOpenSsh(x, cand, k.fields.Comment || '');
        } catch { /* try next */ }
      }
      throw new Error('ed25519 key does not match its public half');
    }
    const curve = /^ecdsa-sha2-(nistp\d+)$/.exec(k.algo);
    if (curve && CURVES[curve[1]]) {
      const [crv, size] = CURVES[curve[1]];
      pub.string();
      const Q = pub.string();
      const d = priv.mpint();
      const jwk = { kty: 'EC', crv, d: b64u(pad(d, size)), x: b64u(Q.subarray(1, 1 + size)), y: b64u(Q.subarray(1 + size)) };
      return crypto.createPrivateKey({ key: jwk, format: 'jwk' }).export({ type: 'sec1', format: 'pem' });
    }
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, `Could not convert this PPK key: ${e.message}`);
  }
  throw httpError(400, `Unsupported PPK key type: ${k.algo}`);
}

/**
 * Validate and normalise a user-supplied key.
 * @returns {{privateKey: string, passphrase?: string, type: string, comment: string, fingerprint: string}}
 */
function loadKey(input, passphrase, derived) {
  let text = String(input || '').replace(/^﻿/, '').trim();
  if (!text) throw httpError(400, 'No private key provided');
  if (text.length > 64 * 1024) throw httpError(400, 'Key file is too large');
  if (/^PuTTY-User-Key-File-[23]:/.test(text)) { text = ppkToPem(text, passphrase, derived); passphrase = undefined; }
  else if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    throw httpError(400, 'Unrecognised key format. Upload an AWS .pem, an OpenSSH private key, or a PuTTY .ppk file (not a .pub public key).');
  }
  let parsed = utils.parseKey(text, passphrase || undefined);
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (parsed instanceof Error) {
    const m = parsed.message;
    if (/no passphrase given|passphrase/i.test(m) && !passphrase) throw httpError(400, 'This key is passphrase-protected — enter the passphrase');
    if (/bad passphrase|decrypt|Malformed|MAC|integrity/i.test(m)) throw httpError(400, 'Wrong passphrase, or the key file is damaged');
    throw httpError(400, `Could not read key: ${m}`);
  }
  if (typeof parsed.isPrivateKey === 'function' && !parsed.isPrivateKey()) throw httpError(400, 'That is a public key — upload the private key (.pem / .ppk)');
  return {
    privateKey: text,
    passphrase: passphrase || undefined,
    type: parsed.type,
    comment: parsed.comment || '',
    fingerprint: fingerprintOf(parsed.getPublicSSH()),
  };
}

// Work limits for the (attacker-controllable) Argon2 parameters inside a .ppk file.
// PuTTYgen's default is 8192 KiB x 13 passes x 1 lane (~2 s here).
const ARGON_LIMITS = { memory: 262144, work: 2_000_000, parallelism: 16 };

function ppkV3Kdf(text, passphrase) {
  let k;
  try { k = parsePpkText(text); } catch { throw httpError(400, 'This does not look like a valid PuTTY .ppk file'); }
  const f = k.fields;
  const type = { argon2id: 'id', argon2i: 'i', argon2d: 'd' }[String(f['Key-Derivation'] || '').toLowerCase()];
  const memory = Number(f['Argon2-Memory']); const passes = Number(f['Argon2-Passes']); const parallelism = Number(f['Argon2-Parallelism']);
  if (!type || !/^[0-9a-f]+$/i.test(f['Argon2-Salt'] || '') || !(memory >= 8) || !(passes >= 1) || !(parallelism >= 1)) throw httpError(400, 'Corrupt PPK v3 key-derivation header');
  if (memory > ARGON_LIMITS.memory || memory * passes > ARGON_LIMITS.work || parallelism > ARGON_LIMITS.parallelism) {
    throw httpError(400, 'This key uses unusually expensive Argon2 settings; re-save it with PuTTYgen defaults or export an OpenSSH key');
  }
  return { type, password: Buffer.from(passphrase), salt: Buffer.from(f['Argon2-Salt'], 'hex'), memory, passes, parallelism, tagLength: 80 };
}

/** Like loadKey, but can also open passphrase-protected PPK v3 (Argon2 runs in a worker thread, ~2 s). */
async function loadKeyAsync(input, passphrase) {
  const text = String(input || '').replace(/^\uFEFF/, '').trim();
  if (/^PuTTY-User-Key-File-3:/.test(text) && passphrase && /^Encryption:\s*(?!none)\S+/m.test(text)) {
    const derived = await argon2Async(ppkV3Kdf(text, passphrase));
    return loadKey(text, passphrase, derived);
  }
  return loadKey(input, passphrase);
}

module.exports = { loadKey, loadKeyAsync, ppkToPem, fingerprintOf };
