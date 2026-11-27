'use strict';
/**
 * Bash scripts executed on managed servers (via `bash -s`, script on stdin).
 * Every interpolated value goes through shq(); secrets (git tokens/keys, env vars) live only inside the
 * script text that travels over the SSH channel's stdin, so they never show up in `ps` on the target.
 */
const { shq } = require('./host');

const PRIV = `priv() { if [ "\${USE_SUDO:-0}" = 1 ] && [ "$(id -u)" != 0 ]; then sudo -n "$@"; else "$@"; fi; }
step() { echo; echo "==> $*"; }`;

/** KEY="value" lines readable by systemd EnvironmentFile= and dotenv. */
function envFileText(vars) {
  return Object.entries(vars).map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`).join('\n') + '\n';
}
/** Same variables as a shell-sourceable file (single-quote escaping), used to build with the app's env. */
function envShellText(vars) {
  return Object.entries(vars).map(([k, v]) => `export ${k}=${shq(v)}`).join('\n') + '\n';
}

const DEFAULT_INSTALL = 'if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi';
const DEFAULT_BUILD = `if node -e "const s=require('./package.json').scripts;process.exit(s&&s.build?0:1)"; then npm run build; else echo "(no build script - skipping)"; fi`;

function startScript(app, appDir) {
  const path = app.extraPath ? `export PATH=${shq(app.extraPath)}:"$PATH"\n` : '';
  return `#!/bin/bash\n# Managed by Server Panel\n${path}cd ${shq(appDir + '/current')} || exit 1\nexec bash -c ${shq(app.startCmd || 'npm start')}\n`;
}

function unitText(app, appDir, user) {
  return `# Managed by Server Panel - changes are overwritten on the next deploy
[Unit]
Description=${app.name} (Server Panel app)
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${appDir}/current
EnvironmentFile=-${appDir}/shared/.env
Environment=PORT=${app.port}
Environment=NODE_ENV=production
ExecStart=${appDir}/shared/start.sh
Restart=always
RestartSec=3
SyslogIdentifier=${app.unit.replace(/\.service$/, '')}

[Install]
WantedBy=multi-user.target
`;
}

// default: any HTTP answer below 500 counts as "up" (an API root may legitimately 404); strict: 2xx/3xx only
const healthFn = (app) => {
  const check = app.healthStrict ? '{ [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; }' : '[ "$code" -lt 500 ]';
  return `wait_healthy() {
  local i code
  step "Health check http://127.0.0.1:$PORT$HEALTH (up to \${HEALTH_TIMEOUT}s)"
  for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT$HEALTH" 2>/dev/null || true)
    code=\${code:-000}
    if [ "$code" != 000 ] && ${check} && priv systemctl is-active --quiet "$UNIT"; then echo "healthy (HTTP $code after \${i}s)"; return 0; fi
    sleep 1
  done
  return 1
}`;
};

function common(app, ctx) {
  return `set -euo pipefail
export LC_ALL=C GIT_TERMINAL_PROMPT=0
USE_SUDO=${ctx.useSudo ? 1 : 0}
${PRIV}
APP_DIR=${shq(ctx.appDir)}
UNIT=${shq(app.unit)}
UNIT_DIR=${shq(ctx.unitDir)}
PORT=${Number(app.port)}
HEALTH=${shq(app.healthPath || '/')}
HEALTH_TIMEOUT=${Number(app.healthTimeout) || 30}
KEEP=${Number(app.keepReleases) || 5}
TMP=$(mktemp -d)
STATE=""; ACTIVATED=0; REL=""
${healthFn(app)}
on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$STATE" ]; then echo "@@STATE failed"; if [ "$ACTIVATED" = 0 ] && [ -n "$REL" ]; then rm -rf -- "$REL"; fi; fi
  rm -rf -- "$TMP"
}
trap on_exit EXIT
`;
}

