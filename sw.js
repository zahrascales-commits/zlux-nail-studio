// ZOLA app service worker — makes the manager & team portals installable,
// keeps a cached shell so they open instantly (and survive a flaky
// connection), and receives push notifications when the app is closed.
// Network-first for live data, cache as a fallback.
const CACHE = 'zola-app-v2';

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

/* ── PUSH ──────────────────────────────────────────────────────────────
   This is what runs when a booking lands and the phone is locked. The
   payload is JSON from the server; a malformed one still shows something
   rather than swallowing the alert entirely.                            */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  const title = d.title || 'ZOLA Nail Studio';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/img/zola-icon.png',
    badge: '/img/zola-icon.png',
    // An open appointment stays on screen until it is dealt with — that is
    // the whole point of a race only one person can win.
    requireInteraction: !!d.requireInteraction,
    vibrate: [90, 50, 90],
    // A matching tag replaces rather than stacks, so "taken" overwrites
    // "open" instead of leaving a dead offer on the lock screen.
    tag: d.tag || 'zola',
    renotify: true,
    data: { url: d.url || '/team.html', ...(d.data || {}) },
  }));
});

// Tapping it should land on the right screen — and reuse a window that is
// already open rather than piling up new ones.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/team.html';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(target.split('?')[0]) && 'focus' in c) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(target); } catch (_) {} }
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
