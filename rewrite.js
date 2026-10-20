import { load } from 'cheerio';
import parseSrcset from 'parse-srcset';

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
  $('head').prepend(`<script src="/runtime.js" data-target="${escapeAttribute(base)}"></script>`);
  $('head').prepend(`<base href="${escapeAttribute(proxyUrl(base, target))}">`);
  return $.html();
}

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
