'use strict';
const crypto = require('crypto');
const { httpError } = require('./auth');
const { LocalHost, SshHost, probeHostKey } = require('./host');
const { loadKey, loadKeyAsync } = require('./keys');
const { Sampler, systemInfo } = require('./sys');
const { FileManager, LogReader } = require('./ops');
const { fetchInstanceMetadata } = require('./aws');

const HOST_RE = /^(?!-)[A-Za-z0-9.:_-]{1,253}$/;           // DNS name, IPv4 or IPv6 literal; never starts with "-"
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

function clean(input, { partial = false } = {}) {
  const out = {};
  const need = (k) => { if (!partial || input[k] !== undefined) return true; return false; };
  if (need('name')) {
    const name = String(input.name || '').trim();
    if (!name || name.length > 48) throw httpError(400, 'Name is required (max 48 characters)');
    out.name = name;
  }
  if (need('host')) {
    const host = String(input.host || '').trim();
    if (!HOST_RE.test(host)) throw httpError(400, 'Enter a valid host name or IP address');
    out.host = host;
  }
  if (need('port')) {
    const port = Number(input.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'Port must be 1-65535');
    out.port = port;
  }
  if (need('username')) {
    const username = String(input.username || '').trim();
    if (!USER_RE.test(username)) throw httpError(400, 'Invalid SSH username');
    out.username = username;
  }
  if (input.fileRoot !== undefined || !partial) {
    const root = String(input.fileRoot || '/').trim();
    if (!root.startsWith('/') || root.includes('\0') || root.length > 512) throw httpError(400, 'File manager root must be an absolute path');
    out.fileRoot = root;
  }
  if (input.useSudo !== undefined) out.useSudo = !!input.useSudo;
  return out;
}

class ServerRegistry {
  constructor({ store, vault, config }) {
    this.store = store;
    this.vault = vault;
    this.config = config;
    this.entries = new Map();
  }

  get records() { return this.store.data.servers; }

  // ---------- public views ----------

  publicRecord(rec) {
    const e = this.entries.get(rec.id);
    const d = e ? e.host.describe() : { status: 'idle', lastError: null };
    return {
      id: rec.id, kind: 'ssh', name: rec.name, host: rec.host, port: rec.port, username: rec.username, fileRoot: rec.fileRoot,
      hostKey: rec.hostKey, keyType: rec.keyType, keyFingerprint: rec.keyFingerprint, keyComment: rec.keyComment,
      useSudo: rec.useSudo !== false, created: rec.created, status: d.status, lastError: d.lastError,
    };
  }

  list() {
    const list = this.records.map((r) => this.publicRecord(r));
    if (this.config.enableLocal) list.unshift({ id: 'local', kind: 'local', name: 'This panel host', host: 'localhost', username: '', fileRoot: this.config.filesRoot, status: 'local' });
    return list;
  }

  // ---------- live entries ----------

  entry(id) {
    if (!id) throw httpError(400, 'No server selected');
    if (this.entries.has(id)) return this.entries.get(id);
    let host; let fileRoot;
    if (id === 'local') {
      if (!this.config.enableLocal) throw httpError(404, 'Managing the panel host itself is disabled (set PANEL_ENABLE_LOCAL=true)');
      host = new LocalHost(); fileRoot = this.config.filesRoot;
    } else {
      const rec = this.records.find((r) => r.id === id);
      if (!rec) throw httpError(404, 'Unknown server');
      host = this.buildHost(rec);
      fileRoot = rec.fileRoot;
    }
    const e = {
      id, host, fileRoot,
      sampler: new Sampler(host, { intervalMs: this.config.sampleIntervalMs, length: this.config.historyLength }),
      files: new FileManager(host, fileRoot),
      logs: new LogReader(host, this.config.logDirs),
      info: null, infoAt: 0, aws: undefined,
    };
    this.entries.set(id, e);
    return e;
  }

  buildHost(rec, overrides = {}) {
    const key = overrides.key || loadKey(this.vault.decrypt(rec.keyEnc), rec.passEnc ? this.vault.decrypt(rec.passEnc) : undefined);
    return new SshHost({ ...rec, ...overrides.rec }, { privateKey: key.privateKey, passphrase: key.passphrase });
  }

