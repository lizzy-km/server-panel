'use strict';
const fs = require('fs');
const path = require('path');

/** Tiny JSON file store with atomic writes. */
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = structuredClone(defaults);
    }
    for (const [k, v] of Object.entries(defaults)) if (!(k in this.data)) this.data[k] = structuredClone(v);
  }
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/** Append-only JSON-lines audit log. */
class AuditLog {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  write(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFile(this.file, line, { mode: 0o600 }, () => {});
  }
  tail(limit = 200) {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  }
}

module.exports = { JsonStore, AuditLog };
