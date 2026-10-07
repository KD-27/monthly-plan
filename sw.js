/* Monthly Plan — the offline copy of the app, for the phone.

   The page itself is fetched fresh whenever there's a connection, so an update
   pushed to GitHub reaches the phone the next time it opens; with no signal (or
   a slow one) the last copy opens instead. The log isn't kept here — Firestore
   keeps that on the device and syncs it. Registered only over https, so the
   laptop's local server is never cached. */
const CACHE = 'monthly-plan-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon/icon-192.png', './icon/icon-512.png',
               './icon/maskable-192.png', './icon/maskable-512.png', './icon/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (req, res) => { if (res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };
/** The network, unless it's gone or takes longer than a few seconds — then the saved copy. */
function fresh(req){
  const saved = () => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'));
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => saved().then(r => { if (r && !done){ done = true; resolve(r); } }), 4000);
    fetch(req).then(res => { clearTimeout(timer); if (!done){ done = true; resolve(keep(req, res)); } else keep(req, res); })
      .catch(() => { clearTimeout(timer); if (!done){ done = true; saved().then(resolve); } });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin){
    if (url.pathname.endsWith('/config.local.js')) return;   // never published; the cloud sends the settings
    e.respondWith(fresh(req));
  } else if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')){
    // the version is in the address, so a saved copy is always the right one
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => keep(req, res))));
  }
});
