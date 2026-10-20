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
import { WebSocket, WebSocketServer } from 'ws';
import { proxyUrl, rewriteHtml, rewriteCss, rewriteJavascript } from './rewrite.js';

const MAX_BODY = 10 * 1024 * 1024;
const MAX_PAGE = 24 * 1024 * 1024;
const SESSION_TTL = 60 * 60 * 1000;
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/runtime.js', ['runtime.js', 'text/javascript; charset=utf-8']],
  ['/worker-runtime.js', ['worker-runtime.js', 'text/javascript; charset=utf-8']],
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
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const upstreamSockets = new Set();
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

  async function connectionFor(target) {
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
    return connection;
  }

  async function proxy(req, res) {
    const target = targetFromPath(req.url, allowPrivateTargets);
    const connection = await connectionFor(target);
    const session = sessionFor(req, res);
    const headers = { 'accept-encoding': 'identity' };
    for (const name of ['accept', 'accept-language', 'user-agent', 'content-type', 'range', 'if-range']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const cookie = await session.jar.getCookieString(target.href);
    if (cookie) headers.cookie = cookie;
    if (req.headers['x-arigato-origin']) {
      let origin;
      try { origin = new URL(req.headers['x-arigato-origin']); } catch { throw new ProxyError('Invalid request origin.', 400); }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new ProxyError('Invalid request origin.', 400);
      headers.origin = origin.origin;
    } else if (req.headers.origin) headers.origin = target.origin;
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
    const javascript = /(?:text|application)\/(?:x-)?(?:java|ecma)script/i.test(contentType);
    const transform = /(?:text\/html|application\/xhtml\+xml|text\/css)/i.test(contentType) || javascript;
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
    if (javascript) {
      text = rewriteJavascript(text, target.href);
      if (['worker', 'sharedworker'].includes(req.headers['sec-fetch-dest'])) {
        const bootstrap = req.headers['sec-fetch-mode'] === 'cors' ? 'import "/worker-runtime.js";'
          : await readFile(new URL('./public/worker-runtime.js', import.meta.url), 'utf8');
        text = `${bootstrap}\n${text}`;
      }
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(text);
    } else {
      res.setHeader('Content-Type', `${/text\/css/i.test(contentType) ? 'text/css' : 'text/html'}; charset=utf-8`);
      res.end(/text\/css/i.test(contentType) ? rewriteCss(text, target.href) : rewriteHtml(text, target.href));
    }
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
  sockets.on('headers', (headers, req) => {
    if (req.proxyCookie) headers.push(`Set-Cookie: ${req.proxyCookie}`);
  });
  server.on('upgrade', async (req, socket, head) => {
    let upgraded = false;
    function reject(status) {
      if (upgraded) { socket.destroy(); return; }
      if (!socket.destroyed && !socket.writableEnded) socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    let upstream;
    try {
      const match = /^\/socket\/([^/]+)(\/p\/.*)$/.exec(req.url);
      if (!match) { reject(404); return; }
      let origin;
      try { origin = new URL(decodeURIComponent(match[1])); } catch { throw new ProxyError('Invalid origin', 400); }
      if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) {
        throw new ProxyError('Invalid origin', 400);
      }
      const target = targetFromPath(match[2], allowPrivateTargets);
      const connection = await connectionFor(target);
      const session = sessionFor(req, { setHeader(name, value) { if (name === 'Set-Cookie') req.proxyCookie = value; } });
      const cookie = await session.jar.getCookieString(target.href);
      const protocols = req.headers['sec-websocket-protocol']?.split(',').map(value => value.trim());
      const headers = {};
      if (cookie) headers.cookie = cookie;
      if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
      const url = new URL(target);
      url.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      upstream = new WebSocket(url, protocols, { ...connection, headers, origin: origin.origin,
        handshakeTimeout: 15_000, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
      upstreamSockets.add(upstream);
      upstream.on('close', () => upstreamSockets.delete(upstream));
      upstream.on('error', () => reject(502));
      upstream.on('unexpected-response', (_request, response) => {
        response.resume();
        reject(response.statusCode >= 400 ? response.statusCode : 502);
        upstream.terminate();
      });
      socket.on('error', () => upstream.terminate());
      socket.on('close', () => {
        if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      });
      upstream.once('open', () => {
        if (socket.destroyed) { upstream.terminate(); return; }
        // The browser must see exactly the protocol selected by the upstream.
        const offered = req.headers['sec-websocket-protocol'];
        if (upstream.protocol) req.headers['sec-websocket-protocol'] = upstream.protocol;
        else delete req.headers['sec-websocket-protocol'];
        sockets.handleUpgrade(req, socket, head, downstream => {
          upgraded = true;
          req.headers['sec-websocket-protocol'] = offered;
          for (const [from, to] of [[downstream, upstream], [upstream, downstream]]) {
            from.on('message', (data, isBinary) => {
              if (to.readyState !== WebSocket.OPEN) return;
              if (to.bufferedAmount > 16 * 1024 * 1024) { to.close(1013, 'Connection too slow'); return; }
              to.send(data, { binary: isBinary }, error => { if (error) to.terminate(); });
            });
            from.on('close', (code, reason) => {
              if (to.readyState === WebSocket.OPEN) to.close(code === 1005 || code === 1006 ? 1000 : code, reason);
              else if (to.readyState === WebSocket.CONNECTING) to.terminate();
            });
            from.on('error', () => to.terminate());
          }
        });
      });
    } catch (error) {
      reject(error instanceof ProxyError ? error.status : 502);
      upstream?.terminate();
    }
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 15_000;
  server.on('close', () => {
    clearInterval(timer);
    for (const agent of Object.values(proxyAgents)) agent.destroy();
    for (const socket of sockets.clients) socket.terminate();
    for (const socket of upstreamSockets) socket.terminate();
    sockets.close();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createProxyServer().listen(port, '0.0.0.0', () => console.log(`Arigato listening on port ${port}`));
}
