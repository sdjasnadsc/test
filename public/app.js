'use strict';
const form = document.querySelector('#address-form');
const address = document.querySelector('#address');
const frame = document.querySelector('#page');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
const reload = document.querySelector('#reload');
let current = '';
let loadTimer;

function loading() {
  document.body.classList.add('loading');
  status.textContent = 'Finding your way there…';
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    document.body.classList.remove('loading');
    status.textContent = 'Still connecting. The website may be slow or unavailable.';
  }, 65_000);
}
function navigate(value) {
  error.hidden = true;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    current = url.href;
    address.value = current;
    document.querySelector('#empty-state').hidden = true;
    frame.hidden = false;
    reload.disabled = false;
    document.body.classList.add('browsing');
    loading();
    frame.src = `/p/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    error.textContent = 'Enter a valid website address, like https://example.com.';
    error.hidden = false;
    address.focus();
  }
}
form.addEventListener('submit', event => { event.preventDefault(); navigate(address.value); });
document.querySelectorAll('[data-url]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.url)));
document.querySelector('#home').addEventListener('click', () => {
  frame.src = 'about:blank';
  frame.hidden = true;
  document.querySelector('#empty-state').hidden = false;
  document.body.classList.remove('browsing', 'loading');
  clearTimeout(loadTimer);
  address.value = '';
  current = '';
  error.hidden = true;
  reload.disabled = true;
  document.title = 'Arigato';
  status.textContent = 'Your next destination awaits.';
  address.focus();
});
reload.addEventListener('click', () => {
  if (current) { loading(); frame.contentWindow.location.reload(); }
});
frame.addEventListener('load', () => {
  if (frame.hidden) return;
  clearTimeout(loadTimer);
  document.body.classList.remove('loading');
  try {
    const page = frame.contentDocument;
    const match = /^\/p\/(https?)\/([^/]+)(\/.*)?$/.exec(frame.contentWindow.location.pathname + frame.contentWindow.location.search);
    if (match) { current = `${match[1]}://${match[2]}${match[3] || '/'}${frame.contentWindow.location.hash}`; address.value = current; }
    const failed = page.title.includes('Could not connect');
    status.textContent = failed ? 'Could not connect. Try another address.' : (page.title || 'Page loaded');
    document.title = failed ? 'Arigato' : `${page.title || new URL(current).hostname} · Arigato`;
  } catch { status.textContent = 'This site cannot be displayed here.'; }
});
addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.source !== 'arigato') return;
  try {
    const url = new URL(event.data.url);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    current = url.href;
    if (document.activeElement !== address) address.value = current;
    if (event.data.title) status.textContent = String(event.data.title).slice(0, 200);
    if (event.data.type === 'navigate') loading();
  } catch {}
});
addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'l') {
    event.preventDefault(); address.focus(); address.select();
  }
});
