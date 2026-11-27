'use strict';
/**
 * Pure-JavaScript Argon2 (RFC 9106; types d / i / id, version 0x13) — only needed to open
 * passphrase-protected PuTTY .ppk v3 keys, because Node 22 has no built-in Argon2.
 *
 * The memory-hard block function uses 32-bit pair arithmetic (fast); the handful of BLAKE2b
 * calls use BigInt (they are negligible). Heavy work runs in a worker thread (argon2Async) so
 * the panel's event loop is never blocked.
 */
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ---------------------------------------------------------------- BLAKE2b (variable output length)
const M64 = (1n << 64n) - 1n;
const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;

function blake2b(input, outLen) {
  const h = IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  const data = Buffer.from(input);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const chunk = Buffer.alloc(128);
    data.copy(chunk, 0, b * 128, Math.min(data.length, (b + 1) * 128));
    const last = b === blocks - 1;
    const t = BigInt(last ? data.length : (b + 1) * 128);
    const m = Array.from({ length: 16 }, (_, i) => chunk.readBigUInt64LE(i * 8));
    const v = [...h, ...IV];
    v[12] ^= t & M64; // high counter word stays 0 for inputs < 2^64
    if (last) v[14] ^= M64;
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      const G = (a, bb, c, d, x, y) => {
        v[a] = (v[a] + v[bb] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32);
        v[c] = (v[c] + v[d]) & M64; v[bb] = rotr(v[bb] ^ v[c], 24);
        v[a] = (v[a] + v[bb] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16);
        v[c] = (v[c] + v[d]) & M64; v[bb] = rotr(v[bb] ^ v[c], 63);
      };
      G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]);
      G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]);
      G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = Buffer.alloc(64);
  h.forEach((x, i) => out.writeBigUInt64LE(x, i * 8));
  return out.subarray(0, outLen);
}

