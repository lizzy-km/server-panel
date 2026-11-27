'use strict';
/**
 * Private-key loading for SSH: PEM (PKCS#1/PKCS#8/EC) and OpenSSH keys (via ssh2), and PuTTY .ppk
 * v2 (with or without passphrase) and unencrypted v3, converted here. Passphrase-protected PPK v3
 * needs Argon2, which Node 22 does not provide, so it is rejected with instructions.
 */
const crypto = require('crypto');
const { utils } = require('ssh2');
const { httpError } = require('./auth');

const PPK3_ENCRYPTED_HELP = 'PPK v3 keys protected by a passphrase are not supported. In PuTTYgen use Conversions → Export OpenSSH key (or save the key as PPK v2 / without a passphrase), then upload that file.';

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
    const m = lines[i].match(/^([A-Za-z-]+):\s?(.*)$/);
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

function ppkToPem(text, passphrase) {
  let k;
  try { k = parsePpkText(text); } catch { throw httpError(400, 'This does not look like a valid PuTTY .ppk file'); }
  if (!k.pub || !k.priv) throw httpError(400, 'Corrupt PPK file');
  const encryption = k.fields.Encryption || 'none';
  if (k.version >= 3 && encryption !== 'none') throw httpError(400, PPK3_ENCRYPTED_HELP);
  if (k.version === 2 && !['none', 'aes256-cbc'].includes(encryption)) throw httpError(400, `Unsupported PPK encryption: ${encryption}`);
  if (encryption !== 'none' && !passphrase) throw httpError(400, 'This key is passphrase-protected — enter the passphrase');

  const sha1 = (...parts) => crypto.createHash('sha1').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
  const counter = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const pw = passphrase || '';
  if (encryption === 'aes256-cbc') {
    // PPK v2: key = SHA1(0||pass) || SHA1(1||pass) (first 32 bytes), IV = 0
    const key = Buffer.concat([sha1(counter(0), pw), sha1(counter(1), pw)]).subarray(0, 32);
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16));
      d.setAutoPadding(false);
      k.priv = Buffer.concat([d.update(k.priv), d.final()]);
    } catch { throw httpError(400, 'Wrong passphrase, or the key file is damaged'); }
  }

  // integrity: v3 = HMAC-SHA256 (empty key when unencrypted); v2 = HMAC-SHA1 keyed by SHA1("putty-private-key-file-mac-key"+pass)
  const macData = Buffer.concat([k.algo, encryption, k.fields.Comment || ''].map((x) => lenPrefixed(Buffer.from(x))).concat([lenPrefixed(k.pub), lenPrefixed(k.priv)]));
  const mac = k.version >= 3
    ? crypto.createHmac('sha256', Buffer.alloc(0)).update(macData).digest('hex')
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
function loadKey(input, passphrase) {
  let text = String(input || '').replace(/^﻿/, '').trim();
  if (!text) throw httpError(400, 'No private key provided');
  if (text.length > 64 * 1024) throw httpError(400, 'Key file is too large');
  if (/^PuTTY-User-Key-File-[23]:/.test(text)) { text = ppkToPem(text, passphrase); passphrase = undefined; }
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

module.exports = { loadKey, ppkToPem, fingerprintOf };
