'use strict';
/**
 * Bash scripts executed on managed servers (via `bash -s`, script on stdin).
 * Every interpolated value goes through shq(); secrets (git tokens/keys, env vars) live only inside the
 * script text that travels over the SSH channel's stdin, so they never show up in `ps` on the target.
 *
 * Three run modes (see presets.js): service (systemd + port), static (nginx serves a build folder), php (PHP-FPM).
 * Layout: $APP_DIR/{releases/<id>, shared/, current -> release, live -> release/<output folder> (static/php only)}
 */
const { shq } = require('./host');
const { detectScript } = require('./presets');

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

function startScript(app, cfg, appDir) {
  const path = app.extraPath ? `export PATH=${shq(app.extraPath)}:"$PATH"\n` : '';
  return `#!/bin/bash\n# Managed by Server Panel\n${path}cd ${shq(appDir + '/current')} || exit 1\nexec bash -c ${shq(cfg.start || 'npm start')}\n`;
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

// Health: service = HTTP on the app's port; static = the build has an index file; php = HTTP through nginx when a
// host name is known, otherwise "index.php exists". Default: any answer below 500 counts as up (an API root may 404).
const healthFn = (app) => {
  const check = app.healthStrict ? '{ [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; }' : '[ "$code" -lt 500 ]';
  return `healthy_once() {
  local code
  case "$MODE" in
    service)
      code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT$HEALTH" 2>/dev/null || true); code=\${code:-000}
      [ "$code" != 000 ] && ${check} && priv systemctl is-active --quiet "$UNIT" ;;
    static) [ -f "$APP_DIR/live/index.html" ] || [ -f "$APP_DIR/live/index.htm" ] ;;
    php)
      if [ -n "$HEALTH_HOST" ]; then
        code=$(curl -s -o /dev/null -m 5 -H "Host: $HEALTH_HOST" -w '%{http_code}' "http://127.0.0.1$HEALTH" 2>/dev/null || true); code=\${code:-000}
        [ "$code" != 000 ] && ${check}
      else [ -f "$APP_DIR/live/index.php" ]; fi ;;
  esac
}
wait_healthy() {
  local i
  case "$MODE" in service) step "Health check http://127.0.0.1:$PORT$HEALTH (up to \${HEALTH_TIMEOUT}s)";; php) step "Health check (up to \${HEALTH_TIMEOUT}s)";; *) step "Checking the build output";; esac
  for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    if healthy_once; then echo "healthy (after \${i}s)"; return 0; fi
    sleep 1
  done
  return 1
}`;
};

function common(app, cfg, ctx) {
  return `set -euo pipefail
export LC_ALL=C GIT_TERMINAL_PROMPT=0
USE_SUDO=${ctx.useSudo ? 1 : 0}
${PRIV}
APP_DIR=${shq(ctx.appDir)}
MODE=${shq(cfg.mode)}
UNIT=${shq(app.unit || '')}
UNIT_DIR=${shq(ctx.unitDir)}
PORT=${Number(app.port) || 0}
HEALTH=${shq(cfg.healthPath || '/')}
HEALTH_HOST=${shq(app.healthHost || '')}
HEALTH_TIMEOUT=${Number(cfg.healthTimeout) || 30}
KEEP=${Number(app.keepReleases) || 5}
APP_USER=${shq(ctx.appUser || '')}
FPM_UNIT=${shq(ctx.fpmUnit || 'php-fpm.service')}
TMP=$(mktemp -d)
STATE=""; ACTIVATED=0; REL=""
# run a command string in the release folder with the app's environment, as the app user (own build files, own caches)
as_app() {
  local run=(bash -ec 'set -a; . "$1"; set +a; export HOME="$4"; cd "$2"; eval "$3"' _ "$APP_DIR/shared/.env.sh" "\${REL}" "$1" "$APP_DIR/shared/home")
  if [ -n "$APP_USER" ] && [ "$APP_USER" != "$(id -un)" ]; then sudo -n -u "$APP_USER" "\${run[@]}"; else "\${run[@]}"; fi
}
# install a file with the app user as owner (when different from the SSH user)
put() { if [ -n "$APP_USER" ] && [ "$APP_USER" != "$(id -un)" ]; then priv install -m "$3" -o "$APP_USER" "$1" "$2"; else install -m "$3" "$1" "$2"; fi; }
# atomic switch: current -> release; live -> release/<output folder> for static and php apps
activate() {
  local r="$1" o
  ln -sfn "$r" "$APP_DIR/current.new"; mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
  if [ "$MODE" != service ]; then
    o=$(cat "$r/.outdir" 2>/dev/null || echo .)
    ln -sfn "$r/$o" "$APP_DIR/live.new"; mv -Tf "$APP_DIR/live.new" "$APP_DIR/live"
  fi
}
# make the new code take effect
apply_release() {
  case "$MODE" in
    service) priv systemctl restart "$UNIT" ;;
    php) priv systemctl reload "$FPM_UNIT" 2>/dev/null || echo "(could not reload PHP-FPM; OPcache may serve old code for a moment)" ;;
    *) true ;;
  esac
}
${healthFn(app)}
on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$STATE" ]; then echo "@@STATE failed"; if [ "$ACTIVATED" = 0 ] && [ -n "$REL" ]; then priv rm -rf -- "$REL"; fi; fi
  rm -rf -- "$TMP"
}
trap on_exit EXIT
`;
}

const GIT_AUTH = (app, secrets) => {
  if (app.authType === 'token' && secrets.gitSecret) {
    const askpass = `#!/bin/sh\ncase "$1" in Username*) printf '%s\\n' ${shq(app.tokenUser || 'x-access-token')};; *) printf '%s\\n' ${shq(secrets.gitSecret)};; esac\n`;
    return `printf %s ${shq(askpass)} > "$TMP/askpass"; chmod 700 "$TMP/askpass"; export GIT_ASKPASS="$TMP/askpass"\n`;
  }
  if (app.authType === 'key' && secrets.gitSecret) {
    const key = secrets.gitSecret.endsWith('\n') ? secrets.gitSecret : secrets.gitSecret + '\n';
    return `umask 077; printf %s ${shq(key)} > "$TMP/key"; umask 022
export GIT_SSH_COMMAND="ssh -i $TMP/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$APP_DIR/shared/known_hosts -o BatchMode=yes"\n`;
  }
  return '';
};


const PHP_PREFLIGHT = `step "Checking the PHP version and extensions this app needs"
if [ -f "$REL/composer.lock" ] && command -v composer >/dev/null 2>&1; then
  PHPCHECK=$(as_app 'composer check-platform-reqs --lock --no-dev --format=json 2>/dev/null' || true)
  SUMMARY=$(printf '%s' "$PHPCHECK" | php -r '$j = json_decode(stream_get_contents(STDIN), true); if (!is_array($j)) exit(0); foreach ($j as $r) { $st = $r["status"] ?? ""; if ($st !== "failed" && $st !== "missing") continue; $n = $r["name"] ?? "?"; $need = $r["failed_requirement"]["constraint"] ?? ""; $src = $r["failed_requirement"]["source"] ?? "the app"; if ($n === "php") echo "PHP " . $need . " is required by " . $src . " but this server has PHP " . ($r["version"] ?? "?") . "\\n"; else echo "The PHP extension " . preg_replace("/^ext-/", "", $n) . " is required by " . $src . " but is not installed on this server\\n"; }' 2>/dev/null || true)
  if [ -n "$SUMMARY" ]; then
    echo "!! This server cannot run this app as it is:"
    printf '%s\\n' "$SUMMARY" | sed 's/^/   - /'
    NEED=$(printf '%s' "$PHPCHECK" | php -r '$j = json_decode(stream_get_contents(STDIN), true); foreach ((array)$j as $r) if (($r["name"] ?? "") === "php" && ($r["status"] ?? "") === "failed" && preg_match("/([0-9]+\\\\.[0-9]+)/", $r["failed_requirement"]["constraint"] ?? "", $m)) { echo $m[1]; break; }' 2>/dev/null || true)
    HAVE=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;' 2>/dev/null || true)
    echo
    echo "   You can fix this in one of two ways:"
    echo "   1) On the server: install a PHP version the app supports (a button appears below this log)."
    echo "   2) In your code: add  \\"config\\": { \\"platform\\": { \\"php\\": \\"\${HAVE:-8.3}.0\\" } }  to composer.json, run  composer update  on your computer"
    echo "      and commit the new composer.lock, so the lock file only uses packages that work on this server's PHP."
    echo "@@HINT php:\${NEED:-}"
    exit 1
  fi
  echo "PHP $(php -r 'echo PHP_VERSION;') satisfies this app's requirements"
else
  echo "(no composer.lock: nothing to check)"
fi
`;

const TOOL_COMMAND = { node: 'node', java: 'java', php: 'php', composer: 'composer', dotnet: 'dotnet', go: 'go', python: 'python3', git: 'git' };

/** Full deploy: clone -> env -> shared dirs -> install -> build -> (release cmd) -> activate -> health check (-> rollback). */
function deployScript(app, cfg, ctx) {
  const { appDir, relId, ref, secrets } = ctx;
  const protocols = ctx.allowLocalRepos ? 'https:ssh:file' : 'https:ssh';
  const shared = (cfg.sharedPaths || []).map((p) => `
SP="$APP_DIR/shared/"${shq(p)}
if [ ! -e "$SP" ]; then
  mkdir -p "$(dirname "$SP")"
  if [ -e "$REL/"${shq(p)} ]; then cp -a "$REL/"${shq(p)} "$SP"; else mkdir -p "$SP"; fi
  if [ -n "$APP_USER" ] && [ "$APP_USER" != "$(id -un)" ]; then priv chown -R "$APP_USER": "$SP"; fi
  echo "created shared ${p}"
fi
rm -rf "$REL/"${shq(p)}; mkdir -p "$(dirname "$REL/"${shq(p)})"; ln -s "$SP" "$REL/"${shq(p)}`).join('');
  const tools = ['git', ...(cfg.tools || [])].map((t) => `command -v ${TOOL_COMMAND[t] || t} >/dev/null 2>&1 || { echo "!! ${t} is not installed on this server. Open Deploy, then Server readiness, and click Install."; exit 1; }`).join('\n');
  const run = (label, cmd) => (cmd ? `step ${shq(label)}\nas_app ${shq(cmd)}\n` : '');
  return `${common(app, cfg, ctx)}export GIT_ALLOW_PROTOCOL=${protocols}
REL="$APP_DIR/releases/${relId}"

step "Preparing $APP_DIR"
if [ -d "$APP_DIR" ] && [ ! -d "$APP_DIR/releases" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
  echo "!! $APP_DIR already exists and contains files that are not managed by the panel."
  echo "   Nothing was changed. Pick another app name or folder, or use \"Add an existing app\" to adopt what is there."
  exit 1
fi
if ! mkdir -p "$APP_DIR/releases" "$APP_DIR/shared" 2>/dev/null; then
  priv mkdir -p "$APP_DIR"; priv chown "$(id -un):$(id -gn)" "$APP_DIR"; mkdir -p "$APP_DIR/releases" "$APP_DIR/shared"
fi
mkdir -p "$APP_DIR/shared/home"
if [ -n "$APP_USER" ] && [ "$APP_USER" != "$(id -un)" ]; then priv chown "$APP_USER": "$APP_DIR/shared/home"; fi
PREV=$(readlink "$APP_DIR/current" 2>/dev/null || true)
${tools}

step "Cloning ${ctx.repoLabel} (${ref})"
${GIT_AUTH(app, secrets)}git clone --depth 1 --branch ${shq(ref)} -- ${shq(app.repoUrl)} "$REL"
SHA=$(git -C "$REL" rev-parse HEAD)
echo "@@COMMIT $SHA"
echo "@@MSG $(git -C "$REL" log -1 --pretty=%s | head -c 200)"
printf '%s\\n' "$SHA" > "$REL/.release-commit"
rm -rf "$REL/.git"

step "Writing environment"
printf %s ${shq(ctx.envFile)} > "$TMP/env"; printf %s ${shq(ctx.envShell)} > "$TMP/envsh"
put "$TMP/env" "$APP_DIR/shared/.env" 600
put "$TMP/envsh" "$APP_DIR/shared/.env.sh" 600
ln -sfn "$APP_DIR/shared/.env" "$REL/.env"
${shared ? `\nstep "Linking shared folders"${shared}\n` : ''}
# from here on the app user owns the release (the SSH user must use sudo to touch it)
if [ -n "$APP_USER" ] && [ "$APP_USER" != "$(id -un)" ]; then priv chown -R "$APP_USER": "$REL"; fi
${cfg.phpCheck ? PHP_PREFLIGHT : ''}${run('Installing dependencies', cfg.install)}${run('Building', cfg.build)}${cfg.mode === 'service' ? '' : `
OUTDIR=${shq(cfg.outputDir || 'auto')}
if [ "$OUTDIR" = auto ]; then
  OUTDIR=$(cd "$REL" && find dist build out .output/public public -maxdepth 4 -name index.html -not -path '*/node_modules/*' 2>/dev/null | awk '{print length($0), $0}' | sort -n | head -1 | cut -d' ' -f2- | xargs -r dirname) || true
  if [ -z "$OUTDIR" ] && [ -f "$REL/index.html" ]; then OUTDIR=.; fi
  if [ -z "$OUTDIR" ]; then echo "!! Could not find the build output (no index.html in dist/, build/, out/ or public/). Set the output folder in the app's advanced settings."; exit 1; fi
  OUTDIR=\${OUTDIR#./}
fi
[ -d "$REL/$OUTDIR" ] || { echo "!! The output folder '$OUTDIR' does not exist after the build."; exit 1; }
echo "$OUTDIR" | priv tee "$REL/.outdir" >/dev/null
echo "Serving the folder: $OUTDIR"
`}${run('Running the release command (before going live)', cfg.releaseCmd)}${cfg.mode === 'service' ? `
step "Configuring service $UNIT"
printf %s ${shq(ctx.startSh)} > "$APP_DIR/shared/start.sh"; chmod 755 "$APP_DIR/shared/start.sh"
printf %s ${shq(ctx.unit)} > "$TMP/unit"
if ! priv cmp -s "$TMP/unit" "$UNIT_DIR/$UNIT" 2>/dev/null; then
  priv install -m 644 "$TMP/unit" "$UNIT_DIR/$UNIT"; priv systemctl daemon-reload
  echo "service file updated"
else echo "service file unchanged"; fi
` : ''}
step "Going live"
activate "$REL"; ACTIVATED=1
${cfg.mode === 'service' ? 'priv systemctl enable "$UNIT" >/dev/null 2>&1 || true\n' : ''}apply_release
if ! wait_healthy; then
  echo "!! Health check failed"
  ${cfg.mode === 'service' ? 'priv journalctl -u "$UNIT" -n 40 --no-pager 2>&1 || true' : 'true'}
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    step "Rolling back to $(basename "$PREV")"
    activate "$PREV"; apply_release || true
    if wait_healthy; then STATE=rolled_back; echo "@@STATE rolled_back"
    else echo "!! The previous release is not healthy either - the app is DOWN. Check the logs."; STATE=failed; echo "@@STATE failed"; fi
  else
    STATE=failed; echo "@@STATE failed"
  fi
  exit 1
fi
${cfg.afterCmd ? `\nstep ${shq('Running the after-deploy command')}\nREL="$APP_DIR/current"\nas_app ${shq(cfg.afterCmd)} || echo "(the after-deploy command failed; the release is live anyway)"\n` : ''}
step "Cleaning old releases (keeping $KEEP)"
cur=$(readlink "$APP_DIR/current")
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | sed 's#/$##' | tail -n +$((KEEP + 1)) | while read -r d; do
  if [ "$d" != "$cur" ] && [ "$d" != "$PREV" ]; then priv rm -rf -- "$d"; echo "removed $(basename "$d")"; fi
done
STATE=ok; echo "@@STATE ok"
echo; echo "Deployed $SHA"
`;
}

/** Point `current` (and `live`) at an existing release, apply, health-check. */
function rollbackScript(app, cfg, ctx) {
  return `${common(app, cfg, ctx)}REL=${shq(ctx.appDir + '/releases/' + ctx.release)}
[ -d "$REL" ] || { echo "release not found: $REL"; exit 1; }
PREV=$(readlink "$APP_DIR/current" 2>/dev/null || true)
step "Switching to ${ctx.release}"
activate "$REL"; ACTIVATED=1
echo "@@COMMIT $(cat "$REL/.release-commit" 2>/dev/null || echo unknown)"
${cfg.releaseCmd ? 'echo "Note: database changes made by earlier release commands (such as migrations) are NOT reverted by a rollback."\n' : ''}apply_release
if ! wait_healthy; then
  echo "!! Health check failed"
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    step "Restoring $(basename "$PREV")"
    activate "$PREV"; apply_release || true
    if wait_healthy; then STATE=rolled_back; echo "@@STATE rolled_back"
    else echo "!! The previous release is not healthy either - the app is DOWN. Check the logs."; STATE=failed; echo "@@STATE failed"; fi
  else STATE=failed; echo "@@STATE failed"; fi
  exit 1
fi
STATE=ok; echo "@@STATE ok"
`;
}

/** Write the app's env files and make them take effect (restart / reload + the preset's reload command). */
function envApplyScript(app, cfg, ctx) {
  if (cfg.mode === 'static') return 'echo "Static sites read their settings at build time: deploy again to apply environment changes."; echo "@@STATE failed"; exit 1\n';
  return `${common(app, cfg, ctx)}[ -d "$APP_DIR/current" ] || { echo "This app has not been deployed yet: deploy it first."; exit 1; }
REL=$(readlink -f "$APP_DIR/current")
step "Writing environment"
printf %s ${shq(ctx.envFile)} > "$TMP/env"; printf %s ${shq(ctx.envShell)} > "$TMP/envsh"
put "$TMP/env" "$APP_DIR/shared/.env" 600
put "$TMP/envsh" "$APP_DIR/shared/.env.sh" 600
${cfg.reloadCmd ? `step ${shq('Refreshing the application')}\nas_app ${shq(cfg.reloadCmd)} || echo "(refresh command failed)"\n` : ''}step "Applying"
apply_release
if wait_healthy; then STATE=ok; echo "@@STATE ok"; else echo "!! The app did not become healthy with this environment. Fix the values and apply again."; STATE=failed; echo "@@STATE failed"; exit 1; fi
`;
}

/** Remove an app's service (and optionally its files). */
function removeAppScript(app, ctx) {
  return `set -uo pipefail
USE_SUDO=${ctx.useSudo ? 1 : 0}
${PRIV}
${app.unit ? `UNIT=${shq(app.unit)}
priv systemctl stop "$UNIT" 2>/dev/null; priv systemctl disable "$UNIT" 2>/dev/null
priv rm -f ${shq(ctx.unitDir + '/' + app.unit)}; priv systemctl daemon-reload` : 'true'}
${ctx.deleteFiles ? `priv rm -rf -- ${shq(ctx.appDir)}` : 'true'}
echo done
`;
}

/** Shallow-clone a repository into a temp folder and report which framework preset matches. */
function detectRepoScript(app, ctx) {
  return `set -euo pipefail
export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=${ctx.allowLocalRepos ? 'https:ssh:file' : 'https:ssh'}
TMP=$(mktemp -d); trap 'rm -rf -- "$TMP"' EXIT
APP_DIR="$TMP"
command -v git >/dev/null || { echo "@@ERROR git is not installed on this server"; exit 0; }
${GIT_AUTH(app, ctx.secrets || {})}git clone --depth 1 --branch ${shq(ctx.ref)} -- ${shq(app.repoUrl)} "$TMP/src" >"$TMP/clone.log" 2>&1 || { echo "@@ERROR $(tail -3 "$TMP/clone.log" | tr '\\n' ' ' | head -c 300)"; exit 0; }
cd "$TMP/src"
echo "@@PRESET $(
${detectScript()}
)"
if [ -f composer.lock ] && command -v composer >/dev/null 2>&1 && command -v php >/dev/null 2>&1; then
  echo "@@PHPCHECK $(COMPOSER_ALLOW_SUPERUSER=1 composer check-platform-reqs --lock --no-dev --format=json 2>/dev/null | tr -d '\\n' | head -c 6000)"
fi
echo "@@PHPHAVE $(php -r 'echo PHP_VERSION;' 2>/dev/null || true)"
`;
}

const TOOLS_CHECK = `
ver() { "$@" 2>&1 | head -1; }
chk() { p=$(command -v "$1" 2>/dev/null) || { echo "$1=missing"; return; }; echo "$1=$2"; }
chk git "$(git --version 2>&1 | awk '{print $3}')"
chk node "$(node --version 2>&1 | head -1)"
chk npm "$(npm --version 2>&1 | head -1)"
chk nginx "$(nginx -v 2>&1 | head -1 | sed 's#.*/##' | awk '{print $1}')"
chk certbot "$(certbot --version 2>&1 | head -1 | awk '{print $2}')"
chk curl "$(curl --version 2>&1 | head -1 | awk '{print $2}')"
chk openssl "$(openssl version 2>&1 | head -1 | awk '{print $2}')"
chk java "$(java -version 2>&1 | head -1 | sed 's/.*"\\(.*\\)".*/\\1/')"
chk dotnet "$(dotnet --version 2>&1 | head -1)"
chk php "$(php -r 'echo PHP_VERSION;' 2>/dev/null)"
chk composer "$(composer --version 2>/dev/null | head -1 | awk '{print $3}')"
chk go "$(go version 2>&1 | awk '{print $3}')"
chk python3 "$(python3 --version 2>&1 | awk '{print $2}')"
chk mvn "$(mvn -v 2>&1 | head -1 | awk '{print $3}')"
echo "nginx_active=$(systemctl is-active nginx 2>/dev/null || echo inactive)"
echo "certbot_timer=$(systemctl is-active certbot-renew.timer 2>/dev/null || echo inactive)"
echo "fpm_unit=$(systemctl list-unit-files --type=service --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -E '^php.*fpm' | head -1)"
echo "fpm_user=$(ps -eo user:32,comm 2>/dev/null | awk '$2 ~ /php-fpm/ && $1 != "root" {print $1}' | sort -u | head -1)"
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

const COMPOSER_INSTALL = `step "Installing Composer (signature verified)"
EXPECTED=$(curl -fsSL https://composer.github.io/installer.sig)
curl -fsSL https://getcomposer.org/installer -o "$TMPC/installer.php"
ACTUAL=$(php -r "echo hash_file('sha384', '$TMPC/installer.php');")
[ "$EXPECTED" = "$ACTUAL" ] || { echo "Composer installer signature mismatch - aborting"; exit 1; }
priv php "$TMPC/installer.php" --quiet --install-dir=/usr/local/bin --filename=composer
priv ln -sf /usr/local/bin/composer /usr/bin/composer`;

/** Install prerequisites with dnf (Amazon Linux 2023). */
function installScript(tools, ctx) {
  const parts = [`set -euo pipefail
USE_SUDO=${ctx.useSudo ? 1 : 0}
${PRIV}
REPLACE_PHP=${ctx.replacePhp ? 1 : 0}
TMPC=$(mktemp -d); trap 'rm -rf "$TMPC"' EXIT
command -v dnf >/dev/null || { echo "dnf not found - this installer targets Amazon Linux 2023"; exit 1; }`];
  const want = (t) => tools.includes(t);
  if (want('git')) parts.push('step "Installing git"; priv dnf -y install git');
  if (want('node')) parts.push('step "Installing Node.js"; priv dnf -y install nodejs22 nodejs22-npm || priv dnf -y install nodejs20 nodejs20-npm');
  if (want('java')) parts.push('step "Installing Java (Amazon Corretto 21)"; priv dnf -y install java-21-amazon-corretto-devel');
  if (want('maven')) parts.push('step "Installing Maven"; priv dnf -y install maven-amazon-corretto21 || priv dnf -y install maven');
  if (want('dotnet')) parts.push('step "Installing .NET SDK 8"; priv dnf -y install dotnet-sdk-8.0');
  if (want('go')) parts.push('step "Installing Go"; priv dnf -y install golang');
  if (want('python')) parts.push('step "Installing Python"; priv dnf -y install python3 python3-pip');
  for (const [tool, ver] of [['php82', '8.2'], ['php', '8.3'], ['php84', '8.4']]) {
    if (!want(tool)) continue;
    parts.push(`step "Installing PHP ${ver} + PHP-FPM"
VER=${ver}
CUR=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;' 2>/dev/null || true)
if [ -n "$CUR" ] && [ "$CUR" != "$VER" ]; then
  echo "PHP $CUR is installed. Amazon Linux 2023 keeps one PHP version at a time, so this replaces it."
  # never remove anything unless the new version can actually be installed
  priv dnf -q list --available "php$VER" >/dev/null 2>&1 || { echo "!! PHP $VER packages are not available in this server's repositories (try installing all system updates first, then retry). Nothing was changed."; exit 1; }
  if [ "\${REPLACE_PHP:-0}" != 1 ]; then echo "!! Switching from PHP $CUR to $VER affects EVERY PHP site on this server. Confirm the switch in the panel and try again. Nothing was changed."; exit 1; fi
  echo "Replacing PHP $CUR with PHP $VER (PHP-FPM restarts briefly)..."
  priv systemctl stop php-fpm 2>/dev/null || true
  priv dnf -y remove "php$CUR*"
fi
priv dnf -y install php$VER php$VER-fpm php$VER-cli php$VER-common php$VER-mbstring php$VER-xml php$VER-mysqlnd php$VER-pdo php$VER-gd php$VER-intl php$VER-bcmath php$VER-opcache php$VER-process unzip
# nginx must be able to use the PHP-FPM socket
if [ -f /etc/php-fpm.d/www.conf ]; then
  priv sed -i -E 's/^;?(user|group|listen\\.owner|listen\\.group) = .*/\\1 = nginx/' /etc/php-fpm.d/www.conf
  priv sed -i -E 's#^;?listen\\.mode = .*#listen.mode = 0660#' /etc/php-fpm.d/www.conf
fi
priv systemctl enable php-fpm
priv systemctl restart php-fpm
echo "PHP $(php -r 'echo PHP_VERSION;') is ready; PHP-FPM runs as the nginx user and listens on /run/php-fpm/www.sock"`);
  }
  if (want('awscli')) {
    parts.push(`step "Installing the AWS CLI (for S3 backups)"
if command -v aws >/dev/null 2>&1; then echo "AWS CLI is already installed: $(aws --version 2>&1 | head -1)"; else priv dnf -y install awscli-2 2>/dev/null || priv dnf -y install awscli; fi
aws --version`);
  }
  if (want('mariadb')) {
    parts.push(`step "Installing MariaDB (local only)"
priv dnf -y install mariadb1011-server mariadb1011 || priv dnf -y install mariadb105-server mariadb105
printf '[mysqld]\\nbind-address=127.0.0.1\\n' > "$TMPC/panel.cnf"
priv mkdir -p /etc/my.cnf.d; priv install -m 644 "$TMPC/panel.cnf" /etc/my.cnf.d/panel.cnf
priv systemctl enable --now mariadb
# basic hardening: no anonymous accounts, no test database
priv mysql -e "DELETE FROM mysql.global_priv WHERE User=''; DROP DATABASE IF EXISTS test; FLUSH PRIVILEGES;" || true
echo "MariaDB listens on 127.0.0.1 only; the panel manages it through root's local socket, so no admin password is stored anywhere."`);
  }
  if (want('postgresql')) {
    parts.push(`step "Installing PostgreSQL (local only)"
priv dnf -y install postgresql16-server postgresql16 || priv dnf -y install postgresql15-server postgresql15
priv postgresql-setup --initdb || true
priv systemctl enable --now postgresql
echo "PostgreSQL listens on localhost only; the panel manages it as the postgres OS user, so no admin password is stored anywhere."`);
  }
  if (want('composer')) parts.push(`command -v php >/dev/null || { echo "Install PHP first"; exit 1; }\n${COMPOSER_INSTALL}`);
  if (want('nginx')) {
    parts.push(`step "Installing nginx"; priv dnf -y install nginx
priv mkdir -p ${shq(ctx.acmeRoot)}
priv systemctl enable --now nginx
echo "nginx enabled and started. Remember to allow inbound ports 80 and 443 in the security group."`);
  }
  if (want('certbot')) {
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
  detectRepoScript, installScript, TOOLS_CHECK,
};
