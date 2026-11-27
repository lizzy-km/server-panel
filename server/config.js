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
    // manage the machine the panel itself runs on (off by default: the panel is meant to manage remote servers)
    enableLocal: bool(env.PANEL_ENABLE_LOCAL, false),
    // encrypts stored SSH keys; if unset a random key is kept in <dataDir>/master.key
    secret: env.PANEL_SECRET || '',
    secureCookies: bool(env.PANEL_SECURE_COOKIES, false),
    sessionHours: Number(env.PANEL_SESSION_HOURS || 12),
    sampleIntervalMs: Number(env.PANEL_SAMPLE_MS || 3000),
    historyLength: Number(env.PANEL_HISTORY || 200),
    maxUploadBytes: Number(env.PANEL_MAX_UPLOAD_MB || 200) * 1024 * 1024,
    // where things live on the MANAGED servers (defaults suit Amazon Linux 2023; overridable mainly for tests)
    appsBaseDir: env.PANEL_APPS_DIR || '/srv/apps',
    unitDir: env.PANEL_UNIT_DIR || '/etc/systemd/system',
    nginxConfDir: env.PANEL_NGINX_CONF_DIR || '/etc/nginx/conf.d',
    nginxLogDir: env.PANEL_NGINX_LOG_DIR || '/var/log/nginx',
    nginxConf: env.PANEL_NGINX_CONF || '', // pass `-c <file>` to nginx (tests)
    letsencryptDir: env.PANEL_LETSENCRYPT_DIR || '/etc/letsencrypt',
    acmeRoot: env.PANEL_ACME_ROOT || '/var/www/letsencrypt',
    allowLocalRepos: bool(env.PANEL_ALLOW_LOCAL_REPOS, false), // file:// repositories (tests only)
    publicUrl: (env.PANEL_PUBLIC_URL || '').replace(/\/+$/, ''), // used to display webhook URLs
    publicDir: path.join(__dirname, '..', 'public'),
  };
}

module.exports = { loadConfig };
