#!/usr/bin/env bash
# Install Server Panel on Amazon Linux 2023 (the machine that RUNS the panel).
#
#   sudo ./deploy/install-al2023.sh [--manage-local [--with-cron] [--with-docker]]
#
# By default the panel only manages remote servers that you add in the UI with an address and an
# SSH key (.pem / .ppk). Nothing is granted on this machine itself.
#
#   --manage-local  ALSO let the panel manage this machine: enables PANEL_ENABLE_LOCAL and installs
#                   narrow sudoers rules (systemctl, journalctl, dnf) for the 'panel' user
#   --with-cron     (with --manage-local) install + enable cronie so the Cron page works here
#   --with-docker   (with --manage-local) install Docker and let the panel user use it
#
# Re-running upgrades the code in /opt/server-panel and keeps /var/lib/server-panel (users, servers, audit log).
set -euo pipefail

MANAGE_LOCAL=0; WITH_CRON=0; WITH_DOCKER=0
for a in "$@"; do
  case "$a" in
    --manage-local) MANAGE_LOCAL=1 ;;
    --with-cron) WITH_CRON=1 ;;
    --with-docker) WITH_DOCKER=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
if [ "$MANAGE_LOCAL" -eq 0 ] && { [ "$WITH_CRON" -eq 1 ] || [ "$WITH_DOCKER" -eq 1 ]; }; then
  echo "--with-cron / --with-docker only apply together with --manage-local" >&2; exit 2
fi

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }

. /etc/os-release
if [ "${ID:-}" != "amzn" ] || [ "${VERSION_ID:-}" != "2023" ]; then
  echo "WARNING: this installer targets Amazon Linux 2023 (found: ${PRETTY_NAME:-unknown})." >&2
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/server-panel
DATA=/var/lib/server-panel
ENVFILE=/etc/server-panel.env

echo "==> Installing Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  dnf install -y nodejs22 || dnf install -y nodejs20
fi
NODE_BIN="$(command -v node)"
echo "    using $NODE_BIN ($(node -v))"

echo "==> Creating service user"
id panel >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /sbin/nologin panel
install -d -o panel -g panel -m 0700 "$DATA"

echo "==> Copying application to $APP"
install -d -m 0755 "$APP"
# Dependencies are vendored in node_modules/ (no npm, no network access needed)
cp -a "$SRC/server" "$SRC/public" "$SRC/node_modules" "$SRC/package.json" "$APP/"
[ -d "$APP/node_modules/ssh2" ] || { echo "node_modules/ssh2 missing from the checkout" >&2; exit 1; }
chown -R root:root "$APP"

if [ ! -f "$ENVFILE" ]; then
  echo "==> Writing $ENVFILE"
  cat > "$ENVFILE" <<EOF
# Server Panel configuration — see README for all options
PANEL_HOST=127.0.0.1
PANEL_PORT=8080
PANEL_DATA_DIR=$DATA
# Set to true once you serve the panel over HTTPS:
#PANEL_SECURE_COOKIES=true
EOF
  chmod 0640 "$ENVFILE"; chgrp panel "$ENVFILE"
fi

# Encrypt stored SSH keys with a secret that lives OUTSIDE the data directory (so a copy of
# /var/lib/server-panel alone is useless). Never add one if keys were already encrypted with master.key.
if ! grep -q '^PANEL_SECRET=' "$ENVFILE" && [ ! -f "$DATA/master.key" ]; then
  echo "==> Generating PANEL_SECRET (back up $ENVFILE: without it stored SSH keys cannot be decrypted)"
  printf 'PANEL_SECRET=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENVFILE"
fi

if [ "$MANAGE_LOCAL" -eq 1 ]; then
  echo "==> Enabling management of this machine"
  grep -q '^PANEL_ENABLE_LOCAL=' "$ENVFILE" || echo 'PANEL_ENABLE_LOCAL=true' >> "$ENVFILE"
  sed -i 's/^PANEL_ENABLE_LOCAL=.*/PANEL_ENABLE_LOCAL=true/' "$ENVFILE"
  usermod -aG systemd-journal panel 2>/dev/null || true

  if [ "$WITH_CRON" -eq 1 ]; then
    echo "==> Installing cronie"
    dnf install -y cronie
    systemctl enable --now crond
  fi
  if [ "$WITH_DOCKER" -eq 1 ]; then
    echo "==> Installing Docker"
    dnf install -y docker
    systemctl enable --now docker
    usermod -aG docker panel
  fi

  echo "==> Installing sudoers rules (/etc/sudoers.d/server-panel)"
  SYSTEMCTL="$(command -v systemctl)"; JOURNALCTL="$(command -v journalctl)"; DNF="$(command -v dnf)"
  TMP="$(mktemp)"
  cat > "$TMP" <<EOF
# Server Panel: narrow privilege delegation for managing THIS machine. Anyone who is a panel *admin*
# can therefore start/stop/enable system services, read the journal and run dnf upgrades as root.
Defaults:panel !requiretty
panel ALL=(root) NOPASSWD: $SYSTEMCTL start *, $SYSTEMCTL stop *, $SYSTEMCTL restart *, $SYSTEMCTL reload *, $SYSTEMCTL enable *, $SYSTEMCTL disable *
panel ALL=(root) NOPASSWD: $JOURNALCTL --no-pager *
panel ALL=(root) NOPASSWD: $DNF -y upgrade, $DNF -y upgrade *
EOF
  visudo -cf "$TMP" >/dev/null
  install -m 0440 -o root -g root "$TMP" /etc/sudoers.d/server-panel
  rm -f "$TMP"
fi

echo "==> Installing systemd unit"
install -m 0644 "$SRC/deploy/server-panel.service" /etc/systemd/system/server-panel.service
sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN $APP/server/index.js#" /etc/systemd/system/server-panel.service
systemctl daemon-reload
systemctl enable server-panel >/dev/null
systemctl restart server-panel
sleep 2

PORT="$(sed -n 's/^PANEL_PORT=//p' "$ENVFILE" | tail -1)"; PORT="${PORT:-8080}"
echo
systemctl --no-pager --lines=0 status server-panel | sed -n '1,3p'
echo
TOKEN="$(journalctl -u server-panel --no-pager -n 50 -o cat | sed -n 's/^Setup token: //p' | tail -1 || true)"
if [ -n "$TOKEN" ]; then
  echo "First-run setup token:  $TOKEN"
  echo "(also visible with: sudo journalctl -u server-panel | grep 'Setup token')"
fi
cat <<EOF

The panel listens on 127.0.0.1:$PORT only. Reach it through a tunnel from your workstation:

  SSH:  ssh -L $PORT:127.0.0.1:$PORT ec2-user@<this-instance-ip>
  SSM:  aws ssm start-session --target <this-instance-id> \\
          --document-name AWS-StartPortForwardingSession \\
          --parameters '{"portNumber":["$PORT"],"localPortNumber":["$PORT"]}'

then browse to http://localhost:$PORT, create the admin account and use "Servers → Add server"
to connect the machines you want to manage (address + .pem/.ppk key). Each managed server must allow
SSH from THIS machine (security group inbound rule for port 22 from this instance's IP / security group).
EOF
