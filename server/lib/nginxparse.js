'use strict';
/**
 * Small nginx configuration reader, used to ADOPT hand-written sites: it understands comments, quoted
 * strings and nested blocks well enough to find `server` blocks and the directives that matter.
 * It never rewrites anything; adoption keeps the original file text verbatim.
 */

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  let cur = '';
  let quoted = false;
  const push = () => { if (cur !== '' || quoted) tokens.push({ t: 'word', v: cur }); cur = ''; quoted = false; };
  while (i < n) {
    const c = text[i];
    if (c === '#') { push(); while (i < n && text[i] !== '\n') i += 1; continue; }
    if (c === '"' || c === "'") {
      quoted = true;
      i += 1;
      while (i < n && text[i] !== c) { if (text[i] === '\\' && i + 1 < n) { cur += text[i + 1]; i += 2; } else { cur += text[i]; i += 1; } }
      i += 1;
      continue;
    }
    if (c === ';' || c === '{' || c === '}') { push(); tokens.push({ t: c }); i += 1; continue; }
    if (/\s/.test(c)) { push(); i += 1; continue; }
    cur += c; i += 1;
  }
  push();
  return tokens;
}

/** -> [{name, args, children|null}] (nested) */
function parseTree(text) {
  const tokens = tokenize(text);
  let pos = 0;
  function block() {
    const out = [];
    let words = [];
    while (pos < tokens.length) {
      const tk = tokens[pos];
      pos += 1;
      if (tk.t === 'word') words.push(tk.v);
      else if (tk.t === ';') { if (words.length) out.push({ name: words[0], args: words.slice(1), children: null }); words = []; }
      else if (tk.t === '{') { const children = block(); if (words.length) out.push({ name: words[0], args: words.slice(1), children }); words = []; }
      else if (tk.t === '}') return out;
    }
    return out;
  }
  return block();
}

function* walk(nodes) {
  for (const n of nodes) { yield n; if (n.children) yield* walk(n.children); }
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/** One entry per `server { }` block found anywhere in the text. */
function parseNginxSites(text) {
  const servers = [];
  for (const node of walk(parseTree(text))) {
    if (node.name !== 'server' || !node.children) continue;
    const dirs = [...walk(node.children)];
    const all = (name) => dirs.filter((d) => d.name === name);
    const first = (name) => (all(name)[0] || { args: [] }).args;
    const names = all('server_name').flatMap((d) => d.args).filter((x) => x && x !== '_' && !x.startsWith('~') && !x.includes('*') && x !== 'localhost' && !IP_RE.test(x));
    const listen = all('listen').map((d) => d.args.join(' '));
    const fastcgi = all('fastcgi_pass').map((d) => d.args[0]);
    const proxy = all('proxy_pass').map((d) => d.args[0]);
    const root = (node.children.find((d) => d.name === 'root') || { args: [] }).args[0] || null;
    const ssl = first('ssl_certificate')[0] || null;
    const sslKey = first('ssl_certificate_key')[0] || null;
    const redirectsToHttps = all('return').some((d) => /^30[1278]$/.test(d.args[0] || '') && /^https:/.test(d.args[1] || ''));
    const defaultServer = listen.some((l) => /\bdefault_server\b/.test(l));
    let kind = 'other';
    if (fastcgi.length) kind = 'php';
    else if (proxy.length) kind = 'proxy';
    else if (root) kind = 'static';
    else if (redirectsToHttps) kind = 'redirect';
    servers.push({
      names: [...new Set(names)], listen, root, fastcgi: fastcgi[0] || null, proxy: proxy[0] || null,
      sslCert: ssl, sslKey, https: listen.some((l) => /\b(ssl|443)\b/.test(l)) || !!ssl, redirectsToHttps, defaultServer, kind,
    });
  }
  return servers;
}

/** Summarise a whole file: union of names, the app root, certificate and whether HTTP is redirected. */
function summarizeFile(text) {
  const servers = parseNginxSites(text);
  const names = [...new Set(servers.flatMap((s) => s.names))];
  const rank = { php: 4, proxy: 4, static: 3, redirect: 1, other: 0 };
  const primary = servers.reduce((best, x) => (!best || rank[x.kind] > rank[best.kind] ? x : best), null);
  const tls = servers.find((s) => s.sslCert);
  return {
    servers: servers.length, names,
    kind: primary ? primary.kind : 'other',
    root: (primary && primary.root) || (servers.find((x) => x.root) || {}).root || null,
    fastcgi: primary ? primary.fastcgi : null, proxy: primary ? primary.proxy : null,
    sslCert: tls ? tls.sslCert : null, sslKey: tls ? tls.sslKey : null,
    redirectsToHttps: servers.some((s) => s.redirectsToHttps),
    onlyDefault: servers.length > 0 && servers.every((s) => s.defaultServer || !s.names.length),
  };
}

module.exports = { parseTree, parseNginxSites, summarizeFile, tokenize };
