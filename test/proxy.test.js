import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { createProxyServer } from '../server.js';
import { proxyUrl, rewriteHtml, rewriteCss, rewriteJavascript } from '../rewrite.js';
import { load } from 'cheerio';
import { WebSocket, WebSocketServer } from 'ws';

let upstream, proxy, locked, target, base, lockedBase;
let upstreamSockets, socketHeaders;
const html = '<!doctype html><html><head><title>Fixture</title><meta http-equiv="Content-Security-Policy" content="default-src none"><link rel="stylesheet" href="/style.css" integrity="invalid"></head><body><h1>Hello through Arigato</h1><a href="/next?x=1">Next</a><form action="/echo" method="post"><input name="message" value="hello"></form><img src="/image.png"><script src="/script.js"></script></body></html>';

async function start(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
before(async () => {
  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/next?redirected=yes', 'Set-Cookie': 'redirected=1; Path=/; HttpOnly' });
      res.end();
    } else if (url.pathname === '/cookie') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'visited=yes; Path=/; HttpOnly' });
      res.end(req.headers.cookie || 'none');
    } else if (url.pathname === '/echo') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers }));
    } else if (url.pathname === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('@import "./theme.css"; body {background:url(/image.png)}');
    } else if (url.pathname === '/image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } else if (url.pathname === '/script.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('window.fixtureLoaded = true;');
    } else if (url.pathname === '/module.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('import {x} from "/chunks/level.js"; export const load = name => import(`/chunks/${name}.js`);');
    } else if (url.pathname === '/denied') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<h1>Upstream refused</h1>');
    } else {
      const encoding = url.pathname === '/gzip' ? 'gzip' : url.pathname === '/brotli' ? 'br' : null;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      if (encoding) res.setHeader('Content-Encoding', encoding);
      res.end(encoding === 'gzip' ? gzipSync(html) : encoding === 'br' ? brotliCompressSync(html) : html);
    }
  });
  upstreamSockets = new WebSocketServer({ noServer: true,
    handleProtocols: protocols => protocols.has('game') ? 'game' : false });
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url === '/refuse-socket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    upstreamSockets.handleUpgrade(req, socket, head, connection => {
      socketHeaders = req.headers;
      connection.send('ready');
      connection.on('message', (data, isBinary) => connection.send(data, { binary: isBinary }));
    });
  });
  target = await start(upstream);
  proxy = createProxyServer({ allowPrivateTargets: true });
  base = await start(proxy);
  locked = createProxyServer();
  lockedBase = await start(locked);
});
after(async () => {
  for (const socket of upstreamSockets?.clients || []) socket.terminate();
  upstreamSockets?.close();
  await Promise.all([upstream, proxy, locked].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
});
const request = (path = '/', init) => fetch(base + proxyUrl(path, target), init);

test('serves the address-bar UI and a working health endpoint', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="address-form"/);
  assert.deepEqual(await (await fetch(base + '/health')).json(), { service: 'arigato', status: 'ok' });
});

test('rewrites links, images, forms and stylesheet URLs in a real upstream response', async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), null);
  const $ = load(await response.text());
  assert.equal($('h1').text(), 'Hello through Arigato');
  assert.equal($('a').attr('href'), proxyUrl('/next?x=1', target));
  assert.equal($('form').attr('action'), proxyUrl('/echo', target));
  assert.equal($('img').attr('src'), proxyUrl('/image.png', target));
  assert.equal($('link').attr('href'), proxyUrl('/style.css', target));
  assert.equal($('link').attr('integrity'), undefined);
  assert.equal($('meta[http-equiv]').length, 0);
  assert.equal($('script').first().attr('src'), '/runtime.js');
});

test('rewrites and follows redirects without leaving the proxy', async () => {
  const response = await request('/redirect', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), proxyUrl('/next?redirected=yes', target));
  const next = await fetch(base + response.headers.get('location'));
  assert.equal(next.status, 200);
  assert.match(await next.text(), /Hello through Arigato/);
});

test('forwards POST bodies and content types without leaking proxy credentials', async () => {
  const response = await request('/echo', {
    method: 'POST', body: 'message=hello%20world',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'codespaces-secret=nope', Authorization: 'Bearer proxy-secret' },
  });
  const data = await response.json();
  assert.equal(data.method, 'POST');
  assert.equal(data.body, 'message=hello%20world');
  assert.equal(data.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(data.headers.cookie, undefined);
  assert.equal(data.headers.authorization, undefined);
});

