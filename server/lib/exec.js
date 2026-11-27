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

const canSudo = () => typeof process.getuid === 'function' && process.getuid() !== 0 && process.env.PANEL_USE_SUDO !== 'false';

/**
 * Run a command with root privileges when the panel is not root (via `sudo -n`, never prompting).
 * If sudo is missing or not permitted for this command, fall back to running it directly,
 * so unprivileged-but-sufficient setups (e.g. docker group, systemd-journal group) still work.
 */
async function runPriv(cmd, args = [], opts = {}) {
  if (!canSudo()) return run(cmd, args, opts);
  const r = await run('sudo', ['-n', cmd, ...args], opts);
  if (r.ok || !(r.missing || /^sudo: /m.test(r.stderr))) return r;
  return run(cmd, args, opts);
}

module.exports = { run, runPriv };
