'use strict';
const { execFile } = require('child_process');

/** Run a binary without a shell. Never rejects: resolves {ok, code, stdout, stderr, missing}. */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: opts.timeout ?? 10000,
      maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
      cwd: opts.cwd,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        missing: !!err && err.code === 'ENOENT',
        timedOut: !!err && err.killed === true,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err && err.code === 'ENOENT' ? `${cmd}: not found` : '')),
      });
    });
  });
}

module.exports = { run };
