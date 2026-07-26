// ZOLA app service worker — makes the manager & team portals installable
// and keeps a cached shell so they open instantly (and survive a flaky
// connection). Network-first for live data, cache as a fallback.
const CACHE = 'zola-app-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never cache writes
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;      // always live for data
  e.respondWith(
    fetch(req)
      .then((res) => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return res; })
      .catch(() => caches.match(req))
  );
});
