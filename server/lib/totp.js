'use strict';
/** TOTP (RFC 6238, SHA-1, 6 digits, 30 s) for authenticator apps, with no dependencies. */
const crypto = require('crypto');

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0; let value = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/[\s=-]/g, '')) {
    const i = ALPHA.indexOf(c); if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32(crypto.randomBytes(20));

function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const step = (now = Date.now()) => Math.floor(now / 30000);
const code = (secret, now = Date.now()) => hotp(secret, step(now));

/** Returns the time step that matched (so the caller can refuse to accept it twice), or null. Allows one step of clock drift. */
function verify(secret, token, { now = Date.now(), after = -1 } = {}) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const s = step(now);
  for (const d of [0, -1, 1]) {
    const cand = s + d;
    if (cand <= after) continue;
    const a = Buffer.from(hotp(secret, cand)); const b = Buffer.from(t);
    if (crypto.timingSafeEqual(a, b)) return cand;
  }
  return null;
}

const otpauthUrl = (label, secret, issuer = 'Server Panel') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { generateSecret, code, verify, otpauthUrl, base32, unbase32, step };
