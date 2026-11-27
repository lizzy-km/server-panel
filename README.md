# Server Panel

A self-hosted control panel that manages **Amazon Linux 2023** (EC2) servers **over SSH**. You give it a server address and
the SSH key (`.pem` or PuTTY `.ppk`); it connects and gives you monitoring, services, updates, Docker, files, logs, cron
and a terminal for that machine. Add as many servers as you like and switch between them.

**Design rule: everything is a button.** You should never have to type a command to run your servers. Commands exist only under “Advanced” overrides for unusual apps. Node ≥ 20, vanilla-JS frontend, no build step. The one runtime dependency (`ssh2` and its 4 small pure-JavaScript dependencies, 2 MB) is **vendored in `node_modules/`**, so there is nothing to install: clone and run.

| Area | What you get (per server) |
|---|---|
| **Dashboard** | Live CPU (total + per-core), memory/swap, network throughput, disks, system info, EC2 instance details (IMDSv2), threshold alerts |
| **Processes** | Sortable/filterable list; send SIGTERM/SIGKILL (admin) |
| **Deploy** | Any framework from Git (React, Vue, Angular, Next.js, Nest, Express, Spring Boot, .NET, Laravel/PHP, Go, Python, plain HTML…): pick it from a list (or let the panel detect it), then clone → build → zero-downtime switch → health check → **automatic rollback**; live deploy log, history, one-click rollback, `.env` editor, webhook auto-deploy, one-click install of the runtimes it needs |
| **Domains** | nginx virtual hosts for apps / URLs / static sites, **Let's Encrypt** certificates with auto-renewal, DNS checks (3 resolvers, A/AAAA/CNAME/NS/MX/TXT/CAA), HTTP/HTTPS checks including *direct-to-server* before DNS cut-over, **editable nginx config** (per domain and `nginx.conf` / `conf.d`) |
| **Services** | systemd units: state, enable/disable, start/stop/restart, `systemctl status` |
| **Updates** | `dnf` updates with security advisories (ALAS), reboot-required notice; update one package / security-only / all |
| **Docker** | Containers (state, CPU, memory, ports) and images; start/stop/restart/remove, logs |
| **Network** | Interfaces and listening sockets with owning process |
| **Files** | Browse, edit (Ctrl+S), upload (drag & drop), download, rename, chmod, delete over SFTP, confined to a root folder |
| **Logs** | journald (by unit/priority) and `/var/log` files, text filter, follow mode |
| **Cron** | View/edit the SSH user's crontab with validation |
| **Terminal** | One-shot command runner with history, timeouts, output caps |
| **Servers** | Add/test/edit/remove servers, host-key pinning, key replacement |
| **Users / Audit** | `admin` (full control) and `viewer` (read-only monitoring) roles; every login and action is logged with the server it touched |

## Quick start

