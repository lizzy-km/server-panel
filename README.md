# Server Panel

A self-hosted server control panel with **zero npm dependencies** (Node ≥ 20, vanilla JS frontend, no build step).

| Area | What you get |
|---|---|
| **Dashboard** | Live CPU (total + per-core), memory/swap, network throughput charts, disk usage, system info, threshold alerts |
| **Processes** | Sortable/filterable process list; send SIGTERM/SIGKILL (admin) |
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

## Quick start

```bash
node server/index.js
```

On first run the console prints a **setup token**. Open `http://127.0.0.1:8080`, enter the token and create the admin account.

```bash
npm test   # 16 tests: API, auth, permissions, path-escape and injection checks
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PANEL_HOST` | `127.0.0.1` | Bind address |
| `PANEL_PORT` | `8080` | Port |
| `PANEL_DATA_DIR` | `./data` | Users, sessions, audit log (mode 0600) |
| `PANEL_FILES_ROOT` | `$HOME` | File manager root — nothing outside it is reachable, symlinks included |
| `PANEL_LOG_DIRS` | `/var/log` | Comma-separated directories the log viewer may read |
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
public/                single-page UI (app.js, style.css, index.html)
test/panel.test.js     integration + unit tests (node:test)
```

## Running as a service

```ini
# /etc/systemd/system/server-panel.service
[Service]
User=panel
WorkingDirectory=/opt/server-panel
Environment=PANEL_DATA_DIR=/var/lib/server-panel PANEL_SECURE_COOKIES=true
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```
