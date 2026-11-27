# Server Panel

A self-hosted server control panel for **Amazon Linux 2023** (EC2), with **zero npm dependencies** (Node ≥ 20, vanilla JS frontend, no build step).
It also runs on other systemd-based Linux distributions; the dnf/EC2 pieces simply show a notice elsewhere.

| Area | What you get |
|---|---|
| **Dashboard** | Live CPU (total + per-core), memory/swap, network throughput charts, disk usage, system info, threshold alerts |
| **Processes** | Sortable/filterable process list; send SIGTERM/SIGKILL (admin) |
| **Updates** | `dnf` updates with security advisories (ALAS), reboot-required notice, update one package / security-only / all |
| **EC2** | Instance ID, type, zone, public IP and AMI on the dashboard (IMDSv2) |
| **Services** | systemd units: state, enable/disable, start/stop/restart, `systemctl status` |
| **Docker** | Containers (state, CPU, memory, ports) and images; start/stop/restart/remove, logs |
| **Network** | Interfaces and listening sockets with owning process |
| **Files** | Browse, edit (Ctrl+S), upload (drag & drop), download, rename, chmod, delete — confined to a root directory |
| **Logs** | journald (by unit/priority) and log files, with text filter and follow mode |
| **Cron** | View/edit the panel user's crontab with validation |
| **Terminal** | One-shot command runner with history, timeouts, output caps |
| **Users** | `admin` (full control) and `viewer` (read-only monitoring) roles |
| **Audit log** | Every login, failed login and state-changing action |

Features that need a missing tool (systemd, Docker, `ss`, `crontab`) degrade to an explanatory notice instead of failing.

## Install on Amazon Linux 2023

```bash
sudo dnf install -y git
git clone https://github.com/lizzy-km/server-panel && cd server-panel
sudo ./deploy/install-al2023.sh --with-cron      # add --with-docker if you use Docker
```

The installer installs Node.js (`nodejs22`, falling back to `nodejs20`), creates an unprivileged `panel` user, copies the app to
`/opt/server-panel`, keeps data in `/var/lib/server-panel`, writes `/etc/server-panel.env`, installs a systemd unit
and prints the first-run setup token. Re-run it to upgrade; users and the audit log are preserved.

The panel listens on `127.0.0.1:8080` only. **Do not open the port in your security group.** Use a tunnel:

```bash
# SSH
ssh -L 8080:127.0.0.1:8080 ec2-user@<instance-ip>
# or SSM Session Manager (no inbound ports at all)
aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}'
```

Then open <http://localhost:8080>. To serve it publicly, put it behind an ALB or nginx/Caddy with TLS and set `PANEL_SECURE_COOKIES=true`.

### AL2023 specifics

- **Privileges:** the panel runs as `panel`, not root. The installer adds a sudoers drop-in so it can `systemctl start|stop|restart|reload|enable|disable`, read the journal and run `dnf -y upgrade`. Treat panel *admins* as having those root powers (and, through `dnf upgrade`/`systemctl`, effectively root-equivalent). Skip it with `--no-sudo` for a read-only panel; set `PANEL_USE_SUDO=false` to never try sudo.
- **Do not add `NoNewPrivileges=true`** to the unit — it disables sudo.
- **Cron:** AL2023 does not ship `cronie`; use `--with-cron` or `sudo dnf install -y cronie && sudo systemctl enable --now crond`. The Cron page shows this hint when `crontab` is missing.
- **Logs:** AL2023 logs to the systemd journal (no `/var/log/messages`); the Logs page defaults to it. `dnf.log` and `cloud-init*.log` are under `/var/log`; `/var/log/audit` is root-only.
- **Docker:** `--with-docker` installs Docker and adds `panel` to the `docker` group (equivalent to root on the host — only enable it if you need it).
- **EC2 metadata:** read via IMDSv2. If the panel is containerised, raise the instance's metadata hop limit to 2 or the EC2 rows are simply omitted.
- **Updates page:** `needs-restarting -r` (package `dnf-utils`) powers the reboot notice; without it the notice is skipped.

## Quick start (any host, for development)

```bash
node server/index.js
```

On first run the console prints a **setup token**. Open `http://127.0.0.1:8080`, enter the token and create the admin account.

```bash
npm test   # 19 tests: API, auth, permissions, path-escape and injection checks
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PANEL_HOST` | `127.0.0.1` | Bind address |
| `PANEL_PORT` | `8080` | Port |
| `PANEL_DATA_DIR` | `./data` | Users, sessions, audit log (mode 0600) |
| `PANEL_FILES_ROOT` | `$HOME` | File manager root — nothing outside it is reachable, symlinks included |
| `PANEL_LOG_DIRS` | `/var/log` | Comma-separated directories the log viewer may read |
| `PANEL_USE_SUDO` | `true` | Use `sudo -n` for systemctl/journalctl/dnf when not root (falls back to direct execution) |
| `PANEL_ENABLE_EXEC` | `true` | Set `false` to disable the Terminal page entirely |
| `PANEL_SECURE_COOKIES` | `false` | Set `true` behind HTTPS |
| `PANEL_SESSION_HOURS` | `12` | Session lifetime |
| `PANEL_MAX_UPLOAD_MB` | `200` | Upload limit |
| `PANEL_SAMPLE_MS` / `PANEL_HISTORY` | `3000` / `200` | Metrics interval / points kept |

## Security model — read this before exposing it

This tool can restart services, delete files and run commands as the user it runs under. Treat it like SSH.

- **Binds to localhost by default.** To reach it remotely, put it behind a TLS reverse proxy (nginx/Caddy) or an SSH tunnel (`ssh -L 8080:127.0.0.1:8080 host`) and set `PANEL_SECURE_COOKIES=true`.
- **Run it as an unprivileged user** and grant only what you need (e.g. a sudoers rule for `systemctl`); the panel never escalates privileges itself.
- Passwords are scrypt-hashed (min 10 chars); sessions are random 256-bit tokens stored hashed, `HttpOnly` + `SameSite=Strict`; changing/resetting a password revokes sessions.
- State-changing requests require a custom header and a same-origin `Origin` (CSRF). A strict CSP forbids inline scripts/styles, and the UI never uses `innerHTML`.
- Login is throttled per IP (lockout from the 5th failure). First-run setup needs the console token, so a stranger cannot claim a fresh install.
- Anything that shells out uses `execFile` with validated arguments (unit names, container IDs, signals); only the Terminal page runs arbitrary shell, admin-only and audited.
- Viewers cannot access Files, Logs, Cron, Terminal, Users or Audit.

## Layout

```
server/index.js        HTTP server, routing, auth/CSRF pipeline
server/lib/auth.js     users, scrypt, sessions, throttling
server/lib/sys.js      metrics sampler, disks, processes, sockets
server/lib/ops.js      services, docker, files, logs, cron, command runner
server/lib/pkg.js      dnf updates / upgrades
server/lib/aws.js      EC2 instance metadata (IMDSv2)
deploy/                AL2023 installer + systemd unit
public/                single-page UI (app.js, style.css, index.html)
test/panel.test.js     integration + unit tests (node:test)
```

## Running as a service

`deploy/server-panel.service` is the unit the installer uses. `PANEL_USE_SUDO` (default `true` when not root) controls the sudo escalation described above.
