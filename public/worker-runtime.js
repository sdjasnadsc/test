(() => {
  'use strict';
  const match = /^\/p\/(https?)\/([^/]+)(\/.*)?$/.exec(location.pathname + location.search);
  if (!match) return;
  const original = `${match[1]}://${match[2]}${match[3] || '/'}`;
  function map(value, base = original) {
    if (typeof value !== 'string' && !(value instanceof URL)) return value;
    const text = String(value);
    if (/^(data:|blob:|#)/i.test(text)) return value;
    try {
      const local = new URL(text, location.href);
      if ((text.startsWith('/p/') || /^(https?:)?\/\//i.test(text)) && local.origin === location.origin && local.pathname.startsWith('/p/')) return local.href;
      const url = new URL(/^(https?:)?\/\//i.test(text) && local.origin === location.origin ? local.pathname + local.search : text, base);
      if (!['http:', 'https:'].includes(url.protocol)) return value;
      return `${location.origin}/p/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}${url.hash}`;
    } catch { return value; }
  }
  globalThis.__arigatoProxyUrl = map;
  const nativeFetch = fetch;
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-Arigato-Origin', new URL(original).origin);
    return nativeFetch(input instanceof Request ? new Request(map(input.url), input) : map(input), { ...init, headers });
  };
  if (globalThis.XMLHttpRequest) {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      const result = open.call(this, method, map(url), ...rest);
      this.setRequestHeader('X-Arigato-Origin', new URL(original).origin);
      return result;
    };
  }
  if (globalThis.importScripts) {
    const nativeImport = importScripts;
    globalThis.importScripts = (...urls) => nativeImport(...urls.map(value => map(value)));
  }
  const NativeWebSocket = globalThis.WebSocket;
  if (NativeWebSocket) globalThis.WebSocket = class extends NativeWebSocket {
    constructor(value, protocols) {
      let url = new URL(value, original);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (url.hash) throw new DOMException('WebSocket addresses cannot contain fragments.', 'SyntaxError');
      if (url.origin === location.origin.replace(/^http/, 'ws')) {
        if (url.pathname.startsWith('/socket/')) { super(value, protocols); return; }
        url = new URL(url.pathname + url.search, original);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      }
      if (['ws:', 'wss:'].includes(url.protocol)) {
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const upstreamScheme = url.protocol === 'wss:' ? 'https' : 'http';
        super(`${scheme}//${location.host}/socket/${encodeURIComponent(new URL(original).origin)}/p/${upstreamScheme}/${url.host}${url.pathname}${url.search}`, protocols);
      } else { super(value, protocols); }
    }
  };
})();
