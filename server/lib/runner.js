'use strict';
const fs = require('fs');
const path = require('path');

const MAX_LOG = 2 * 1024 * 1024;

/**
 * Runs a bash script on a host with live, persisted output. Lines starting with "@@KEY value" are
 * machine markers (COMMIT, MSG, STATE): they are parsed, not written to the log.
 */
class Runner {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.live = new Set();
  }

  file(id) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error('bad job id');
    return path.join(this.dir, `${id}.log`);
  }

  async run({ id, host, script, timeout }) {
    const file = this.file(id);
    fs.writeFileSync(file, '', { mode: 0o600 });
    const markers = {};
    let carry = '';
    let written = 0;
    let truncated = false;
    const write = (text) => {
      if (!text || truncated) return;
      if (written + text.length > MAX_LOG) { fs.appendFileSync(file, '\n[log truncated: size limit reached]\n'); truncated = true; return; }
      written += text.length;
      fs.appendFileSync(file, text);
    };
    const onData = (d) => {
      const text = carry + d;
      carry = '';
      const nl = text.lastIndexOf('\n');
      const complete = nl >= 0 ? text.slice(0, nl + 1) : '';
      const partial = text.slice(nl + 1);
      let out = '';
      for (const line of complete.split('\n').slice(0, -1)) {
        const m = line.match(/^@@([A-Z]+) ?(.*)$/);
        if (m) markers[m[1]] = m[2]; else out += line + '\n';
      }
      if (partial.startsWith('@')) carry = partial; else out += partial; // only hold back possible marker prefixes
      write(out);
    };
    this.live.add(id);
    try {
      const r = await host.stream('bash -s 2>&1', { stdin: script, timeout, onData });
      if (carry) write(carry);
      if (r.error) write(`\n${r.error}\n`);
      if (r.timedOut) write('\n!! Timed out\n');
      return { ...r, markers };
    } finally { this.live.delete(id); }
  }

  /** Read a log from a byte offset (for polling UIs). */
  read(id, offset = 0) {
    const file = this.file(id);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return { text: '', offset: 0, done: true, missing: true }; }
    const start = Math.min(Math.max(0, offset), size);
    const len = Math.min(size - start, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    // do not cut a UTF-8 character in half
    let end = len;
    while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1;
    if (end > 0 && buf[end - 1] >= 0xc0) end -= 1;
    const text = buf.subarray(0, end).toString('utf8');
    return { text, offset: start + end, done: !this.live.has(id) && start + end >= size };
  }

  append(id, text) { try { fs.appendFileSync(this.file(id), text); } catch { /* ignore */ } }

  remove(id) { try { fs.rmSync(this.file(id), { force: true }); } catch { /* ignore */ } }
}

module.exports = { Runner };
