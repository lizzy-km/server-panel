'use strict';
/** DNS and HTTP(S) diagnostics for a domain, run from the panel host. Read-only. */
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const PUBLIC_RESOLVERS = [['Cloudflare 1.1.1.1', '1.1.1.1'], ['Google 8.8.8.8', '8.8.8.8']];

const settle = async (p) => { try { return { ok: true, value: await p }; } catch (e) { return { ok: false, code: e.code || 'ERROR' }; } };
const sortIps = (a) => [...new Set(a)].sort();

function defaultResolverFactory(server) {
  const r = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  if (server) r.setServers([server]);
  return r;
}

async function lookupAddresses(r, name) {
  const [a, aaaa, cname] = await Promise.all([settle(r.resolve4(name)), settle(r.resolve6(name)), settle(r.resolveCname(name))]);
  // NODATA / NXDOMAIN are normal answers, anything else is a resolver problem
  const benign = ['ENODATA', 'ENOTFOUND', 'NODATA', 'NXDOMAIN'];
  const failed = [a, aaaa].find((x) => !x.ok && !benign.includes(x.code));
  return {
    a: a.ok ? sortIps(a.value) : [], aaaa: aaaa.ok ? sortIps(aaaa.value) : [], cname: cname.ok ? cname.value : [],
    error: failed ? failed.code : null, nxdomain: [a, aaaa, cname].every((x) => !x.ok && ['ENOTFOUND', 'NXDOMAIN'].includes(x.code)),
  };
}

/**
 * @param {string} domain
 * @param {{expectedIps?: string[], resolverFactory?: Function, includeApexRecords?: boolean}} opts
 */
async function dnsReport(domain, { expectedIps = [], resolverFactory = defaultResolverFactory, includeRecords = true } = {}) {
  const sys = resolverFactory(null);
  const resolvers = [{ name: 'System resolver', ...(await lookupAddresses(sys, domain)) }];
  for (const [name, ip] of PUBLIC_RESOLVERS) resolvers.push({ name, ...(await lookupAddresses(resolverFactory(ip), domain)) });

  let records = {};
  if (includeRecords) {
    const [ns, mx, txt, caa] = await Promise.all([settle(sys.resolveNs(domain)), settle(sys.resolveMx(domain)), settle(sys.resolveTxt(domain)), settle(sys.resolveCaa(domain))]);
    records = {
      ns: ns.ok ? ns.value : [], mx: mx.ok ? mx.value.sort((x, y) => x.priority - y.priority) : [],
      txt: txt.ok ? txt.value.map((c) => c.join('')) : [],
      caa: caa.ok ? caa.value.map((c) => ({ flags: c.critical || 0, tag: c.issue !== undefined ? 'issue' : c.issuewild !== undefined ? 'issuewild' : c.iodef !== undefined ? 'iodef' : 'unknown', value: c.issue ?? c.issuewild ?? c.iodef ?? '' })) : [],
    };
  }

  const exp = new Set(expectedIps);
  const main = resolvers[0];
  const notes = [];
  let verdict;
  if (main.error && !main.a.length) { verdict = 'error'; notes.push(`DNS lookup failed (${main.error}); try again.`); }
  else if (main.nxdomain || (!main.a.length && !main.aaaa.length && !main.cname.length)) { verdict = 'none'; notes.push('No A, AAAA or CNAME record found. Create an A record pointing at this server.'); }
  else if (exp.size && main.a.some((ip) => exp.has(ip))) verdict = 'ok';
  else if (!exp.size) { verdict = 'unknown'; notes.push('The server\'s public IP is unknown, so the records cannot be compared.'); }
  else { verdict = 'mismatch'; notes.push(`Resolves to ${main.a.join(', ') || (main.cname.length ? 'CNAME ' + main.cname.join(', ') : 'no IPv4 address')}, but this server is ${[...exp].join(', ')}.`); }

  const sets = resolvers.filter((r) => !r.error).map((r) => r.a.join(','));
  if (new Set(sets).size > 1) notes.push('Resolvers disagree: DNS changes may still be propagating.');
  if (main.aaaa.length) notes.push('An AAAA (IPv6) record exists. Make sure the server is reachable over IPv6 or remove it, otherwise some visitors will fail.');
  if (records.caa && records.caa.length && !records.caa.some((c) => c.tag === 'issue' && /letsencrypt\.org/.test(c.value))) notes.push('CAA records exist but do not authorize letsencrypt.org, so certificate issuance will fail.');
  return { domain, expectedIps: [...exp], verdict, resolvers, records, notes };
}