test('upstream cookies persist within a session and are isolated between sessions', async () => {
  const first = await request('/cookie');
  assert.equal(await first.text(), 'none');
  const cookie = first.headers.getSetCookie()[0].split(';')[0];
  assert.match(cookie, /^arigato_session=/);
  assert.equal(await (await request('/cookie', { headers: { Cookie: cookie } })).text(), 'visited=yes');
  assert.equal(await (await request('/cookie')).text(), 'none');
  assert.equal(await (await request('/cookie', { headers: { Cookie: 'arigato_session=' + 'a'.repeat(48) } })).text(), 'none');
});

test('rewrites CSS imports and image URLs', async () => {
  const response = await request('/style.css');
  const css = await response.text();
  assert.match(css, new RegExp(proxyUrl('/theme.css', target).replaceAll('.', '\\.')));
  assert.ok(css.includes(proxyUrl('/image.png', target)));
});

test('streams binary assets and JavaScript unchanged', async () => {
  assert.deepEqual(Buffer.from(await (await request('/image.png')).arrayBuffer()), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(await (await request('/script.js')).text(), 'window.fixtureLoaded = true;');
});

test('decodes gzip and brotli before rewriting HTML', async () => {
  for (const path of ['/gzip', '/brotli']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.ok((await response.text()).includes(proxyUrl('/next?x=1', target)));
  }
});

test('supports HEAD requests and preserves upstream failure statuses', async () => {
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const denied = await request('/denied');
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /Upstream refused/);
});

test('rejects private, loopback, metadata and nonstandard port destinations by default', async () => {
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://localhost./', 'http://metadata.google.internal/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://example.com:8443/']) {
    const response = await fetch(lockedBase + proxyUrl(url));
    assert.equal(response.status, 403, url);
  }
});

test('validates protocols and rejects credentials and malformed targets', async () => {
  assert.equal((await fetch(base + '/p/ftp/example.com/')).status, 400);
  assert.equal((await fetch(base + '/p/https/user:password@example.com/')).status, 400);
  assert.equal((await fetch(base + '/p/https/[]/')).status, 400);
  assert.equal((await fetch(base + '/not-found')).status, 404);
});

test('respects HTML base URLs, srcset data URLs and leaves anchor links intact', () => {
  const $ = load(rewriteHtml('<base href="https://cdn.example.com/assets/"><a href="#part">Part</a><img src="pic.png" srcset="data:image/png;base64,AAAA 1x, pic@2.png 2x"><style>.x{background:url(../bg.png)}</style>', 'https://example.com/page'));
  assert.equal($('a').attr('href'), '#part');
  assert.equal($('img').attr('src'), '/p/https/cdn.example.com/assets/pic.png');
  assert.equal($('img').attr('srcset'), 'data:image/png;base64,AAAA 1x, /p/https/cdn.example.com/assets/pic@2.png 2x');
  assert.ok($('style').html().includes('/p/https/cdn.example.com/bg.png'));
  assert.equal(proxyUrl('mailto:hello@example.com', target), 'mailto:hello@example.com');
  assert.equal(rewriteCss('a{background:url(data:image/png;base64,AAAA)}', target), 'a{background:url("data:image/png;base64,AAAA")}');
});

test('rewrites JavaScript module imports and computed dynamic imports', async () => {
  const response = await request('/module.js');
  assert.match(response.headers.get('content-type'), /javascript/);
  const code = await response.text();
  assert.ok(code.includes(JSON.stringify(proxyUrl('/chunks/level.js', target))));
  assert.ok(code.includes('globalThis.__arigatoProxyUrl(`/chunks/${name}.js`,'));
  const original = 'const text = "import(\\"/untouched.js\\")"; // import("/untouched.js")';
  assert.equal(rewriteJavascript(original, target), original);
  assert.ok(rewriteJavascript('import("./level.js", {with:{type:"json"}})', target).includes(JSON.stringify(proxyUrl('/level.js', target))));
});