  /** Cached static info (hostname, OS, CPU, addresses): refreshed every 30 s. */
  async info(e) {
    if (!e.info || Date.now() - e.infoAt > 30000) { e.info = await systemInfo(e.host); e.infoAt = Date.now(); }
    return e.info;
  }

  awsMeta(e) {
    if (e.aws === undefined) {
      e.aws = null;
      fetchInstanceMetadata(e.host).then((v) => { e.aws = v; });
    }
    return e.aws;
  }

  drop(id) {
    const e = this.entries.get(id);
    if (e) { e.sampler.stop(); e.host.close(); this.entries.delete(id); }
  }

  closeAll() { for (const id of [...this.entries.keys()]) this.drop(id); }

  // ---------- management ----------

  async probe(host, port) {
    const v = clean({ name: 'x', host, port, username: 'x' });
    return { fingerprint: await probeHostKey(v.host, v.port), host: v.host, port: v.port };
  }

  /** Connect with candidate credentials and report what we learned. Throws on failure. */
  async verify(rec, key) {
    const host = new SshHost(rec, { privateKey: key.privateKey, passphrase: key.passphrase });
    try {
      const started = Date.now();
      await host.connect();
      const id = await host.run('id', ['-un']);
      const sudo = rec.username === 'root' ? { ok: true } : await host.run('sudo', ['-n', 'true']);
      const os = await host.run('sh', ['-c', '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"']);
      return { user: id.stdout.trim(), sudo: sudo.ok, os: os.stdout.trim(), latencyMs: Date.now() - started };
    } finally { host.close(); }
  }

  async create(input, createdBy) {
    const v = clean(input);
    if (!FP_RE.test(String(input.hostKey || ''))) throw httpError(400, 'Confirm the server host key fingerprint first');
    if (this.records.some((r) => r.name.toLowerCase() === v.name.toLowerCase())) throw httpError(409, 'A server with that name already exists');
    const key = await loadKeyAsync(input.privateKey, input.passphrase);
    const rec = { id: crypto.randomUUID(), ...v, hostKey: input.hostKey, useSudo: v.useSudo !== false };
    const info = await this.verify(rec, key);
    Object.assign(rec, {
      keyEnc: this.vault.encrypt(key.privateKey),
      passEnc: key.passphrase ? this.vault.encrypt(key.passphrase) : null,
      keyType: key.type, keyFingerprint: key.fingerprint, keyComment: key.comment,
      created: new Date().toISOString(), createdBy,
    });
    this.records.push(rec);
    this.store.save();
    return { server: this.publicRecord(rec), info };
  }

  async update(id, input) {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw httpError(404, 'Unknown server');
    const v = clean(input, { partial: true });
    if (v.name && v.name !== rec.name && this.records.some((r) => r.id !== id && r.name.toLowerCase() === v.name.toLowerCase())) throw httpError(409, 'A server with that name already exists');
    const next = { ...rec, ...v };
    if (input.hostKey !== undefined) {
      if (!FP_RE.test(String(input.hostKey))) throw httpError(400, 'Invalid host key fingerprint');
      next.hostKey = input.hostKey;
    }
    let key = null;
    if (input.privateKey) {
      key = await loadKeyAsync(input.privateKey, input.passphrase);
      Object.assign(next, { keyEnc: this.vault.encrypt(key.privateKey), passEnc: key.passphrase ? this.vault.encrypt(key.passphrase) : null, keyType: key.type, keyFingerprint: key.fingerprint, keyComment: key.comment });
    }
    // anything that affects how we connect must be re-verified before it is saved
    const connectionChanged = ['host', 'port', 'username', 'hostKey'].some((k) => next[k] !== rec[k]) || key;
    let info = null;
    if (connectionChanged) info = await this.verify(next, key || loadKey(this.vault.decrypt(rec.keyEnc), rec.passEnc ? this.vault.decrypt(rec.passEnc) : undefined));
    Object.assign(rec, next);
    this.store.save();
    this.drop(id);
    return { server: this.publicRecord(rec), info };
  }

  remove(id) {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) throw httpError(404, 'Unknown server');
    this.drop(id);
    this.records.splice(i, 1);
    this.store.save();
  }

  async test(id) {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw httpError(404, 'Unknown server');
    const key = loadKey(this.vault.decrypt(rec.keyEnc), rec.passEnc ? this.vault.decrypt(rec.passEnc) : undefined);
    return this.verify(rec, key);
  }
}

module.exports = { ServerRegistry };
