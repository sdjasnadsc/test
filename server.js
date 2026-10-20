import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { getProxyForUrl } from 'proxy-from-env';
import { CookieJar } from 'tough-cookie';
import { proxyUrl, rewriteHtml, rewriteCss } from './rewrite.js';

const MAX_BODY = 10 * 1024 * 1024;
const MAX_PAGE = 24 * 1024 * 1024;
const SESSION_TTL = 60 * 60 * 1000;
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/runtime.js', ['runtime.js', 'text/javascript; charset=utf-8']],
]);

class ProxyError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function isPublic(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

async function readLimited(stream, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new ProxyError('This request exceeds the proxy size limit.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function targetFromPath(path, allowNonstandardPorts = false) {
  const match = /^\/p\/(https?)\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) throw new ProxyError('Enter a valid HTTP or HTTPS address.', 400);
  let target;
  try { target = new URL(`${match[1]}://${match[2]}${match[3] || '/'}`); }
  catch { throw new ProxyError('This website address is invalid.', 400); }
  if (target.username || target.password) throw new ProxyError('Addresses containing credentials are not supported.', 400);
  if (!allowNonstandardPorts && target.port && !['80', '443'].includes(target.port)) throw new ProxyError('Only standard website ports are supported.', 403);
  return target;
}

function errorPage(message) {
  const safe = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arigato · Could not connect</title><link rel="stylesheet" href="/style.css"><main class="error-page"><a class="brand" href="/">arigato<span>↗</span></a><h1>Could not open this page.</h1><p>${safe}</p><a class="button" href="/">Try another address ↗</a></main></html>`;
}

export function createProxyServer({ allowPrivateTargets = false } = {}) {
  const sessions = new Map();
  const proxyAgents = {
    'http:': new http.Agent({ proxyEnv: process.env }),
    'https:': new https.Agent({ proxyEnv: process.env }),
  };
  const timer = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.touched > SESSION_TTL) sessions.delete(id);
  }, 60_000);
  timer.unref();

  function sessionFor(req, res) {
    const id = /(?:^|;\s*)arigato_session=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    let session = id && sessions.get(id);
    if (!session || Date.now() - session.touched > SESSION_TTL) {
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
      const key = randomBytes(24).toString('hex');
      session = { jar: new CookieJar(), touched: Date.now() };
      sessions.set(key, session);
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `arigato_session=${key}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
    }
    session.touched = Date.now();
    return session;
  }

  async function proxy(req, res) {
    const target = targetFromPath(req.url, allowPrivateTargets);
    // Tests use a local upstream; production never exposes an override via environment variables.
    const hostname = target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const literal = ipaddr.isValid(hostname);
    if (!allowPrivateTargets && (literal ? !isPublic(hostname)
      : !hostname.includes('.') || /\.(localhost|local|internal|test|invalid)$/i.test(hostname))) {
      throw new ProxyError('Private and local network addresses are unavailable.', 403);
    }
    // Managed hosts resolve destinations inside their egress proxy. Its network
    // policy is authoritative there; direct connections pin validated DNS results.
    const usesProxy = !allowPrivateTargets && Boolean(getProxyForUrl(target.href));
    let connection;
    if (usesProxy) {
      connection = { agent: proxyAgents[target.protocol] };
    } else {
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      if (!addresses.length || (!allowPrivateTargets && addresses.some(({ address }) => !isPublic(address)))) {
        throw new ProxyError('Private and local network addresses are unavailable.', 403);
      }
      const pinned = addresses[0];
      connection = { agent: false, lookup: (_host, options, callback) => options.all
        ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family) };
    }
    const session = sessionFor(req, res);
    const headers = { 'accept-encoding': 'identity' };
    for (const name of ['accept', 'accept-language', 'user-agent', 'content-type', 'range', 'if-range']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const cookie = await session.jar.getCookieString(target.href);
    if (cookie) headers.cookie = cookie;
    if (req.headers.origin) headers.origin = target.origin;
    if (req.headers.referer) {
      try {
        const referer = new URL(req.headers.referer);
        const upstream = targetFromPath(referer.pathname + referer.search);
        if (upstream.origin === target.origin) headers.referer = upstream.href;
      } catch {}
    }
    const body = await readLimited(req, MAX_BODY);
    if (body.length) headers['content-length'] = body.length;
    const signal = AbortSignal.timeout(60_000);
    const upstream = await new Promise((accept, reject) => {
      const transport = target.protocol === 'https:' ? https : http;
      const request = transport.request(target, {
        method: req.method,
        headers,
        signal,
        ...connection,
      }, accept);
      request.on('error', reject);
      res.once('close', () => { if (!res.writableFinished) request.destroy(); });
      request.end(body);
    });
    for (const cookie of upstream.headers['set-cookie'] || []) {
      await session.jar.setCookie(cookie, target.href, { ignoreError: true });
    }
    res.statusCode = upstream.statusCode || 502;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (upstream.headers.location) {
      res.setHeader('Location', proxyUrl(upstream.headers.location, target.href));
    }
    for (const name of ['content-type', 'content-disposition', 'content-range', 'accept-ranges']) {
      if (upstream.headers[name]) res.setHeader(name, upstream.headers[name]);
    }
    if (req.method === 'HEAD' || [204, 304].includes(res.statusCode) || (res.statusCode >= 300 && res.statusCode < 400)) {
      upstream.resume();
      res.end();
      return;
    }
    const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
    const transform = /(?:text\/html|application\/xhtml\+xml|text\/css)/i.test(contentType);
    if (!transform) {
      if (upstream.headers['content-encoding']) res.setHeader('Content-Encoding', upstream.headers['content-encoding']);
      await pipeline(upstream, res);
      return;
    }
    const chunks = [];
    let size = 0;
    const sink = new Writable({ write(chunk, encoding, next) {
      size += chunk.length;
      if (size > MAX_PAGE) return next(new ProxyError('This page exceeds the proxy size limit.', 413));
      chunks.push(chunk);
      next();
    } });
    const encoding = upstream.headers['content-encoding'];
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
      : encoding === 'br' ? createBrotliDecompress() : new Transform({ transform(c, e, done) { done(null, c); } });
    await pipeline(upstream, decoder, sink);
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
    let text;
    try { text = new TextDecoder(charset).decode(Buffer.concat(chunks)); }
    catch { text = Buffer.concat(chunks).toString('utf8'); }
    res.setHeader('Content-Type', `${/text\/css/i.test(contentType) ? 'text/css' : 'text/html'}; charset=utf-8`);
    res.end(/text\/css/i.test(contentType) ? rewriteCss(text, target.href) : rewriteHtml(text, target.href));
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) {
        throw new ProxyError('This request method is not supported.', 405);
      }
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'arigato', status: 'ok' }));
      } else if (publicFiles.has(req.url) && ['GET', 'HEAD'].includes(req.method)) {
        const [name, type] = publicFiles.get(req.url);
        const content = await readFile(new URL(`./public/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : content);
      } else if (req.url.startsWith('/p/')) {
        await proxy(req, res);
      } else {
        throw new ProxyError('This page does not exist.', 404);
      }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof ProxyError ? error.status : 502;
      const message = error instanceof ProxyError ? error.message : error.code === 'ENOTFOUND'
        ? 'The website address could not be found.' : error.name === 'AbortError'
          ? 'The website took too long to respond.' : 'The website could not be reached from this host. Try another address.';
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(errorPage(message));
    }
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 15_000;
  server.on('close', () => {
    clearInterval(timer);
    for (const agent of Object.values(proxyAgents)) agent.destroy();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createProxyServer().listen(port, '0.0.0.0', () => console.log(`Arigato listening on port ${port}`));
}