test('rewrites inline modules and import maps while preserving JSON script data', () => {
  const $ = load(rewriteHtml('<script type="importmap">{"imports":{"game":"/game.js","/alias.js":"/real.js"},"scopes":{"/levels/":{"game":"/level-game.js"}}}</script><script type="module">import "game"; import("/level.js")</script><script type="application/json">{"url":"/unchanged"}</script>', target));
  const map = JSON.parse($('script[type=importmap]').html());
  assert.equal(map.imports.game, proxyUrl('/game.js', target));
  assert.equal(map.imports[proxyUrl('/alias.js', target)], proxyUrl('/real.js', target));
  assert.equal(map.scopes[proxyUrl('/levels/', target)].game, proxyUrl('/level-game.js', target));
  assert.ok($('script[type=module]').html().includes(JSON.stringify(proxyUrl('/level.js', target))));
  assert.equal($('script[type="application/json"]').html(), '{"url":"/unchanged"}');
});

test('bootstraps classic and module workers before game scripts run', async () => {
  const nativeGet = (path, headers) => new Promise((resolve, reject) => {
    http.get(base + proxyUrl(path, target), { headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
  const code = await nativeGet('/script.js', { 'Sec-Fetch-Dest': 'worker', 'Sec-Fetch-Mode': 'same-origin' });
  assert.ok(code.includes('globalThis.__arigatoProxyUrl = map'));
  assert.ok(code.indexOf('globalThis.__arigatoProxyUrl') < code.indexOf('window.fixtureLoaded'));
  const body = await nativeGet('/module.js', { 'Sec-Fetch-Dest': 'worker', 'Sec-Fetch-Mode': 'cors' });
  assert.ok(body.startsWith('import "/worker-runtime.js";'));
});

test('forwards the originating game website origin to cross-host APIs', async () => {
  const response = await request('/echo', { method: 'POST', headers: { 'X-Arigato-Origin': 'https://game.example/level/1' } });
  const data = await response.json();
  assert.equal(data.headers.origin, 'https://game.example');
  assert.equal(data.headers['x-arigato-origin'], undefined);
  assert.equal((await request('/echo', { headers: { 'X-Arigato-Origin': 'data:fake' } })).status, 400);
});

test('tunnels game WebSockets with cookies, origin, subprotocols, text and binary frames', async () => {
  const cookieResponse = await request('/cookie');
  await cookieResponse.text();
  const cookie = cookieResponse.headers.getSetCookie()[0].split(';')[0];
  const path = `/socket/${encodeURIComponent(target)}${proxyUrl('/game-socket', target)}`;
  const client = new WebSocket(base.replace(/^http/, 'ws') + path, ['other', 'game'], { headers: { Cookie: cookie } });
  try {
    const ready = once(client, 'message');
    await once(client, 'open');
    assert.equal((await ready)[0].toString(), 'ready');
    assert.equal(client.protocol, 'game');
    assert.equal(socketHeaders.origin, target);
    assert.equal(socketHeaders.cookie, 'visited=yes');
    const text = once(client, 'message');
    client.send('begin descent');
    assert.equal((await text)[0].toString(), 'begin descent');
    const binary = once(client, 'message');
    client.send(Buffer.from([0, 1, 255]));
    const [data, isBinary] = await binary;
    assert.equal(isBinary, true);
    assert.deepEqual(data, Buffer.from([0, 1, 255]));
  } finally { client.close(); await once(client, 'close'); }
});

test('WebSocket upgrades enforce the same private destination restrictions', async () => {
  const status = await new Promise((resolve, reject) => {
    const client = new WebSocket(lockedBase.replace(/^http/, 'ws') + '/socket/https%3A%2F%2Fexample.com/p/http/127.0.0.1/');
    client.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); client.terminate(); });
    client.on('error', error => { if (!/closed before/.test(error.message)) reject(error); });
  });
  assert.equal(status, 403);
});

test('refused WebSocket handshakes preserve the upstream status and leave the proxy healthy', async () => {
  const path = `/socket/${encodeURIComponent(target)}${proxyUrl('/refuse-socket', target)}`;
  const status = await new Promise((resolve, reject) => {
    const client = new WebSocket(base.replace(/^http/, 'ws') + path);
    client.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); client.terminate(); });
    client.on('error', error => { if (!/closed before/.test(error.message)) reject(error); });
  });
  assert.equal(status, 403);
  assert.equal((await fetch(base + '/health')).status, 200);
});