/** Full deploy: clone -> env -> install -> build -> service -> atomic switch -> health check (-> rollback). */
function deployScript(app, ctx) {
  const { appDir, relId, ref, secrets } = ctx;
  const protocols = ctx.allowLocalRepos ? 'https:ssh:file' : 'https:ssh';
  let gitAuth = '';
  if (app.authType === 'token' && secrets.gitSecret) {
    const askpass = `#!/bin/sh\ncase "$1" in Username*) printf '%s\\n' ${shq(app.tokenUser || 'x-access-token')};; *) printf '%s\\n' ${shq(secrets.gitSecret)};; esac\n`;
    gitAuth = `printf %s ${shq(askpass)} > "$TMP/askpass"; chmod 700 "$TMP/askpass"; export GIT_ASKPASS="$TMP/askpass"\n`;
  } else if (app.authType === 'key' && secrets.gitSecret) {
    const key = secrets.gitSecret.endsWith('\n') ? secrets.gitSecret : secrets.gitSecret + '\n';
    gitAuth = `umask 077; printf %s ${shq(key)} > "$TMP/key"; umask 022
export GIT_SSH_COMMAND="ssh -i $TMP/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$APP_DIR/shared/known_hosts -o BatchMode=yes"\n`;
  }
  return `${common(app, ctx)}export GIT_ALLOW_PROTOCOL=${protocols}
REL="$APP_DIR/releases/${relId}"

step "Preparing $APP_DIR"
if ! mkdir -p "$APP_DIR/releases" "$APP_DIR/shared" 2>/dev/null; then
  priv mkdir -p "$APP_DIR"; priv chown "$(id -un):$(id -gn)" "$APP_DIR"; mkdir -p "$APP_DIR/releases" "$APP_DIR/shared"
fi
PREV=$(readlink "$APP_DIR/current" 2>/dev/null || true)
command -v git >/dev/null || { echo "git is not installed on this server (use Deploy -> Prepare server)"; exit 1; }
command -v node >/dev/null || { echo "node is not installed on this server (use Deploy -> Prepare server)"; exit 1; }

step "Cloning ${ctx.repoLabel} (${ref})"
${gitAuth}git clone --depth 1 --branch ${shq(ref)} -- ${shq(app.repoUrl)} "$REL"
SHA=$(git -C "$REL" rev-parse HEAD)
echo "@@COMMIT $SHA"
echo "@@MSG $(git -C "$REL" log -1 --pretty=%s | head -c 200)"
printf '%s\\n' "$SHA" > "$REL/.release-commit"
rm -rf "$REL/.git"

step "Writing environment"
umask 077
printf %s ${shq(ctx.envFile)} > "$APP_DIR/shared/.env"
printf %s ${shq(ctx.envShell)} > "$APP_DIR/shared/.env.sh"
umask 022
ln -sfn "$APP_DIR/shared/.env" "$REL/.env"

step "Installing dependencies"
( set -a; . "$APP_DIR/shared/.env.sh"; set +a; cd "$REL"; bash -ec ${shq(app.installCmd || DEFAULT_INSTALL)} )

step "Building"
( set -a; . "$APP_DIR/shared/.env.sh"; set +a; cd "$REL"; bash -ec ${shq(app.buildCmd || DEFAULT_BUILD)} )

step "Configuring service $UNIT"
printf %s ${shq(ctx.startSh)} > "$APP_DIR/shared/start.sh"; chmod 755 "$APP_DIR/shared/start.sh"
printf %s ${shq(ctx.unit)} > "$TMP/unit"
if ! priv cmp -s "$TMP/unit" "$UNIT_DIR/$UNIT" 2>/dev/null; then
  priv install -m 644 "$TMP/unit" "$UNIT_DIR/$UNIT"; priv systemctl daemon-reload
  echo "service file updated"
else echo "service file unchanged"; fi

step "Activating release"
ln -sfn "$REL" "$APP_DIR/current.new"; mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"; ACTIVATED=1
priv systemctl enable "$UNIT" >/dev/null 2>&1 || true
priv systemctl restart "$UNIT"
if ! wait_healthy; then
  echo "!! Health check failed"
  priv journalctl -u "$UNIT" -n 40 --no-pager 2>&1 || true
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    step "Rolling back to $(basename "$PREV")"
    ln -sfn "$PREV" "$APP_DIR/current.new"; mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
    priv systemctl restart "$UNIT" || true
    if wait_healthy; then STATE=rolled_back; echo "@@STATE rolled_back"
    else echo "!! The previous release is not healthy either - the app is DOWN. Check the service logs."; STATE=failed; echo "@@STATE failed"; fi
  else
    STATE=failed; echo "@@STATE failed"
  fi
  exit 1
fi

step "Cleaning old releases (keeping $KEEP)"
cur=$(readlink "$APP_DIR/current")
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | sed 's#/$##' | tail -n +$((KEEP + 1)) | while read -r d; do
  if [ "$d" != "$cur" ] && [ "$d" != "$PREV" ]; then rm -rf -- "$d"; echo "removed $(basename "$d")"; fi
done
STATE=ok; echo "@@STATE ok"
echo; echo "Deployed $SHA"
`;
}

