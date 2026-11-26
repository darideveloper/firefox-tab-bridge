// Throwaway spike: iframe the opencode web app into Firefox's sidebar.
// No auth, no URL discovery — one pasted URL, stored, reloaded on open.
'use strict';

const urlInput = document.getElementById('url');
const note = document.getElementById('note');
let frame = document.getElementById('frame');

// Keeps the panel renderable when opened straight from disk for a look.
const store =
  typeof browser !== 'undefined'
    ? browser.storage.local
    : { get: async (fallback) => fallback, set: async () => {} };

function say(text, bad) {
  note.textContent = text || '';
  note.className = bad ? 'bad' : '';
}

function show(url) {
  // A fresh element is the only reliable way to re-attempt a cross-origin load.
  const next = document.createElement('iframe');
  next.id = 'frame';
  next.title = 'opencode';
  next.src = url;
  frame.replaceWith(next);
  frame = next;
  say(url);
}

function load() {
  const raw = urlInput.value.trim();
  if (!raw) return say('Paste the service URL first.', true);
  let url;
  try {
    url = new URL(raw).href;
  } catch (error) {
    return say('Not a URL: ' + raw, true);
  }
  store.set({ sidebarUrl: url });
  show(url);
}

document.getElementById('load').addEventListener('click', load);
document.getElementById('retry').addEventListener('click', () => {
  if (frame.src) show(frame.src);
  else load();
});
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') load();
});
urlInput.addEventListener('change', () => store.set({ sidebarUrl: urlInput.value.trim() }));

(async () => {
  const { sidebarUrl } = await store.get({ sidebarUrl: '' });
  if (!sidebarUrl) return say('Paste the URL of the local opencode service, then Load.');
  urlInput.value = sidebarUrl;
  show(sidebarUrl);
})();
