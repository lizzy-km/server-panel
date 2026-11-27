#!/usr/bin/env bash
# Install Server Panel on Amazon Linux 2023.
#
#   sudo ./deploy/install-al2023.sh [--with-cron] [--with-docker] [--no-sudo]
#
#   --with-cron    install + enable cronie (AL2023 does not ship it) so the Cron page works
#   --with-docker  install Docker and let the panel user talk to it
#   --no-sudo      do not install the sudoers rules (panel then cannot control services / run dnf)
#
# Re-running upgrades the code in /opt/server-panel and keeps /var/lib/server-panel (users, audit log).
set -euo pipefail

WITH_CRON=0; WITH_DOCKER=0; WITH_SUDO=1
for a in "$@"; do
  case "$a" in
    --with-cron) WITH_CRON=1 ;;
    --with-docker) WITH_DOCKER=1 ;;
    --no-sudo) WITH_SUDO=0 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

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

if [ "$WITH_CRON" -eq 1 ]; then
  echo "==> Installing cronie"
  dnf install -y cronie
  systemctl enable --now crond
fi

echo "==> Creating service user"
id panel >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /sbin/nologin panel
install -d -o panel -g panel -m 0700 "$DATA"

if [ "$WITH_DOCKER" -eq 1 ]; then
  echo "==> Installing Docker"
  dnf install -y docker
  systemctl enable --now docker
  usermod -aG docker panel
fi
# let the panel read the journal without sudo as well
usermod -aG systemd-journal panel 2>/dev/null || true

echo "==> Copying application to $APP"
install -d -m 0755 "$APP"
cp -a "$SRC/server" "$SRC/public" "$SRC/package.json" "$APP/"
chown -R root:root "$APP"

if [ ! -f "$ENVFILE" ]; then
  echo "==> Writing $ENVFILE"
  cat > "$ENVFILE" <<EOF
# Server Panel configuration — see README for all options
PANEL_HOST=127.0.0.1
PANEL_PORT=8080
PANEL_DATA_DIR=$DATA
# Root of the file manager (the panel user must be able to read/write what you want to manage):
#PANEL_FILES_ROOT=/home/ec2-user
# Set to true once you serve the panel over HTTPS:
#PANEL_SECURE_COOKIES=true
EOF
  chmod 0640 "$ENVFILE"; chgrp panel "$ENVFILE"
fi

if [ "$WITH_SUDO" -eq 1 ]; then
  echo "==> Installing sudoers rules (/etc/sudoers.d/server-panel)"
  SYSTEMCTL="$(command -v systemctl)"; JOURNALCTL="$(command -v journalctl)"; DNF="$(command -v dnf)"
  TMP="$(mktemp)"
  cat > "$TMP" <<EOF
# Server Panel: narrow privilege delegation. Anyone who is a panel *admin* can therefore
# start/stop/enable system services, read the journal and run dnf upgrades as root.
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

The panel listens on 127.0.0.1:$PORT only. Do NOT open that port in your security group.
Reach it through a tunnel from your workstation:

  SSH:  ssh -L $PORT:127.0.0.1:$PORT ec2-user@<instance-ip>
  SSM:  aws ssm start-session --target <instance-id> \\
          --document-name AWS-StartPortForwardingSession \\
          --parameters '{"portNumber":["$PORT"],"localPortNumber":["$PORT"]}'

then browse to http://localhost:$PORT
EOF
