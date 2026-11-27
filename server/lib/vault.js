'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Encrypts stored secrets (SSH private keys, passphrases) with AES-256-GCM.
 *
 * The master key comes from PANEL_SECRET (kept off disk — recommended) or, if unset, from
 * <dataDir>/master.key (generated on first use, mode 0600). The file variant protects against
 * leaking panel.json alone (backups, accidental copies); it does NOT protect against someone who
 * can read the whole data directory.
 */
class Vault {
  constructor(dataDir, secret) {
    if (secret) {
      this.key = crypto.scryptSync(String(secret), 'server-panel-vault-v1', 32);
      this.source = 'env';
    } else {
      const file = path.join(dataDir, 'master.key');
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      try {
        this.key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
        if (this.key.length !== 32) throw new Error('bad key length');
      } catch (e) {
        if (e.code && e.code !== 'ENOENT') throw e;
        this.key = crypto.randomBytes(32);
        fs.writeFileSync(file, this.key.toString('hex') + '\n', { mode: 0o600 });
      }
      this.source = 'file';
    }
  }

  encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  decrypt(blob) {
    if (typeof blob !== 'string' || !blob.startsWith('v1.')) throw new Error('Unrecognised secret format');
    const raw = Buffer.from(blob.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    try {
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      throw new Error('Could not decrypt stored secret (wrong PANEL_SECRET or master.key?)');
    }
  }
}

module.exports = { Vault };
