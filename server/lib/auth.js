'use strict';
const crypto = require('crypto');
const totp = require('./totp');

const MIN_PASSWORD = 10;
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;
const SCRYPT = { N: 16384, r: 8, p: 1 };

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (pw.length > 256) return 'Password too long';
  return null;
}

// Hash used to burn equivalent CPU when the username does not exist.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

class Auth {
  constructor(store, { sessionHours = 12 } = {}) {
    this.store = store;
    this.ttl = sessionHours * 3600 * 1000;
    this.failures = new Map(); // ip -> {count, until}
    this.setupToken = null;
  }

  get users() { return this.store.data.users; }
  needsSetup() { return this.users.length === 0; }

  ensureSetupToken() {
    if (this.needsSetup() && !this.setupToken) this.setupToken = crypto.randomBytes(12).toString('hex');
    return this.setupToken;
  }

  publicUser(u) { return { id: u.id, username: u.username, role: u.role, created: u.created, totp: !!(u.totp && u.totp.enabled) }; }

  createUser(username, password, role = 'viewer') {
    if (!USERNAME_RE.test(username || '')) throw httpError(400, 'Username must be 2-32 chars: letters, digits, . _ -');
    const pwErr = validatePassword(password);
    if (pwErr) throw httpError(400, pwErr);
    if (!['admin', 'viewer'].includes(role)) throw httpError(400, 'Invalid role');
    if (this.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw httpError(409, 'Username already exists');
    const user = { id: crypto.randomUUID(), username, role, hash: hashPassword(password), created: new Date().toISOString() };
    this.users.push(user);
    this.store.save();
    return user;
  }

  revokeSessions(userId) {
    for (const [k, s] of Object.entries(this.store.data.sessions)) {
      if (s.userId === userId) delete this.store.data.sessions[k];
    }
  }

  setPassword(id, password) {
    const err = validatePassword(password);
    if (err) throw httpError(400, err);
    const u = this.users.find((x) => x.id === id);
    if (!u) throw httpError(404, 'User not found');
    u.hash = hashPassword(password);
    this.revokeSessions(id);
    this.store.save();
  }

  removeUser(id) {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw httpError(404, 'User not found');
    if (u.role === 'admin' && this.users.filter((x) => x.role === 'admin').length === 1) {
      throw httpError(400, 'Cannot remove the last admin');
    }
    this.store.data.users = this.users.filter((x) => x.id !== id);
    this.revokeSessions(id);
    this.store.save();
  }

  checkThrottle(ip) {
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) {
      throw httpError(429, `Too many failed attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s`);
    }
  }

  /** Count a failed attempt; from the 5th consecutive failure the IP is locked out for 1..15 minutes. */
  recordFailure(ip) {
    const f = this.failures.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= 5) f.until = Date.now() + 60_000 * Math.min(f.count - 4, 15);
    this.failures.set(ip, f);
  }

  /** Password first; if the account has two-step verification the code (or a recovery code) is required too. */
  login(ip, username, password, code) {
    this.checkThrottle(ip);
    const u = this.users.find((x) => x.username.toLowerCase() === String(username || '').toLowerCase());
    const ok = verifyPassword(String(password || ''), u ? u.hash : DUMMY_HASH) && !!u;
    if (!ok) {
      this.recordFailure(ip);
      throw httpError(401, 'Invalid username or password');
    }
    if (u.totp && u.totp.enabled) {
      if (!code) return { needs2fa: true };
      if (!this.verifySecondFactor(u, code)) {
        this.recordFailure(ip);
        throw Object.assign(httpError(401, 'That code is not valid. Wait for a new code from your authenticator app, or use a recovery code.'), { needs2fa: true });
      }
    }
    this.failures.delete(ip);
    return { user: u, token: this.createSession(u.id) };
  }

  // ------------------------------------------------------------------ two-step verification (TOTP)

  need() { if (!this.vault) throw new Error('vault not attached'); return this.vault; }

  /** Start enrolment: a new secret is stored (encrypted) as pending until a valid code proves the app is set up. */
  beginTotp(u) {
    if (u.totp && u.totp.enabled) throw httpError(409, 'Two-step verification is already on. Turn it off first to set it up again.');
    const secret = totp.generateSecret();
    u.totp = { enabled: false, pendingEnc: this.need().encrypt(secret) };
    this.store.save();
    return { secret, url: totp.otpauthUrl(u.username, secret) };
  }

  enableTotp(u, code) {
    if (!u.totp || !u.totp.pendingEnc) throw httpError(400, 'Start the setup first');
    const secret = this.need().decrypt(u.totp.pendingEnc);
    const stepOk = totp.verify(secret, code);
    if (stepOk === null) throw httpError(400, 'That code is not right. Check the time on your phone and try the current code.');
    const recovery = Array.from({ length: 10 }, () => { const r = crypto.randomBytes(5).toString('hex'); return `${r.slice(0, 5)}-${r.slice(5)}`; });
    u.totp = { enabled: true, secretEnc: u.totp.pendingEnc, lastStep: stepOk, recovery: recovery.map((c) => sha(c)) };
    this.store.save();
    return recovery;
  }

  /** A time-based code (each code works once) or a recovery code (consumed). */
  verifySecondFactor(u, code) {
    if (!u.totp || !u.totp.enabled) return true;
    const c = String(code || '').trim().toLowerCase();
    if (/^\d{3}\s?\d{3}$/.test(c)) {
      const s = totp.verify(this.need().decrypt(u.totp.secretEnc), c, { after: u.totp.lastStep ?? -1 });
      if (s === null) return false;
      u.totp.lastStep = s; this.store.save();
      return true;
    }
    const h = sha(c);
    const i = u.totp.recovery.findIndex((x) => safeEq(x, h));
    if (i < 0) return false;
    u.totp.recovery.splice(i, 1); this.store.save();
    return true;
  }

  disableTotp(u) { u.totp = undefined; delete u.totp; this.store.save(); }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.store.data.sessions[sha(token)] = { userId, expires: Date.now() + this.ttl };
    this.prune();
    this.store.save();
    return token;
  }

  prune() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.store.data.sessions)) {
      if (s.expires < now) delete this.store.data.sessions[k];
    }
  }

  userFromToken(token) {
    if (!token) return null;
    const s = this.store.data.sessions[sha(token)];
    if (!s || s.expires < Date.now()) return null;
    return this.users.find((u) => u.id === s.userId) || null;
  }

  destroySession(token) {
    if (token && this.store.data.sessions[sha(token)]) {
      delete this.store.data.sessions[sha(token)];
      this.store.save();
    }
  }
}

module.exports = { Auth, hashPassword, verifyPassword, validatePassword, httpError, safeEq, MIN_PASSWORD };
