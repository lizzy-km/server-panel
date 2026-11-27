#!/usr/bin/env node
'use strict';
/**
 * Double-click friendly launcher: starts the panel, opens it in your browser and (on first run) puts the
 * one-time setup token in the page address after the "#", which browsers never send to any server,
 * so the setup form is pre-filled and nobody has to copy it out of a console window.
 */
const { spawn } = require('child_process');
const { main } = require('./index');

function setupUrl(app) {
  const { host, port } = app.config;
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const base = `http://${h}:${port}/`;
  return app.auth.needsSetup() ? `${base}#setup=${app.auth.ensureSetupToken()}` : base;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the URL is printed anyway */ }
}

if (require.main === module) {
  const app = main();
  app.server.on('listening', () => {
    const url = setupUrl(app);
    console.log(`\nOpening ${url.replace(/#.*/, '')} in your browser. Leave this window open while you use the panel.\n`);
    if (!process.env.PANEL_NO_BROWSER) openBrowser(url);
  });
}

module.exports = { setupUrl };