const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** Argon2's variable-length hash H'. */
function hPrime(outLen, x) {
  if (outLen <= 64) return blake2b(Buffer.concat([le32(outLen), x]), outLen);
  const r = Math.ceil(outLen / 32) - 2;
  const parts = [];
  let v = blake2b(Buffer.concat([le32(outLen), x]), 64);
  parts.push(v.subarray(0, 32));
  for (let i = 2; i <= r; i++) { v = blake2b(v, 64); parts.push(v.subarray(0, 32)); }
  parts.push(blake2b(v, outLen - 32 * r));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- block function (32-bit pairs)
// A block is 128 u64 words stored as Uint32Array(256): word k = (lo = w[2k], hi = w[2k+1]).
let mh = 0; let ml = 0; // result of mul32 (hi, lo)

function mul32(x, y) {
  const x0 = x & 0xffff; const x1 = x >>> 16; const y0 = y & 0xffff; const y1 = y >>> 16;
  const p00 = x0 * y0; const mid = x0 * y1 + x1 * y0; const p11 = x1 * y1;
  const t = p00 + (mid % 65536) * 65536;
  ml = t >>> 0;
  mh = (p11 + Math.floor(mid / 65536) + Math.floor(t / 4294967296)) >>> 0;
}

/** a = a + b + 2 * lo32(a) * lo32(b), on words held at indices ia, ib of v. */
function blamka(v, ia, ib) {
  const alo = v[2 * ia]; const ahi = v[2 * ia + 1]; const blo = v[2 * ib]; const bhi = v[2 * ib + 1];
  mul32(alo, blo);
  const plo = (ml << 1) >>> 0; const phi = ((mh << 1) | (ml >>> 31)) >>> 0;
  let lo = alo + blo + plo;
  const carry = Math.floor(lo / 4294967296);
  lo >>>= 0;
  v[2 * ia] = lo;
  v[2 * ia + 1] = (ahi + bhi + phi + carry) >>> 0;
}

function xorRot(v, id, ia, rot) { // v[id] = rotr64(v[id] ^ v[ia], rot)
  const lo = v[2 * id] ^ v[2 * ia]; const hi = v[2 * id + 1] ^ v[2 * ia + 1];
  if (rot === 32) { v[2 * id] = hi; v[2 * id + 1] = lo; } else if (rot === 24) {
    v[2 * id] = ((lo >>> 24) | (hi << 8)) >>> 0; v[2 * id + 1] = ((hi >>> 24) | (lo << 8)) >>> 0;
  } else if (rot === 16) {
    v[2 * id] = ((lo >>> 16) | (hi << 16)) >>> 0; v[2 * id + 1] = ((hi >>> 16) | (lo << 16)) >>> 0;
  } else { // 63 == rotl 1
    v[2 * id] = ((lo << 1) | (hi >>> 31)) >>> 0; v[2 * id + 1] = ((hi << 1) | (lo >>> 31)) >>> 0;
  }
}

function addMod(v, ic, id) { // v[ic] += v[id]
  const lo = v[2 * ic] + v[2 * id];
  v[2 * ic + 1] = (v[2 * ic + 1] + v[2 * id + 1] + Math.floor(lo / 4294967296)) >>> 0;
  v[2 * ic] = lo >>> 0;
}

function gb(v, a, b, c, d) {
  blamka(v, a, b); xorRot(v, d, a, 32);
  blamka(v, c, d); xorRot(v, b, c, 24);
  blamka(v, a, b); xorRot(v, d, a, 16);
  blamka(v, c, d); xorRot(v, b, c, 63);
}

const idx = new Int32Array(16);
function perm(w, i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15) {
  // operate on a 16-word "register" addressed through word indices into w
  const a = idx; a[0] = i0; a[1] = i1; a[2] = i2; a[3] = i3; a[4] = i4; a[5] = i5; a[6] = i6; a[7] = i7;
  a[8] = i8; a[9] = i9; a[10] = i10; a[11] = i11; a[12] = i12; a[13] = i13; a[14] = i14; a[15] = i15;
  gb(w, a[0], a[4], a[8], a[12]); gb(w, a[1], a[5], a[9], a[13]); gb(w, a[2], a[6], a[10], a[14]); gb(w, a[3], a[7], a[11], a[15]);
  gb(w, a[0], a[5], a[10], a[15]); gb(w, a[1], a[6], a[11], a[12]); gb(w, a[2], a[7], a[8], a[13]); gb(w, a[3], a[4], a[9], a[14]);
}

const R = new Uint32Array(256); const Q = new Uint32Array(256);
/** out = G(x, y) (^ out when xorInto). */
function compress(out, x, y, xorInto) {
  for (let i = 0; i < 256; i++) { R[i] = x[i] ^ y[i]; Q[i] = R[i]; }
  for (let i = 0; i < 8; i++) { const b = 16 * i; perm(Q, b, b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7, b + 8, b + 9, b + 10, b + 11, b + 12, b + 13, b + 14, b + 15); }
  for (let i = 0; i < 8; i++) {
    const b = 2 * i;
    perm(Q, b, b + 1, b + 16, b + 17, b + 32, b + 33, b + 48, b + 49, b + 64, b + 65, b + 80, b + 81, b + 96, b + 97, b + 112, b + 113);
  }
  if (xorInto) for (let i = 0; i < 256; i++) out[i] ^= Q[i] ^ R[i]; else for (let i = 0; i < 256; i++) out[i] = Q[i] ^ R[i];
}

const toBlock = (buf) => { const b = new Uint32Array(256); for (let i = 0; i < 256; i++) b[i] = buf.readUInt32LE(i * 4); return b; };
const fromBlock = (b) => { const buf = Buffer.alloc(1024); for (let i = 0; i < 256; i++) buf.writeUInt32LE(b[i], i * 4); return buf; };

// ---------------------------------------------------------------- Argon2
const TYPES = { d: 0, i: 1, id: 2 };

function argon2({ type = 'id', password, salt, secret = Buffer.alloc(0), ad = Buffer.alloc(0), memory, passes, parallelism, tagLength }) {
  const y = TYPES[type];
  if (y === undefined) throw new Error(`Unknown Argon2 type ${type}`);
  const p = parallelism; const t = passes; const T = tagLength;
  const m = Math.max(memory, 8 * p);
  const mPrime = 4 * p * Math.floor(m / (4 * p));
  const q = mPrime / p; const segLen = q / 4;
  const pw = Buffer.from(password); const sl = Buffer.from(salt);

  const H0 = blake2b(Buffer.concat([
    le32(p), le32(T), le32(m), le32(t), le32(0x13), le32(y),
    le32(pw.length), pw, le32(sl.length), sl, le32(secret.length), Buffer.from(secret), le32(ad.length), Buffer.from(ad),
  ]), 64);

  const mem = new Array(p); // mem[lane][col] -> Uint32Array(256)
  for (let l = 0; l < p; l++) {
    mem[l] = new Array(q);
    mem[l][0] = toBlock(hPrime(1024, Buffer.concat([H0, le32(0), le32(l)])));
    mem[l][1] = toBlock(hPrime(1024, Buffer.concat([H0, le32(1), le32(l)])));
  }

  const zero = new Uint32Array(256);
  const input = new Uint32Array(256); const addr = new Uint32Array(256); const tmp = new Uint32Array(256);

  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      for (let lane = 0; lane < p; lane++) {
        const dataIndependent = y === 1 || (y === 2 && pass === 0 && slice < 2);
        let counter = 0;
        if (dataIndependent) {
          input.fill(0);
          input[0] = pass; input[2] = lane; input[4] = slice; input[6] = mPrime; input[8] = t; input[10] = y;
        }
        const nextAddr = () => {
          counter += 1; input[12] = counter;
          compress(tmp, zero, input, false);
          compress(addr, zero, tmp, false);
        };
        let start = 0;
        if (pass === 0 && slice === 0) {
          start = 2;
          if (dataIndependent) nextAddr();
        }
        for (let i = start; i < segLen; i++) {
          const cur = slice * segLen + i;
          const prev = mem[lane][cur === 0 ? q - 1 : cur - 1];
          let j1; let j2;
          if (dataIndependent) {
            if (i % 128 === 0) nextAddr();
            j1 = addr[2 * (i % 128)]; j2 = addr[2 * (i % 128) + 1];
          } else { j1 = prev[0]; j2 = prev[1]; }
          const refLane = (pass === 0 && slice === 0) ? lane : j2 % p;
          const same = refLane === lane;
          let area;
          if (pass === 0) {
            if (slice === 0) area = i - 1;
            else area = same ? slice * segLen + i - 1 : slice * segLen + (i === 0 ? -1 : 0);
          } else area = same ? q - segLen + i - 1 : q - segLen + (i === 0 ? -1 : 0);
          mul32(j1, j1);                    // (j1^2) >> 32
          const rel = mh;
          mul32(area, rel);                 // (area * rel) >> 32
          const pos = area - 1 - mh;
          const startPos = (pass !== 0 && slice !== 3) ? (slice + 1) * segLen : 0;
          const refIdx = (startPos + pos) % q;
          if (!mem[lane][cur]) mem[lane][cur] = new Uint32Array(256);
          compress(mem[lane][cur], prev, mem[refLane][refIdx], pass > 0);
        }
      }
    }
  }

  const C = new Uint32Array(256);
  for (let l = 0; l < p; l++) for (let i = 0; i < 256; i++) C[i] ^= mem[l][q - 1][i];
  return hPrime(T, fromBlock(C));
}

// ---------------------------------------------------------------- worker wrapper
function argon2Async(params) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { __argon2: true, ...params } });
    w.once('message', (m) => resolve(Buffer.from(m)));
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error('Argon2 worker failed')); });
  });
}

if (!isMainThread && workerData && workerData.__argon2) {
  parentPort.postMessage(argon2(workerData));
}

module.exports = { argon2, argon2Async, blake2b };