**Windows / macOS:** double-click **`Start Server Panel.bat`** (macOS/Linux: `start-panel.sh`). It starts the panel, opens your browser and fills in the one-time setup token for you. You only need [Node.js 20+](https://nodejs.org) installed.

```bash
node server/launch.js         # same thing from a terminal; `node server/index.js` prints the setup token instead
```

Open <http://127.0.0.1:8080>, enter the setup token and create the admin account, then **Servers → Add server**.

```bash
npm test    # 127 tests: unit tests + end-to-end SSH/SFTP/deploy/nginx/PHP/Go/Java tests against a real sshd (skipped if sshd isn't installed)
```

## Adding a server

You need: the server's **address** (public DNS / IP), the **username** (`ec2-user` on Amazon Linux), and the **private key** file.

1. **Servers → Add server**, fill in name / address / port / username, choose the key file (or paste it), add the passphrase if it has one.
2. The panel connects *without logging in* and shows the server's **host key fingerprint**. Verify it matches your server
   (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` via SSM / the EC2 console, or the "SSH HOST KEY FINGERPRINTS" block in the
   instance's system log), tick the box, and continue. The fingerprint is **pinned**: if it ever changes (instance rebuilt, or
   someone intercepting the connection) the panel refuses to connect until an admin re-verifies it.
3. The panel logs in, checks the user and whether passwordless sudo works, and only then saves the server.

**Supported key formats** (use whatever you have — `.pem` from AWS or `.ppk` from PuTTYgen)

| Format | Support |
|---|---|
| AWS `.pem` (RSA), OpenSSH private keys (RSA / ECDSA / Ed25519), with or without passphrase | ✅ |
| PuTTY `.ppk` v2 and v3 (RSA / ECDSA / Ed25519), with or without passphrase — including PuTTYgen's default v3 + Argon2id | ✅ |
| Public keys (`.pub`) | ❌ rejected with a clear message |

PuTTY v3 keys with a passphrase are decrypted with a built-in pure-JavaScript Argon2 (Node 22 has none), run in a worker thread; PuTTYgen's
default settings take about 2 seconds, once, when you add the server. The key is then stored (encrypted) in converted form, so later
connections are instant. The Argon2 code is verified against the RFC 9106 test vector and an independent reference implementation.

**What the target server needs** (all true by default on Amazon Linux 2023): `sshd` reachable from the panel on the SSH port
(security group inbound rule for port 22 from the panel's IP or security group); for service control, journal access and
`dnf upgrade` the SSH user needs passwordless `sudo` (`ec2-user` has it). Without sudo the panel still works read-only where possible
(monitoring, process list, service list, files you own). Optional: `cronie` (Cron page), Docker, `dnf-utils` (reboot notice).
Servers reachable only through SSM Session Manager (no SSH port at all) are **not** supported.

## Deploying apps (any framework)

**New app → paste the Git repository → Detect framework** (or pick one from the list). The panel fills in the build, start, serving and health settings.
If the server lacks something the framework needs (Node.js, Java, .NET, PHP, Composer, Go, Python…), the form shows it and offers a one-click **Install**.

| Framework | Runs as | What the panel does |
|---|---|---|
| React / Vue / Angular / Vite, plain HTML | **static files** | build, find the output folder (`dist`, `build`, `out`, Angular's `dist/<app>/browser`…), nginx serves it with client-side-routing fallback; no process |
| Next.js, Nuxt, NestJS, Express / Fastify / any Node server | **service** | install, build, run as a systemd service on its own port behind nginx |
| Spring Boot (Maven / Gradle) | **service** | build the jar (wrapper if present), `java -jar` on the assigned port |
| .NET / ASP.NET Core | **service** | `dotnet publish`, run the published app on the assigned port |
| Go, Python (Django / Flask / FastAPI), custom | **service** | build / virtualenv, run your start command on the assigned port |
| Laravel, plain PHP / WordPress | **PHP-FPM** | `composer install`, optional asset build, shared `storage/`, database migrations *before* going live, PHP-FPM reload; files and artisan run as the web user |

Each deploy, on the server: clones the branch into a fresh `releases/<timestamp>` folder (no `.git` kept), writes the `.env`, links shared folders, installs and builds (with the `.env` loaded), runs the release command (for Laravel: migrations; **a failure cancels the deploy before anything changes**), then atomically switches `current` (and `live` for static/PHP apps), restarts or reloads, and health-checks.
**If the check fails it switches back to the previous release and verifies that one is healthy**: the deploy is reported as *rolled back* (or *failed* if the old version is down too, never silently "fine"). Old releases are pruned (default keep 5, never the live or previous one). A failed clone/install/build never touches what is live; one deploy per app at a time; every deploy keeps its log; **Releases** rolls back to any kept release (database changes are *not* reverted, and the log says so).
Layout: `/srv/apps/<name>/{releases/, shared/{.env,storage…}, current, live}` (configurable). Build caches live in `shared/home` so repeat builds are fast.

Health check: services over HTTP on their port (any answer below 500 by default, or strict 2xx/3xx); static sites check that the build produced an index file; PHP apps check through nginx if you give a health host name, otherwise that `index.php` exists.

**Secrets** (git token / deploy key, env values) are encrypted in the panel's store and reach the server only inside the script sent over the SSH channel's stdin (never in a process command line); the deploy key and token helper exist only in a private temp directory for the duration of the clone. SSH deploy keys use `StrictHostKeyChecking=accept-new` (trust on first use) for the git host.

**Environment (.env) editor:** admins can **Reveal & edit** the whole file as `NAME=value` text (quotes, `#` and newlines are handled), then **Save** (next deploy) or **Save & apply now** (writes the file and restarts the service / reloads PHP-FPM and refreshes Laravel's config cache; for static sites **Save & redeploy**, because they read variables at build time). You are told if the app does not come back healthy. Revealing values is audited; viewers only see variable names; values are never written to the audit log. `PORT` and `NODE_ENV` are set by the panel.

**Webhook auto-deploy:** enable it on the app page to get a URL + secret. GitHub (push event, `application/json`, HMAC-SHA256 signature) or any CI triggers a deploy of the app's branch; other branches/events are ignored, calls are rate-limited, rotating the secret invalidates the old one. The panel must be reachable from the internet at that URL (set `PANEL_PUBLIC_URL` behind a reverse proxy and expose only `/api/hooks/`).

### Already running something? Adopt it as it is

- **Existing nginx sites:** *Domains* lists hand-written nginx files it finds and offers **Add to panel**. The file is kept byte for byte (same name, same content): you get DNS and HTTPS checks, certificate status and a validated editor. Nothing is rewritten or duplicated; removing it from the panel leaves the file alone unless you ask to delete it.
- **Existing Laravel apps:** *Deploy → PHP / Laravel apps → Add existing app* reads the app without running it (versions, git state, `.env` highlights without secrets, PHP-FPM user, queue workers, scheduler) and flags problems (debug on in production, missing vendor, storage owned by the wrong user, no queue worker…). Then: maintenance mode, a fixed list of safe artisan commands (clear/cache config, queue restart, migrate status/run…) always run as the owner of `storage/` so cache and log files keep the right owner, log viewer with filter, and a raw `.env` editor (comments and order kept, backup `.env.panel-bak`, owner and mode unchanged, `APP_KEY` removal needs confirmation). Destructive commands (`migrate:fresh`, rollback, `db:wipe`, `db:seed`) are deliberately not offered.
- When you are ready, create a normal app from the same repository to move to panel-managed releases, health checks and rollback.

## Domains, HTTPS and nginx

**Domains → Add domain** creates `/etc/nginx/conf.d/panel-<domain>.conf` (reverse proxy to an app or URL, or static files with optional SPA fallback), validates it with `nginx -t`
(a rejected config is rolled back byte for byte) and reloads nginx. Websockets work, large uploads are configurable, IPv6 listeners are only emitted on hosts that have IPv6.

**Checks** (Overview tab): DNS from the system resolver plus Cloudflare and Google (flags wrong IPs, missing records, propagation differences, AAAA that would break visitors, CAA that blocks Let's Encrypt),
HTTP/HTTPS status, redirects, certificate trust/expiry/name coverage, and the same tests *directly against the server's IP*, so you can verify a new site before pointing DNS at it.

**HTTPS:** *Issue certificate* runs certbot (webroot validation on port 80), then rewrites the site with a TLS server block and an HTTP→HTTPS redirect. Staging mode for test runs, *Renew now*, *Remove certificate*.
Renewal is automatic through the `certbot-renew.timer` the panel installs (twice a day, reloads nginx via a deploy hook). A failed request changes nothing.

**Editing nginx:**
- *Per domain:* use the settings and "custom directives", or **Edit full config manually** to own the whole file (manual mode; switch back any time).
- *Server-wide:* **Edit config files…** opens `nginx.conf` and every file in `conf.d` (create / edit / delete); panel-generated files are shown read-only.
- Every save is written, checked with `nginx -t`, and reloaded; on failure the previous content is restored and nginx's error is shown. A `.panel-bak` copy of the previous version is kept.

Requirements on the managed server: the SSH user needs **passwordless sudo** (default for `ec2-user`) for services, nginx and certbot; ports 80/443 open in the security group; DNS pointing at the instance (Elastic IP recommended).
`PANEL_PHP_SOCKET` (default `unix:/run/php-fpm/www.sock`) sets the PHP-FPM socket nginx talks to. `PANEL_ENABLE_LOCAL` (managing the panel's own host with the limited sudoers rules from `--manage-local`) does not cover deploy/domains, which need broader sudo: manage hosts over SSH instead.

## Install the panel on Amazon Linux 2023

```bash
sudo dnf install -y git
git clone https://github.com/lizzy-km/server-panel && cd server-panel
sudo ./deploy/install-al2023.sh
```

The installer installs Node.js, creates an unprivileged `panel` user, installs the app to `/opt/server-panel`, stores data in
`/var/lib/server-panel`, generates a `PANEL_SECRET` in `/etc/server-panel.env`, installs a systemd unit and prints the setup token.
Re-run it to upgrade; users, servers and the audit log are preserved. Put the panel in the same VPC as the servers it manages and use
their private IPs where you can.

The panel listens on `127.0.0.1:8080` only — reach it with a tunnel (`ssh -L 8080:127.0.0.1:8080 ec2-user@<panel-ip>`, or an SSM
port-forward), or put it behind an ALB / nginx / Caddy with TLS and set `PANEL_SECURE_COOKIES=true`.

`--manage-local` additionally lets the panel manage **the machine it runs on** (sets `PANEL_ENABLE_LOCAL=true` and installs narrow
sudoers rules for `systemctl`, `journalctl` and `dnf`); `--with-cron` / `--with-docker` set those up there. It is off by default because the
panel is meant to manage remote servers.

## Vendored dependencies

`node_modules/` is committed on purpose (so installs work on networks that block npm and the exact audited versions are what runs):
`ssh2` 1.17.0, `asn1` 0.2.6, `bcrypt-pbkdf` 1.0.2, `safer-buffer` 2.1.2, `tweetnacl` 0.14.5 — licenses are in each package folder
(MIT / BSD-3-Clause / Unlicense). To update: `npm install ssh2@<version> --omit=optional --ignore-scripts`, then delete what must not be committed —
`rm -rf node_modules/ssh2/test node_modules/ssh2/examples node_modules/ssh2/util node_modules/ssh2/lib/protocol/crypto/build node_modules/.package-lock.json`
(ssh2's test fixtures contain sample private keys that GitHub's secret scanning blocks; `util/` holds a Pageant test `.exe` this panel never uses; the rest is build leftovers) — run `npm test`
(`test/vendor.test.js` fails if key material, binaries or version drift sneak in) and commit. ssh2 runs on its pure-JavaScript crypto; no native build is used or needed.
`.gitattributes` keeps these files byte-identical on Windows (no line-ending conversion).

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PANEL_HOST` / `PANEL_PORT` | `127.0.0.1` / `8080` | Bind address / port |
| `PANEL_DATA_DIR` | `./data` | Users, servers, encrypted keys, audit log (mode 0600) |
| `PANEL_SECRET` | *(unset)* | Encrypts stored SSH keys. If unset, a random key is kept in `<data>/master.key` |
| `PANEL_ENABLE_LOCAL` | `false` | Also manage the machine the panel runs on |
| `PANEL_FILES_ROOT` | `$HOME` | File-manager root for the local host (remote servers have their own root) |
| `PANEL_LOG_DIRS` | `/var/log` | Directories the log viewer may read (on the target) |
| `PANEL_ENABLE_EXEC` | `true` | Set `false` to disable the Terminal page entirely |
| `PANEL_USE_SUDO` | `true` | Local host only: use `sudo -n` when not root |
| `PANEL_SECURE_COOKIES` | `false` | Set `true` behind HTTPS |
| `PANEL_PUBLIC_URL` | *(request host)* | Base URL shown for webhook URLs (set behind a reverse proxy) |
| `PANEL_SESSION_HOURS` | `12` | Session lifetime |
| `PANEL_MAX_UPLOAD_MB` | `200` | Upload limit |
| `PANEL_SAMPLE_MS` / `PANEL_HISTORY` | `3000` / `200` | Metrics interval / points kept (sampling only runs while someone is viewing a server) |

Paths on the managed servers can be changed with `PANEL_APPS_DIR` (`/srv/apps`), `PANEL_UNIT_DIR`, `PANEL_NGINX_CONF_DIR`, `PANEL_NGINX_LOG_DIR`, `PANEL_NGINX_CONF`, `PANEL_LETSENCRYPT_DIR`, `PANEL_ACME_ROOT` (mainly for tests).
`PANEL_ALLOW_LOCAL_REPOS=true` permits `file://` repositories (tests only; leave off).

## Security model — read this before exposing it

This tool holds SSH keys to your servers and can restart services, delete files and run commands on them. Protect it like a bastion host.

- **SSH keys are encrypted at rest** (AES-256-GCM) and are **never returned by the API** or shown again after upload. With `PANEL_SECRET`
  (set by the installer, stored in `/etc/server-panel.env`, outside the data dir) a copy of the data directory alone is useless; with only
  `master.key` it protects against leaking `panel.json` by itself, not against someone who can read the whole data directory. **Back up
  `PANEL_SECRET`** — without it stored keys cannot be decrypted (you would re-add the servers).
- **Host keys are pinned** by SHA-256 fingerprint after you verify them; mismatches are refused (no silent trust-on-first-use after setup).
- **Use dedicated, least-privilege keys.** Anyone who is a panel *admin* can run commands on every managed server as that SSH user; a
  compromise of the panel host equals a compromise of those keys. Prefer a dedicated key pair per panel, restrict port 22 on the targets
  to the panel's IP/security group, and rotate via *Edit → Replace SSH key*.
- Admins can make the panel connect to any host:port it can reach (that is the feature); don't give the admin role to people you wouldn't give SSH to.
- **Binds to localhost by default**; remote access needs a tunnel or a TLS reverse proxy.
- Passwords are scrypt-hashed (min 10 chars); sessions are random 256-bit tokens stored hashed, `HttpOnly` + `SameSite=Strict`; password changes revoke sessions.
- State-changing requests require a custom header and a same-origin `Origin` (CSRF). Strict CSP, and the UI never uses `innerHTML`.
- Login is throttled per IP; first-run setup needs the console token.
- Every value sent to a server is shell-quoted or validated (unit names, container IDs, package names, signals, paths); the file manager and log viewer are confined
  (traversal and symlink escapes blocked, verified by tests against a real SFTP server). Only the Terminal page runs arbitrary shell: admin-only and audited.
- Deploy/domain inputs are validated and quoted: repository URLs (no `ext::`/option injection, `GIT_ALLOW_PROTOCOL` restricted), branch names, commands, ports, domains, upstreams, file names, environment names. Admin-supplied build/start commands and nginx directives are *meant* to run/apply as written, so the admin role is powerful; nginx edits are always validated and rolled back.
- Viewers can monitor every server (including app/domain status, DNS and HTTP checks) but cannot reach Files, Logs, Cron, Terminal, Servers, Users, Audit, deploy logs, env values, webhook secrets or nginx text, and cannot change anything.
- Domain checks make the panel host resolve and connect to registered domains (admin-created); only status, headers and certificate details are returned.

## Layout

```
server/index.js         HTTP server, routing, auth/CSRF pipeline, server-scoped routes (?server=<id>)
server/lib/host.js      LocalHost + SshHost (ssh2 exec/SFTP, host-key pinning, sudo fallback)
server/lib/keys.js      .pem / OpenSSH / .ppk loading and PPK v2/v3 conversion
server/lib/argon2.js    pure-JS Argon2 (for passphrase-protected PPK v3)
server/lib/vault.js     AES-256-GCM encryption of stored secrets
server/lib/servers.js   server registry: add/verify/update/remove, live connections
server/lib/sys.js       metrics sampler, disks, processes, sockets (via a host)
server/lib/ops.js       services, docker, files, logs, cron (via a host)
server/lib/pkg.js       dnf updates / upgrades      server/lib/aws.js  EC2 instance metadata
server/lib/auth.js      users, scrypt, sessions, throttling
public/                 single-page UI
deploy/                 AL2023 installer + systemd unit
test/                   unit + end-to-end tests (node:test)
```
