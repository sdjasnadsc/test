(() => {
  'use strict';
  const initial = document.currentScript.dataset.target;
  const prefix = '/p/';
  function originalLocation() {
    const match = /^\/p\/(https?)\/([^/]+)(\/.*)?$/.exec(location.pathname + location.search);
    return match ? `${match[1]}://${match[2]}${match[3] || '/'}` : initial;
  }
  const initialDocument = originalLocation();
  function map(value, explicitBase) {
    if (typeof value !== 'string' && !(value instanceof URL)) return value;
    value = String(value);
    if (!value || /^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(value)) return value;
    try {
      const local = new URL(value, location.href);
      if ((value.startsWith(prefix) || /^(?:https?:)?\/\//i.test(value)) && local.origin === location.origin && local.pathname.startsWith(prefix)) return local.href;
      const base = explicitBase || (originalLocation() === initialDocument ? initial : originalLocation());
      const url = new URL(/^(?:https?:)?\/\//i.test(value) && local.origin === location.origin ? local.pathname + local.search + local.hash : value, base);
      if (!['http:', 'https:'].includes(url.protocol)) return value;
      return `${location.origin}${prefix}${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}${url.hash}`;
    } catch { return value; }
  }
  globalThis.__arigatoProxyUrl = map;
  function report(type = 'navigate', message) {
    if (parent !== window) parent.postMessage({ source: 'arigato', type, url: originalLocation() + location.hash, title: document.title, message }, location.origin);
  }
  const fetch = window.fetch;
  window.fetch = function(input, init) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-Arigato-Origin', new URL(originalLocation()).origin);
    return fetch.call(this, input instanceof Request ? new Request(map(input.url), input) : map(input), { ...init, headers });
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const result = open.call(this, method, map(url), ...rest);
    this.setRequestHeader('X-Arigato-Origin', new URL(originalLocation()).origin);
    return result;
  };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => beacon(map(url), data);
  }
  if (window.EventSource) {
    const EventSource = window.EventSource;
    window.EventSource = class extends EventSource { constructor(url, options) { super(map(url), options); } };
  }
  for (const name of ['Worker', 'SharedWorker']) {
    if (!window[name]) continue;
    const NativeWorker = window[name];
    window[name] = class extends NativeWorker {
      constructor(url, options) { super(map(url), options); }
    };
  }
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(value, protocols) {
      let url = new URL(value, originalLocation());
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (url.hash) throw new DOMException('WebSocket addresses cannot contain fragments.', 'SyntaxError');
      if (url.origin === location.origin.replace(/^http/, 'ws')) {
        if (url.pathname.startsWith('/socket/')) { super(value, protocols); return; }
        url = new URL(url.pathname + url.search, originalLocation());
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      }
      if (['ws:', 'wss:'].includes(url.protocol)) {
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const upstreamScheme = url.protocol === 'wss:' ? 'https' : 'http';
        const pageOrigin = encodeURIComponent(new URL(originalLocation()).origin);
        super(`${scheme}//${location.host}/socket/${pageOrigin}/p/${upstreamScheme}/${url.host}${url.pathname}${url.search}`, protocols);
      } else { super(value, protocols); }
      this.addEventListener('error', () => report('network-error', `Connection to ${url.host} failed.`));
    }
  };
  window.open = url => { if (url) location.assign(map(url)); return null; };
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function(state, unused, url) {
      const result = original.call(this, state, unused, url == null ? url : map(url));
      report();
      return result;
    };
  }
  const setAttribute = Element.prototype.setAttribute;
  const urlAttrs = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data']);
  Element.prototype.setAttribute = function(name, value) {
    return setAttribute.call(this, name, urlAttrs.has(name.toLowerCase()) ? map(value) : value);
  };
  for (const [type, attrs] of [
    [HTMLAnchorElement, ['href']], [HTMLImageElement, ['src']], [HTMLScriptElement, ['src']],
    [HTMLLinkElement, ['href']], [HTMLIFrameElement, ['src']], [HTMLFormElement, ['action']],
    [HTMLSourceElement, ['src']], [HTMLMediaElement, ['src']], [HTMLVideoElement, ['poster']],
  ]) {
    for (const attr of attrs) {
      const descriptor = Object.getOwnPropertyDescriptor(type.prototype, attr);
      if (!descriptor?.set || !descriptor.configurable) continue;
      Object.defineProperty(type.prototype, attr, { ...descriptor, set(value) { descriptor.set.call(this, map(value)); } });
    }
  }
  // Registrations from remote sites must not take control of this host.
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = () => Promise.reject(new DOMException('Service workers are unavailable through this proxy.', 'NotSupportedError'));
  }
  document.addEventListener('click', event => {
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (!link || !link.hasAttribute('href')) return;
    const raw = link.getAttribute('href');
    if (!raw.startsWith('#')) link.setAttribute('href', map(raw));
    if (['_top', '_parent', '_blank'].includes(link.target)) link.target = '_self';
  }, true);
  document.addEventListener('submit', event => {
    const form = event.target;
    form.setAttribute('action', map(form.getAttribute('action') || originalLocation()));
    form.target = '_self';
  }, true);
  addEventListener('popstate', () => report());
  addEventListener('hashchange', () => report());
  addEventListener('keydown', event => { if (event.key === 'Escape') report('escape'); });
  addEventListener('DOMContentLoaded', () => report());
  addEventListener('load', () => report('loaded'));
  report();
})();
