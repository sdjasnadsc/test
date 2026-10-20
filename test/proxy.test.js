import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { createProxyServer } from '../server.js';
import { proxyUrl, rewriteHtml, rewriteCss } from '../rewrite.js';
import { load } from 'cheerio';

let upstream, proxy, locked, target, base, lockedBase;
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
  target = await start(upstream);
  proxy = createProxyServer({ allowPrivateTargets: true });
  base = await start(proxy);
  locked = createProxyServer();
  lockedBase = await start(locked);
});
after(async () => {
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
