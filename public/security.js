'use strict';
/* Security: a checkup with one-click fixes, SSH hardening, firewall, fail2ban and automatic security updates. */

function pageSecurity() {
  const root = h('div', {});
  const body = h('div', {});
  root.append(pageHeader('Security', `Checkup and protection for ${(currentServer() || {}).name || 'this server'}`, h('button', { cmd: 'sshd -T   # effective SSH settings\nfirewall-cmd --state; firewall-cmd --list-all\nfail2ban-client status sshd\nsystemctl is-enabled dnf-automatic.timer\nawk -F: \'$3==0\' /etc/passwd; awk -F: \'$2==""\' /etc/shadow\njournalctl -u sshd --since \'24 hours ago\' | grep \'Failed password\'', onclick: () => load() }, 'Check again')), body);

  const post = async (path, payload, okMsg, pending) => {
    try { toast(pending || 'Working…'); await api(path, { method: 'POST', body: payload }); toast(okMsg); await load(); } catch (e) { fail(e); }
  };
  const statusBadge = (s) => h('span', { class: `badge ${s === 'ok' ? 'ok' : s === 'bad' ? 'crit' : 'warn'}` }, s === 'ok' ? 'OK' : s === 'bad' ? 'fix now' : 'recommended');

  async function load() {
    body.replaceChildren(h('div', { class: 'muted' }, 'Checking the server…'));
    const s = await api('/api/security');
    const fixes = {
      'ssh-root': () => sshApply({ permitRootLogin: 'no' }, 'Turn off direct root login over SSH?', 'Nobody can log in as root over SSH any more; use your normal user and sudo. The panel tests a new connection afterwards and the server undoes the change by itself if that fails.'),
      'ssh-password': () => sshApply({ passwordAuth: 'no' }, 'Turn off password login over SSH?', `Only SSH keys will work (${s.ssh.keys} key(s) found for ${s.me}). The panel tests a new connection afterwards and the server undoes the change by itself if that fails.`),
      firewall: () => confirmDialog('Turn on the firewall?', `SSH (port ${s.ssh.port}) and the panel’s connection stay open. Web ports 80 and 443 are opened too. Open anything else you need afterwards. If this server is on AWS, also keep its Security Group in sync.`, 'Turn on', false).then((ok) => ok && post('/api/security/firewall', { action: 'enable' }, 'Firewall is on', 'Installing and starting the firewall…')),
      fail2ban: () => post('/api/security/fail2ban', { action: 'enable' }, 'fail2ban is protecting SSH', 'Installing fail2ban…'),
      'auto-updates': () => post('/api/security/auto-updates', { action: 'enable' }, 'Security updates will install automatically', 'Setting up automatic updates…'),
    };
    async function sshApply(payload, title, text) { if (await confirmDialog(title, text, 'Apply', false)) await post('/api/security/ssh', payload, 'Done. A new connection was tested and works.', 'Applying and testing a new connection…'); }

    const sshTip = (lines) => `echo "${lines}" > /etc/ssh/sshd_config.d/00-panel-hardening.conf\nsshd -t   # checks the configuration, restored if invalid\nsshd -T   # confirms the setting really took effect\nsystemctl reload sshd\n# then the panel opens a NEW connection; if that fails the server undoes it by itself`;
    const fixCmds = {
      'ssh-root': sshTip('PermitRootLogin no'), 'ssh-password': sshTip('PasswordAuthentication no'),
      firewall: `dnf -y install firewalld   # if missing\nsystemctl enable --now firewalld\nfirewall-cmd --permanent --add-port=${s.ssh.port}/tcp   # SSH first, so you are never locked out\nfirewall-cmd --permanent --add-service=http --add-service=https\nfirewall-cmd --reload`,
      fail2ban: 'dnf -y install fail2ban\nwrite /etc/fail2ban/jail.d/panel.local   # [sshd] enabled, maxretry, bantime, your address whitelisted\nsystemctl enable --now fail2ban',
      'auto-updates': 'dnf -y install dnf-automatic\nsed -i "s/^upgrade_type.*/upgrade_type = security/; s/^apply_updates.*/apply_updates = yes/" /etc/dnf/automatic.conf\nsystemctl enable --now dnf-automatic.timer',
    };
    const bad = s.checks.filter((c) => c.status === 'bad').length; const warn = s.checks.filter((c) => c.status === 'warn').length;
    const summary = h('div', { class: `alert ${bad ? 'crit' : warn ? 'warn' : 'ok'}` }, bad ? `${bad} thing(s) need attention now` : warn ? `No urgent problems; ${warn} recommendation(s) below` : 'Everything checked looks good');
    const checks = h('div', { class: 'card' }, h('h2', {}, 'Checkup'), summary, ...s.checks.map((c) => h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border, #e5e7eb)' } },
      h('div', {}, h('div', {}, h('strong', {}, c.title), ' ', statusBadge(c.status)), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, c.detail)),
      c.fix && fixes[c.fix] ? h('button', { class: 'sm primary', cmd: fixCmds[c.fix], onclick: () => fixes[c.fix]() }, 'Fix it') : null)));

    // ---- ssh
    const sshCard = h('div', { class: 'card' }, h('h2', {}, 'SSH access'),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, `Port ${s.ssh.port}. Changes are written to one separate file, checked by sshd, tested with a brand-new connection, and undone by the server itself if that test fails.`),
      kv([['Root login', s.ssh.permitRootLogin || '?'], ['Password login', s.ssh.passwordAuth || '?'], ['Keys for ' + s.me, String(s.ssh.keys)], ['Managed by the panel', s.ssh.managed ? 'yes' : 'no']]),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        s.ssh.permitRootLogin !== 'no' ? h('button', { cmd: fixCmds['ssh-root'], onclick: fixes['ssh-root'] }, 'Turn off root login') : h('button', { cmd: 'remove the PermitRootLogin line from /etc/ssh/sshd_config.d/00-panel-hardening.conf\nsshd -t; systemctl reload sshd', onclick: () => post('/api/security/ssh', { permitRootLogin: 'default' }, 'Back to the server default', 'Applying…') }, 'Allow root login again'),
        s.ssh.passwordAuth !== 'no' ? h('button', { cmd: fixCmds['ssh-password'], onclick: fixes['ssh-password'] }, 'Turn off password login') : h('button', { cmd: 'remove the PasswordAuthentication line from /etc/ssh/sshd_config.d/00-panel-hardening.conf\nsshd -t; systemctl reload sshd', onclick: () => post('/api/security/ssh', { passwordAuth: 'default' }, 'Back to the server default', 'Applying…') }, 'Allow password login again')));

    // ---- firewall
    const fw = s.firewall;
    const portIn = h('input', { type: 'number', min: 1, max: 65535, placeholder: '8080', style: { width: '110px' } });
    const proto = h('select', {}, h('option', { value: 'tcp' }, 'TCP'), h('option', { value: 'udp' }, 'UDP'));
    const fwCard = h('div', { class: 'card' }, h('h2', {}, 'Firewall ', fw.running ? h('span', { class: 'badge ok' }, 'on') : h('span', { class: 'badge warn' }, fw.installed ? 'off' : 'not installed')),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Only the ports listed here accept connections from outside. SSH and the panel’s own connection can never be closed from here.'),
      fw.running ? h('div', {}, h('div', { class: 'row', style: { gap: '6px' } }, ...[...fw.services.map((x) => ({ label: x, body: { service: x }, locked: x === 'ssh' })), ...fw.ports.map((x) => ({ label: x, body: { port: Number(x.split('/')[0]), proto: x.split('/')[1] }, locked: Number(x.split('/')[0]) === s.ssh.port }))].map((x) =>
        h('span', { class: 'chip ok' }, x.label, x.locked ? ' 🔒' : h('button', { class: 'sm', style: { marginLeft: '6px' }, cmd: `firewall-cmd --permanent --remove-${x.body.service ? 'service=' + x.body.service : 'port=' + x.label}\nfirewall-cmd --reload`, onclick: () => post('/api/security/firewall', { action: 'close', ...x.body }, `${x.label} closed`) }, '✕')))),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', {}, 'Open a port:'), portIn, proto, h('button', { cmd: 'firewall-cmd --permanent --add-port=<port>/<tcp|udp>\nfirewall-cmd --reload', onclick: () => post('/api/security/firewall', { action: 'open', port: Number(portIn.value), proto: proto.value }, 'Port opened') }, 'Open'),
        ['http', 'https'].filter((x) => !fw.services.includes(x)).map((x) => h('button', { cmd: `firewall-cmd --permanent --add-service=${x}\nfirewall-cmd --reload`, onclick: () => post('/api/security/firewall', { action: 'open', service: x }, `${x} opened`) }, `Open ${x}`))),
      h('div', { style: { marginTop: '10px' } }, h('button', { class: 'danger', cmd: 'systemctl disable --now firewalld', onclick: async () => { if (await confirmDialog('Turn the firewall off?', 'Every port on this server becomes reachable (unless an AWS Security Group blocks it).', 'Turn off')) post('/api/security/firewall', { action: 'disable' }, 'Firewall is off'); } }, 'Turn firewall off')))
        : h('button', { class: 'primary', cmd: fixCmds.firewall, onclick: fixes.firewall }, fw.installed ? 'Turn on the firewall' : 'Install and turn on the firewall'));

    // ---- fail2ban
    const f2 = s.fail2ban;
    const tries = h('input', { type: 'number', min: 2, max: 20, value: 5, style: { width: '70px' } });
    const mins = h('input', { type: 'number', min: 1, value: 60, style: { width: '90px' } });
    const f2Card = h('div', { class: 'card' }, h('h2', {}, 'Blocking repeated failed logins ', f2.active && f2.jail ? h('span', { class: 'badge ok' }, 'on') : h('span', { class: 'badge warn' }, f2.installed ? 'off' : 'not installed')),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'fail2ban watches SSH logins and blocks an address for a while after too many failures. The panel’s own address is never blocked.'),
      f2.active && f2.jail ? h('div', {}, h('div', {}, `${f2.totalBanned} address(es) blocked so far; ${f2.banned.length} blocked right now.`),
        f2.banned.length ? h('div', { class: 'row', style: { gap: '6px', margin: '8px 0' } }, f2.banned.map((ip) => h('span', { class: 'chip bad' }, ip, h('button', { class: 'sm', style: { marginLeft: '6px' }, cmd: `fail2ban-client set sshd unbanip ${ip}`, onclick: () => post('/api/security/fail2ban', { action: 'unban', ip }, `${ip} unblocked`) }, 'Unblock')))) : null,
        h('div', { style: { marginTop: '8px' } }, h('button', { class: 'danger', cmd: 'rm /etc/fail2ban/jail.d/panel.local\nsystemctl restart fail2ban', onclick: () => post('/api/security/fail2ban', { action: 'disable' }, 'SSH protection is off') }, 'Turn off')))
        : h('div', { class: 'row' }, h('span', {}, 'Block after'), tries, h('span', {}, 'failed attempts, for'), mins, h('span', {}, 'minutes'),
          h('button', { class: 'primary', cmd: fixCmds.fail2ban, onclick: () => post('/api/security/fail2ban', { action: 'enable', maxRetry: Number(tries.value), banMinutes: Number(mins.value) }, 'fail2ban is protecting SSH', 'Installing fail2ban…') }, f2.installed ? 'Turn on' : 'Install and turn on')));

    // ---- auto updates
    const au = s.autoUpdates;
    const auCard = h('div', { class: 'card' }, h('h2', {}, 'Automatic security updates ', au.enabled ? h('span', { class: 'badge ok' }, 'on') : h('span', { class: 'badge warn' }, 'off')),
      h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Security fixes are installed by the server itself every day (only security updates, not every package). Some updates need a reboot to take effect; the Updates page shows when.'),
      au.enabled ? h('button', { cmd: 'systemctl disable --now dnf-automatic.timer', onclick: () => post('/api/security/auto-updates', { action: 'disable' }, 'Automatic updates are off') }, 'Turn off') : h('button', { class: 'primary', cmd: fixCmds['auto-updates'], onclick: fixes['auto-updates'] }, 'Turn on'));

    // ---- attacks
    const atk = h('div', { class: 'card' }, h('h2', {}, 'Recent login attempts (24 h)'), h('div', {}, `${s.attacks.count} failed attempt(s).`),
      s.attacks.top.length ? dataTable({ columns: [{ key: 'ip', label: 'Address' }, { key: 'count', label: 'Attempts' }], rows: s.attacks.top, empty: '' }) : null);

    body.replaceChildren(checks, sshCard, fwCard, f2Card, auCard, atk);
  }
  load().catch(fail);
  return root;
}
