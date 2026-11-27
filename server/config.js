'use strict';
const os = require('os');
const path = require('path');

const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));

function loadConfig(env = process.env) {
  return {
    host: env.PANEL_HOST || '127.0.0.1',
    port: Number(env.PANEL_PORT || 8080),
    dataDir: path.resolve(env.PANEL_DATA_DIR || path.join(__dirname, '..', 'data')),
    filesRoot: path.resolve(env.PANEL_FILES_ROOT || os.homedir()),
    logDirs: (env.PANEL_LOG_DIRS || '/var/log').split(',').map((s) => s.trim()).filter(Boolean),
    enableExec: bool(env.PANEL_ENABLE_EXEC, true),
    secureCookies: bool(env.PANEL_SECURE_COOKIES, false),
    sessionHours: Number(env.PANEL_SESSION_HOURS || 12),
    sampleIntervalMs: Number(env.PANEL_SAMPLE_MS || 3000),
    historyLength: Number(env.PANEL_HISTORY || 200),
    maxUploadBytes: Number(env.PANEL_MAX_UPLOAD_MB || 200) * 1024 * 1024,
    publicDir: path.join(__dirname, '..', 'public'),
  };
}

module.exports = { loadConfig };