// ---------------------------------------------------------------------------------------------

function friendly(e, scheme) {
  const m = String(e.message || '');
  if (e.code === 'ECONNREFUSED') return 'Connection refused';
  if (e.code === 'ENOTFOUND') return 'Name does not resolve';
  if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return 'Host unreachable';
  if (e.code === 'ECONNRESET') return scheme === 'https' ? 'Connection reset during the TLS handshake (is a certificate configured for this name?)' : 'Connection reset by the server';
  if (e.code === 'EPROTO' || /wrong version number|ssl routines|alert/i.test(m)) return scheme === 'https' ? 'The port did not answer with TLS. Nothing is serving HTTPS here (issue a certificate), or it speaks plain HTTP' : 'Protocol error';
  return m.slice(0, 160);
}

function request(scheme, domain, { port, resolveTo, timeout = 8000, path = '/' }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const mod = scheme === 'https' ? https : http;
    const opts = {
      host: domain, port: port || (scheme === 'https' ? 443 : 80), path, method: 'GET', timeout, agent: false,
      headers: { Host: domain, 'User-Agent': 'ServerPanel-check/1.0', Accept: '*/*', Connection: 'close' },
    };
    if (resolveTo) opts.lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: resolveTo, family: net.isIP(resolveTo) }]) : cb(null, resolveTo, net.isIP(resolveTo)));
    if (scheme === 'https') { opts.rejectUnauthorized = false; opts.servername = domain; }
    const req = mod.request(opts, (res) => {
      const out = { ok: true, status: res.statusCode, location: res.headers.location || null, server: res.headers.server || null, ms: Date.now() - started, hsts: res.headers['strict-transport-security'] || null };
      if (scheme === 'https') {
        const c = res.socket.getPeerCertificate && res.socket.getPeerCertificate();
        if (c && c.valid_to) {
          const names = (c.subjectaltname || '').split(', ').map((x) => x.replace(/^DNS:/, '')).filter(Boolean);
          out.cert = {
            subject: c.subject && c.subject.CN, issuer: c.issuer && (c.issuer.O || c.issuer.CN), validTo: new Date(c.valid_to).getTime(), names,
            authorized: res.socket.authorized, authError: res.socket.authorizationError || null,
          };
          out.cert.daysLeft = Math.floor((out.cert.validTo - Date.now()) / 86400000);
        }
      }
      res.resume();
      res.on('end', () => resolve(out));
      res.on('error', () => resolve(out));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out', ms: Date.now() - started }); });
    req.on('error', (e) => resolve({ ok: false, error: friendly(e, scheme), code: e.code, ms: Date.now() - started }));
    req.end();
  });
}

/**
 * Probe http:// and https:// for a domain. With `resolveTo` the connection goes to that IP (the server)
 * regardless of DNS, so a new site can be verified before DNS points at it.
 */
async function httpReport(domain, { httpPort, httpsPort, resolveTo } = {}) {
  const [http1, https1] = await Promise.all([
    request('http', domain, { port: httpPort, resolveTo }),
    request('https', domain, { port: httpsPort, resolveTo }),
  ]);
  const notes = [];
  if (https1.ok && https1.cert) {
    if (!https1.cert.authorized) notes.push(`HTTPS certificate is not trusted: ${https1.cert.authError}`);
    else if (https1.cert.daysLeft < 0) notes.push('HTTPS certificate has expired.');
    else if (https1.cert.daysLeft < 14) notes.push(`HTTPS certificate expires in ${https1.cert.daysLeft} days.`);
    if (https1.cert.names.length && !https1.cert.names.some((n) => n === domain || (n.startsWith('*.') && domain.endsWith(n.slice(1))))) notes.push(`Certificate does not cover ${domain} (it is for ${https1.cert.names.join(', ')}).`);
  }
  if (http1.ok && https1.ok && http1.status && ![301, 302, 307, 308].includes(http1.status)) notes.push('HTTP does not redirect to HTTPS.');
  if (!http1.ok) notes.push(`HTTP (port 80): ${http1.error}. Check the security group and that nginx is running.`);
  if (!https1.ok) notes.push(`HTTPS (port 443): ${https1.error}.`);
  return { domain, via: resolveTo ? `direct to ${resolveTo}` : 'DNS', http: http1, https: https1, notes };
}

module.exports = { dnsReport, httpReport, lookupAddresses };
