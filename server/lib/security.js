'use strict';
/**
 * Server security tools, all behind buttons:
 *  - a security check (SSH settings, firewall, fail2ban, automatic updates, risky accounts, recent attacks);
 *  - SSH hardening through ONE drop-in file that is validated with `sshd -t`, verified with `sshd -T`, and rolled back by
 *    the server itself if the panel cannot open a fresh connection afterwards (so a mistake cannot lock you out);
 *  - firewalld (SSH and the panel's own connection can never be closed from here);
 *  - fail2ban for SSH (the panel's own address is whitelisted);
 *  - automatic security updates (dnf-automatic).
 */
const { httpError } = require('./auth');
const { shq } = require('./host');

const DROPIN_NAME = '00-panel-hardening.conf';
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,39}$/;

const PRIV = 'priv() { if [ "$USE_SUDO" = 1 ] && [ "$(id -u)" != 0 ]; then sudo -n "$@"; else "$@"; fi; }';

function statusScript(cfg) {
  return `${PRIV}
SSHD_BIN=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)
SSHD=$(priv "$SSHD_BIN" -T 2>/dev/null || true)
get() { printf '%s\\n' "$SSHD" | awk -v k="$1" '$1==k{ $1=""; sub(/^ /,""); print; exit }'; }
echo "ssh_known=$([ -n "$SSHD" ] && echo 1 || echo 0)"
for k in port permitrootlogin passwordauthentication pubkeyauthentication kbdinteractiveauthentication maxauthtries x11forwarding; do echo "ssh_$k=$(get $k)"; done
echo "ssh_dropin=$([ -f ${shq(cfg.sshdDropinDir + '/' + DROPIN_NAME)} ] && echo 1 || echo 0)"
echo "ssh_keys=$(grep -cvE '^\\s*(#|$)' "$HOME/.ssh/authorized_keys" 2>/dev/null || echo 0)"
echo "fw_installed=$(command -v firewall-cmd >/dev/null 2>&1 && echo 1 || echo 0)"
if command -v firewall-cmd >/dev/null 2>&1; then
  echo "fw_running=$(priv firewall-cmd --state 2>/dev/null | head -1)"
  echo "fw_services=$(priv firewall-cmd --list-services 2>/dev/null | head -1)"
  echo "fw_ports=$(priv firewall-cmd --list-ports 2>/dev/null | head -1)"
fi
echo "f2b_installed=$(command -v fail2ban-client >/dev/null 2>&1 && echo 1 || echo 0)"
if command -v fail2ban-client >/dev/null 2>&1; then
  echo "f2b_active=$(systemctl is-active fail2ban 2>/dev/null | head -1)"
  J=$(priv fail2ban-client status sshd 2>/dev/null || true)
  echo "f2b_jail=$([ -n "$J" ] && echo 1 || echo 0)"
  echo "f2b_banned=$(printf '%s\\n' "$J" | sed -n 's/.*Banned IP list:[[:space:]]*//p' | head -1 | tr -s ' ' ',')"
  echo "f2b_total=$(printf '%s\\n' "$J" | sed -n 's/.*Total banned:[[:space:]]*//p' | head -1)"
fi
echo "au_installed=$( (rpm -q dnf-automatic >/dev/null 2>&1 || [ -f ${shq(cfg.dnfAutomaticConf)} ]) && echo 1 || echo 0)"
echo "au_timer=$(systemctl is-enabled dnf-automatic.timer 2>/dev/null | head -1)"
echo "au_type=$(sed -n 's/^upgrade_type[[:space:]]*=[[:space:]]*//p' ${shq(cfg.dnfAutomaticConf)} 2>/dev/null | head -1)"
echo "au_apply=$(sed -n 's/^apply_updates[[:space:]]*=[[:space:]]*//p' ${shq(cfg.dnfAutomaticConf)} 2>/dev/null | head -1)"
echo "acct_uid0=$(awk -F: '$3==0 && $1!="root"{printf "%s,", $1}' /etc/passwd 2>/dev/null)"
echo "acct_empty=$(priv awk -F: '($2==""){printf "%s,", $1}' /etc/shadow 2>/dev/null)"
LOG=$( (priv journalctl -u sshd -u ssh --since '24 hours ago' --no-pager 2>/dev/null || true; priv cat /var/log/secure 2>/dev/null | tail -n 5000 || true) | grep -E 'Failed password|Invalid user|authentication failure' || true)
echo "atk_count=$(printf '%s' "$LOG" | grep -c . || true)"
echo "atk_top=$(printf '%s\\n' "$LOG" | grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}' | sort | uniq -c | sort -rn | head -5 | awk '{printf "%s:%s,", $2, $1}')"
echo "me=$(id -un)"
echo "client=\${SSH_CLIENT%% *}"
`;
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

class SecurityManager {
  constructor({ servers, config, domains }) { Object.assign(this, { servers, config, domains }); }
  hostOf(id) { return this.servers.entry(id).host; }
  cfg() { return { sshdDropinDir: this.config.sshdDropinDir, dnfAutomaticConf: this.config.dnfAutomaticConf, fail2banJailDir: this.config.fail2banJailDir }; }

  async facts(serverId) {
    const host = this.hostOf(serverId);
    const r = await host.run('bash', ['-s'], { stdin: `USE_SUDO=${host.useSudo ? 1 : 0}\n${statusScript(this.cfg())}`, timeout: 60000 });
    const o = {};
    for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1).trim(); }
    return o;
  }

  async status(serverId) {
    const host = this.hostOf(serverId);
    const o = await this.facts(serverId);
    const ssh = {
      known: o.ssh_known === '1', port: Number(o.ssh_port) || host.port || 22, permitRootLogin: o.ssh_permitrootlogin || '', passwordAuth: o.ssh_passwordauthentication || '',
      pubkeyAuth: o.ssh_pubkeyauthentication || '', maxAuthTries: o.ssh_maxauthtries || '', managed: o.ssh_dropin === '1', keys: Number(o.ssh_keys) || 0,
    };
    const firewall = { installed: o.fw_installed === '1', running: o.fw_running === 'running', services: list(o.fw_services ? o.fw_services.replace(/ /g, ',') : ''), ports: list(o.fw_ports ? o.fw_ports.replace(/ /g, ',') : '') };
    const fail2ban = { installed: o.f2b_installed === '1', active: o.f2b_active === 'active', jail: o.f2b_jail === '1', banned: list(o.f2b_banned), totalBanned: Number(o.f2b_total) || 0 };
    const autoUpdates = { installed: o.au_installed === '1', enabled: o.au_timer === 'enabled', type: o.au_type || '', apply: o.au_apply || '' };
    const accounts = { extraRoot: list(o.acct_uid0), emptyPassword: list(o.acct_empty) };
    const attacks = { count: Number(o.atk_count) || 0, top: list(o.atk_top).map((x) => { const [ip, n] = x.split(':'); return { ip, count: Number(n) }; }) };
    const checks = [];
    const add = (id, title, st, detail, fix) => checks.push({ id, title, status: st, detail, fix: fix || null });
    if (!ssh.known) add('ssh', 'SSH settings', 'warn', 'The panel could not read the SSH server settings (it needs sudo).');
    else {
      const pr = ssh.permitRootLogin;
      add('ssh-root', 'Direct root login over SSH', pr === 'no' ? 'ok' : pr === 'yes' ? 'bad' : 'ok', pr === 'no' ? 'Disabled.' : pr === 'yes' ? 'Root can log in over SSH. Attackers always try the root account.' : 'Root can only log in with a key.', pr === 'yes' ? 'ssh-root' : null);
      add('ssh-password', 'Password login over SSH', ssh.passwordAuth === 'no' ? 'ok' : 'warn', ssh.passwordAuth === 'no' ? 'Disabled: only keys work.' : 'Passwords are accepted, so they can be guessed. Keys cannot.', ssh.passwordAuth === 'no' ? null : 'ssh-password');
    }
    add('firewall', 'Server firewall', firewall.running ? 'ok' : 'warn', firewall.running ? 'Running.' : firewall.installed ? 'Installed but not running.' : 'Not installed. (If this server is on AWS, its Security Group may already filter traffic.)', firewall.running ? null : 'firewall');
    add('fail2ban', 'Blocking repeated failed logins (fail2ban)', fail2ban.active && fail2ban.jail ? 'ok' : 'warn', fail2ban.active && fail2ban.jail ? `Active${fail2ban.banned.length ? `, ${fail2ban.banned.length} address(es) blocked now` : ''}.` : fail2ban.installed ? 'Installed but the SSH protection is not on.' : 'Not installed.', fail2ban.active && fail2ban.jail ? null : 'fail2ban');
    add('auto-updates', 'Automatic security updates', autoUpdates.enabled ? 'ok' : 'warn', autoUpdates.enabled ? 'On.' : 'Off: security fixes wait until someone updates by hand.', autoUpdates.enabled ? null : 'auto-updates');
    if (accounts.extraRoot.length) add('accounts-root', 'Extra accounts with root powers', 'bad', `${accounts.extraRoot.join(', ')} have user id 0 (the same power as root).`);
    if (accounts.emptyPassword.length) add('accounts-empty', 'Accounts without a password', 'bad', `${accounts.emptyPassword.join(', ')} have an empty password.`);
    add('attacks', 'Login attempts in the last 24 hours', attacks.count > 500 ? 'warn' : 'ok', `${attacks.count} failed attempt(s)${attacks.top.length ? `; most from ${attacks.top.map((t) => `${t.ip} (${t.count})`).join(', ')}` : ''}.`);
    return { ssh, firewall, fail2ban, autoUpdates, accounts, attacks, checks, me: o.me, client: o.client || '' };
  }

  // ------------------------------------------------------------------ SSH hardening

  async setSsh(serverId, { permitRootLogin = 'keep', passwordAuth = 'keep' } = {}) {
    if (!['keep', 'no', 'default'].includes(permitRootLogin) || !['keep', 'no', 'default'].includes(passwordAuth)) throw httpError(400, 'Invalid SSH setting');
    const host = this.hostOf(serverId);
    const f = await this.facts(serverId);
    if (f.ssh_known !== '1') throw httpError(400, 'Could not read the SSH settings: the SSH user needs passwordless sudo.');
    if (host.kind === 'ssh') {
      if (permitRootLogin === 'no' && host.username === 'root') throw httpError(400, 'The panel connects as root, so root login cannot be disabled. Connect as another user with sudo first.');
      if (passwordAuth === 'no' && !(Number(f.ssh_keys) > 0)) throw httpError(400, `${host.username} has no key in ~/.ssh/authorized_keys, so turning passwords off could lock everyone out.`);
    }
    // current drop-in lines (what an earlier hardening chose)
    const dir = this.config.sshdDropinDir; const file = `${dir}/${DROPIN_NAME}`; const bak = `${dir}/.${DROPIN_NAME}.bak`; const confirm = `${dir}/.panel-ssh-confirm`;
    const cur = await host.runPriv('cat', [file]);
    const have = {};
    for (const l of (cur.ok ? cur.stdout : '').split('\n')) { const m = l.match(/^(PermitRootLogin|PasswordAuthentication)\s+(\S+)/); if (m) have[m[1]] = m[2]; }
    const want = { ...have };
    if (permitRootLogin === 'no') want.PermitRootLogin = 'no'; else if (permitRootLogin === 'default') delete want.PermitRootLogin;
    if (passwordAuth === 'no') want.PasswordAuthentication = 'no'; else if (passwordAuth === 'default') delete want.PasswordAuthentication;
    const body = Object.keys(want).length ? `# Written by Server Panel. Remove this file (Security → SSH → restore defaults) to undo.\n${Object.entries(want).map(([k, v]) => `${k} ${v}`).join('\n')}\n` : '';
    const delay = this.config.sshRollbackSeconds;
    const script = `set -u
${PRIV}
USE_SUDO=${host.useSudo ? 1 : 0}
DIR=${shq(dir)}; F=${shq(file)}; BAK=${shq(bak)}; CONFIRM=${shq(confirm)}
priv mkdir -p "$DIR"
priv rm -f "$CONFIRM"
if [ -f "$F" ]; then priv cp -p "$F" "$BAK"; else priv rm -f "$BAK"; fi
restore() { if [ -f "$BAK" ]; then priv cp -p "$BAK" "$F"; else priv rm -f "$F"; fi; }
${body ? `printf '%s' ${shq(body)} | priv tee "$F" >/dev/null\npriv chmod 600 "$F"` : 'priv rm -f "$F"'}
SSHD_BIN=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)
if ! OUT=$(priv "$SSHD_BIN" -t 2>&1); then restore; echo "@@STATE invalid"; echo "$OUT"; exit 1; fi
EFF=$(priv "$SSHD_BIN" -T 2>/dev/null)
${want.PermitRootLogin ? `printf '%s\\n' "$EFF" | grep -qix 'permitrootlogin ${want.PermitRootLogin}' || { restore; echo "@@STATE overridden"; echo "PermitRootLogin is overridden by another SSH config file"; exit 1; }` : ':'}
${want.PasswordAuthentication ? `printf '%s\\n' "$EFF" | grep -qix 'passwordauthentication ${want.PasswordAuthentication}' || { restore; echo "@@STATE overridden"; echo "PasswordAuthentication is overridden by another SSH config file"; exit 1; }` : ':'}
# the server undoes the change by itself unless the panel confirms that a NEW connection still works
nohup setsid bash -c 'sleep ${delay}; if [ ! -e "'"$CONFIRM"'" ]; then if [ -f "'"$BAK"'" ]; then cp -p "'"$BAK"'" "'"$F"'"; else rm -f "'"$F"'"; fi; systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null; fi; rm -f "'"$CONFIRM"'" "'"$BAK"'"' >/dev/null 2>&1 < /dev/null &
priv systemctl reload sshd 2>/dev/null || priv systemctl reload ssh
echo "@@STATE applied"
`;
    const r = await host.run('bash', ['-s'], { stdin: script, timeout: 60000 });
    const state = (r.stdout.match(/@@STATE (\w+)/) || [])[1];
    if (state !== 'applied') throw httpError(400, `SSH settings were NOT changed: ${(r.stdout.replace(/@@STATE \w+\n?/, '') || r.stderr).trim().split('\n').slice(-2).join(' ') || 'sshd rejected them'}`);
    // prove a brand-new connection still works, then cancel the automatic undo
    let verified = true;
    if (host.kind === 'ssh') {
      try { host.disconnect(); await host.connect(); } catch { verified = false; }
    }
    if (verified) {
      const c = await host.runPriv('touch', [confirm]);
      if (!c.ok) verified = false;
    }
    if (!verified) throw httpError(502, `After the change the panel could not open a new SSH connection. The server will undo the change by itself within ${delay} seconds; reconnect then.`);
    return { ok: true, permitRootLogin: want.PermitRootLogin || 'default', passwordAuth: want.PasswordAuthentication || 'default' };
  }

  // ------------------------------------------------------------------ firewall

  fwScript(host, body) { return `set -u\n${PRIV}\nUSE_SUDO=${host.useSudo ? 1 : 0}\n${body}`; }

  async firewall(serverId, action, { port, proto = 'tcp', service, rule } = {}) {
    const host = this.hostOf(serverId);
    const f = await this.facts(serverId);
    const sshPort = Number(f.ssh_port) || host.port || 22;
    const keep = new Set([sshPort, Number(host.port) || 22]);
    const run = async (body, timeout = 300000) => {
      const r = await host.run('bash', ['-s'], { stdin: this.fwScript(host, body), timeout });
      if (!r.ok) throw httpError(400, (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || 'The firewall command failed');
      return r;
    };
    if (action === 'install' || action === 'enable') {
      // SSH (and the panel's own connection port) are opened BEFORE the firewall starts, so enabling it cannot cut the panel off
      const ports = [...keep].map((p) => `priv firewall-cmd --permanent --add-port=${p}/tcp >/dev/null`).join('\n');
      await run(`command -v firewall-cmd >/dev/null 2>&1 || priv dnf -y install firewalld
priv systemctl enable firewalld
priv systemctl start firewalld
${ports}
priv firewall-cmd --permanent --add-service=http >/dev/null; priv firewall-cmd --permanent --add-service=https >/dev/null
priv firewall-cmd --reload >/dev/null
echo ok`, 900000);
      return { ok: true };
    }
    if (action === 'disable') { await run('priv systemctl stop firewalld\npriv systemctl disable firewalld\necho ok'); return { ok: true }; }
    if (action === 'open' || action === 'close') {
      let arg;
      if (service) {
        if (!['http', 'https', 'ssh', 'mysql', 'postgresql', 'smtp', 'ftp'].includes(service)) throw httpError(400, 'Unknown service');
        if (action === 'close' && service === 'ssh') throw httpError(400, 'SSH cannot be closed from the panel: it would lock you out.');
        arg = `--${action === 'open' ? 'add' : 'remove'}-service=${service}`;
      } else {
        const p = Number(port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw httpError(400, 'Port must be 1-65535');
        if (!['tcp', 'udp'].includes(proto)) throw httpError(400, 'Protocol must be tcp or udp');
        if (action === 'close' && keep.has(p)) throw httpError(400, `Port ${p} is used by SSH / the panel's own connection and cannot be closed from here.`);
        arg = `--${action === 'open' ? 'add' : 'remove'}-port=${p}/${proto}`;
      }
      await run(`priv firewall-cmd --permanent ${arg}\npriv firewall-cmd --reload >/dev/null\necho ok`);
      return { ok: true };
    }
    throw httpError(400, 'Unknown firewall action');
  }

  // ------------------------------------------------------------------ fail2ban

  async fail2ban(serverId, action, { ip, maxRetry = 5, banMinutes = 60 } = {}) {
    const host = this.hostOf(serverId);
    const run = async (body, timeout = 300000) => {
      const r = await host.run('bash', ['-s'], { stdin: this.fwScript(host, body), timeout });
      if (!r.ok) throw httpError(400, (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || 'fail2ban command failed');
      return r;
    };
    if (action === 'enable') {
      const mr = Number(maxRetry); const bm = Number(banMinutes);
      if (!Number.isInteger(mr) || mr < 2 || mr > 20 || !Number.isInteger(bm) || bm < 1 || bm > 100000) throw httpError(400, 'Attempts 2-20, block time 1+ minutes');
      const dir = this.config.fail2banJailDir;
      const r = await run(`if ! command -v fail2ban-client >/dev/null 2>&1; then
  priv dnf -y install fail2ban || { echo "fail2ban is not available in this server's package repositories (Amazon Linux 2023 does not ship it; EPEL is needed)" >&2; exit 1; }
fi
ME=\${SSH_CLIENT:-}; ME=\${ME%% *}
priv mkdir -p ${shq(dir)}
printf '[DEFAULT]\\nignoreip = 127.0.0.1/8 ::1 %s\\n\\n[sshd]\\nenabled = true\\nbackend = systemd\\nmaxretry = ${mr}\\nfindtime = 10m\\nbantime = ${bm}m\\n' "$ME" | priv tee ${shq(dir + '/panel.local')} >/dev/null
priv systemctl enable fail2ban
priv systemctl restart fail2ban
sleep 1
priv fail2ban-client status sshd >/dev/null
echo ok`, 900000);
      void r;
      return { ok: true };
    }
    if (action === 'disable') { await run(`priv rm -f ${shq(this.config.fail2banJailDir + '/panel.local')}\npriv systemctl restart fail2ban\necho ok`); return { ok: true }; }
    if (action === 'unban') {
      if (!IP_RE.test(String(ip || ''))) throw httpError(400, 'Invalid IP address');
      await run(`priv fail2ban-client set sshd unbanip ${shq(ip)}\necho ok`);
      return { ok: true };
    }
    throw httpError(400, 'Unknown fail2ban action');
  }

  // ------------------------------------------------------------------ automatic updates

  async autoUpdates(serverId, action, { type = 'security' } = {}) {
    const host = this.hostOf(serverId);
    if (!['security', 'default'].includes(type)) throw httpError(400, 'type must be security or default');
    const conf = this.config.dnfAutomaticConf;
    const body = action === 'enable'
      ? `rpm -q dnf-automatic >/dev/null 2>&1 || [ -f ${shq(conf)} ] || priv dnf -y install dnf-automatic
[ -f ${shq(conf)} ] || { echo "dnf-automatic did not create its configuration file"; exit 1; }
priv sed -i -E 's/^(upgrade_type)[[:space:]]*=.*/\\1 = ${type}/; s/^(apply_updates)[[:space:]]*=.*/\\1 = yes/' ${shq(conf)}
priv systemctl enable dnf-automatic.timer
priv systemctl start dnf-automatic.timer
echo ok`
      : action === 'disable' ? 'priv systemctl stop dnf-automatic.timer\npriv systemctl disable dnf-automatic.timer\necho ok' : null;
    if (!body) throw httpError(400, 'Unknown action');
    const r = await host.run('bash', ['-s'], { stdin: this.fwScript(host, body), timeout: 900000 });
    if (!r.ok) throw httpError(400, (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || 'Could not change automatic updates');
    return { ok: true };
  }
}

module.exports = { SecurityManager, DROPIN_NAME };
