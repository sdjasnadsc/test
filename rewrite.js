import { load } from 'cheerio';
import parseSrcset from 'parse-srcset';
import { init, parse } from 'es-module-lexer';

await init;

export function rewriteJavascript(source, base) {
  let imports;
  try { [imports] = parse(source); } catch { return source; }
  const replacements = [];
  for (const item of imports) {
    if (item.d === -2) continue; // import.meta
    if (item.n !== undefined && /^(?:\.{0,2}\/|https?:\/\/)/i.test(item.n)) {
      replacements.push({ start: item.d === -1 ? item.s - 1 : item.s,
        end: item.d === -1 ? item.e + 1 : item.e, value: JSON.stringify(proxyUrl(item.n, base)) });
    } else if (item.d >= 0 && item.n === undefined) {
      replacements.push({ start: item.s, end: item.e,
        value: `globalThis.__arigatoProxyUrl(${source.slice(item.s, item.e)},${JSON.stringify(base)})` });
    }
  }
  // Nested dynamic imports can overlap; retain the innermost replacements.
  let edge = source.length;
  for (const item of replacements.sort((a, b) => b.start - a.start)) {
    if (item.end > edge) continue;
    source = source.slice(0, item.start) + item.value + source.slice(item.end);
    edge = item.start;
  }
  return source;
}

export function proxyUrl(value, base) {
  if (!value || /^(?:#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(value.trim())) return value;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return value;
    return `/p/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch { return value; }
}

export function rewriteCss(css, base) {
  return css.replace(/url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\)\s]*))\s*\)/gi,
    (match, a, b, c) => `url(${JSON.stringify(proxyUrl(a ?? b ?? c, base))})`)
    .replace(/(@import\s+)(["'])([^"']+)\2/gi,
      (match, prefix, quote, url) => `${prefix}${quote}${proxyUrl(url, base)}${quote}`);
}

export function rewriteHtml(html, target) {
  const $ = load(html);
  let base = target;
  try { base = new URL($('base[href]').first().attr('href') || target, target).href; } catch {}
  $('base').remove();
  $('meta[http-equiv]').each((_, el) => {
    const node = $(el);
    const name = node.attr('http-equiv').toLowerCase();
    if (name === 'content-security-policy' || name === 'content-security-policy-report-only') node.remove();
    if (name === 'refresh') {
      node.attr('content', (node.attr('content') || '').replace(/(url\s*=\s*)(.*)$/i,
        (_, prefix, value) => prefix + proxyUrl(value.replace(/^["']|["']$/g, ''), base)));
    }
  });
  const attrs = ['href', 'src', 'action', 'formaction', 'poster', 'data', 'background', 'cite'];
  $('*').each((_, el) => {
    const node = $(el);
    for (const attr of attrs) {
      if (node.attr(attr) !== undefined) node.attr(attr, proxyUrl(node.attr(attr), base));
    }
    for (const attr of ['srcset', 'imagesrcset']) {
      if (node.attr(attr)) node.attr(attr, parseSrcset(node.attr(attr)).map(candidate =>
        [proxyUrl(candidate.url, base), candidate.w && `${candidate.w}w`, candidate.h && `${candidate.h}h`,
          candidate.d && `${candidate.d}x`].filter(Boolean).join(' ')).join(', '));
    }
    if (node.attr('style')) node.attr('style', rewriteCss(node.attr('style'), base));
    node.removeAttr('integrity').removeAttr('crossorigin').removeAttr('nonce');
    // Third-party worker scopes must not control the proxy's own origin.
    if (el.name === 'link' && /^(preconnect|dns-prefetch)$/i.test(node.attr('rel') || '')) node.remove();
  });
  $('style').each((_, el) => $(el).text(rewriteCss($(el).html() || '', base)));
  $('script:not([src])').each((_, el) => {
    const node = $(el);
    const type = (node.attr('type') || '').toLowerCase();
    if (!type || type === 'module' || /^(?:text|application)\/(?:java|ecma)script$/.test(type)) {
      node.text(rewriteJavascript(node.html() || '', base));
    } else if (type === 'importmap') {
      try {
        const data = JSON.parse(node.html());
        const entries = value => Object.fromEntries(Object.entries(value).map(([key, url]) =>
          [/^(?:\.{0,2}\/|https?:\/\/)/i.test(key) ? proxyUrl(key, base) : key,
            typeof url === 'string' ? proxyUrl(url, base) : url]));
        if (data.imports) data.imports = entries(data.imports);
        if (data.scopes) data.scopes = Object.fromEntries(Object.entries(data.scopes).map(([key, imports]) =>
          [proxyUrl(key, base), entries(imports)]));
        node.text(JSON.stringify(data).replaceAll('<', '\\u003c'));
      } catch {}
    }
  });
  $('head').prepend(`<script src="/runtime.js" data-target="${escapeAttribute(base)}"></script>`);
  $('head').prepend(`<base href="${escapeAttribute(proxyUrl(base, target))}">`);
  return $.html();
}

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