/** Point `current` at an existing release, restart, health-check. */
function rollbackScript(app, ctx) {
  return `${common(app, ctx)}REL=${shq(ctx.appDir + '/releases/' + ctx.release)}
[ -d "$REL" ] || { echo "release not found: $REL"; exit 1; }
PREV=$(readlink "$APP_DIR/current" 2>/dev/null || true)
step "Switching to ${ctx.release}"
ln -sfn "$REL" "$APP_DIR/current.new"; mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"; ACTIVATED=1
echo "@@COMMIT $(cat "$REL/.release-commit" 2>/dev/null || echo unknown)"
priv systemctl restart "$UNIT"
if ! wait_healthy; then
  echo "!! Health check failed"
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    step "Restoring $(basename "$PREV")"
    ln -sfn "$PREV" "$APP_DIR/current.new"; mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"; priv systemctl restart "$UNIT" || true
    if wait_healthy; then STATE=rolled_back; echo "@@STATE rolled_back"
    else echo "!! The previous release is not healthy either - the app is DOWN. Check the service logs."; STATE=failed; echo "@@STATE failed"; fi
  else STATE=failed; echo "@@STATE failed"; fi
  exit 1
fi
STATE=ok; echo "@@STATE ok"
`;
}

/** Write the app's env files and restart the service (no rebuild); report whether it came back healthy. */
function envApplyScript(app, ctx) {
  return `${common(app, ctx)}[ -d "$APP_DIR/current" ] || { echo "This app has not been deployed yet: deploy it first."; exit 1; }
step "Writing environment"
umask 077
printf %s ${shq(ctx.envFile)} > "$APP_DIR/shared/.env"
printf %s ${shq(ctx.envShell)} > "$APP_DIR/shared/.env.sh"
umask 022
step "Restarting $UNIT"
priv systemctl restart "$UNIT"
if wait_healthy; then STATE=ok; echo "@@STATE ok"; else echo "!! The app did not become healthy with this environment. Fix the values and apply again."; STATE=failed; echo "@@STATE failed"; exit 1; fi
`;
}

/** Remove an app's service (and optionally its files). */
function removeAppScript(app, ctx) {
  return `set -uo pipefail
USE_SUDO=${ctx.useSudo ? 1 : 0}
${PRIV}
UNIT=${shq(app.unit)}
priv systemctl stop "$UNIT" 2>/dev/null; priv systemctl disable "$UNIT" 2>/dev/null
priv rm -f ${shq(ctx.unitDir + '/' + app.unit)}; priv systemctl daemon-reload
${ctx.deleteFiles ? `rm -rf -- ${shq(ctx.appDir)} 2>/dev/null || priv rm -rf -- ${shq(ctx.appDir)}` : 'true'}
echo done
`;
}

const TOOLS_CHECK = `
for t in git node npm nginx certbot curl openssl python3; do
  p=$(command -v $t 2>/dev/null) || { echo "$t=missing"; continue; }
  case $t in
    git) v=$($t --version 2>&1 | head -1 | awk '{print $3}');;
    node) v=$($t --version 2>&1 | head -1);;
    npm) v=$($t --version 2>&1 | head -1);;
    nginx) v=$($t -v 2>&1 | head -1 | sed 's#.*/##' | awk '{print $1}');;
    certbot) v=$($t --version 2>&1 | head -1 | awk '{print $2}');;
    curl) v=$($t --version 2>&1 | head -1 | awk '{print $2}');;
    openssl) v=$($t version 2>&1 | head -1 | awk '{print $2}');;
    python3) v=$($t --version 2>&1 | head -1 | awk '{print $2}');;
  esac
  echo "$t=$v"
done
echo "nginx_active=$(systemctl is-active nginx 2>/dev/null || echo inactive)"
echo "certbot_timer=$(systemctl is-active certbot-renew.timer 2>/dev/null || echo inactive)"
echo "user=$(id -un)"
echo "sudo=$(if [ "$(id -u)" = 0 ]; then echo root; elif sudo -n true 2>/dev/null; then echo yes; else echo no; fi)"
`;

const TIMER_SERVICE = `[Unit]
Description=Certbot renewal (Server Panel)

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet
`;
const TIMER_UNIT = `[Unit]
Description=Twice-daily certbot renewal (Server Panel)

[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`;

/** Install prerequisites with dnf (Amazon Linux 2023). tools: subset of git,node,nginx,certbot */
function installScript(tools, ctx) {
  const parts = [`set -euo pipefail
USE_SUDO=${ctx.useSudo ? 1 : 0}
${PRIV}
command -v dnf >/dev/null || { echo "dnf not found - this installer targets Amazon Linux 2023"; exit 1; }`];
  if (tools.includes('git')) parts.push('step "Installing git"; priv dnf -y install git');
  if (tools.includes('node')) parts.push('step "Installing Node.js"; priv dnf -y install nodejs22 nodejs22-npm || priv dnf -y install nodejs20 nodejs20-npm');
  if (tools.includes('nginx')) {
    parts.push(`step "Installing nginx"; priv dnf -y install nginx
priv mkdir -p ${shq(ctx.acmeRoot)}
priv systemctl enable --now nginx
echo "nginx enabled and started. Remember to allow inbound ports 80 and 443 in the security group."`);
  }
  if (tools.includes('certbot')) {
    parts.push(`step "Installing certbot (Python venv, as recommended for Amazon Linux 2023)"
priv dnf -y install python3 python3-pip augeas-libs
priv python3 -m venv /opt/certbot
priv /opt/certbot/bin/pip install --upgrade pip certbot
priv ln -sf /opt/certbot/bin/certbot /usr/bin/certbot
priv mkdir -p ${shq(ctx.acmeRoot)}
T=$(mktemp -d)
printf %s ${shq(TIMER_SERVICE)} > "$T/certbot-renew.service"
printf %s ${shq(TIMER_UNIT)} > "$T/certbot-renew.timer"
priv install -m 644 "$T/certbot-renew.service" ${shq(ctx.unitDir + '/certbot-renew.service')}
priv install -m 644 "$T/certbot-renew.timer" ${shq(ctx.unitDir + '/certbot-renew.timer')}
priv systemctl daemon-reload
priv systemctl enable --now certbot-renew.timer
echo "automatic renewal timer enabled"`);
  }
  parts.push('echo; echo "@@STATE ok"');
  return parts.join('\n') + '\n';
}

module.exports = {
  envFileText, envShellText, startScript, unitText, deployScript, rollbackScript, envApplyScript, removeAppScript,
  installScript, TOOLS_CHECK, DEFAULT_INSTALL, DEFAULT_BUILD,
};
