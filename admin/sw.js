// JustBread admin service worker: needed for "Add to Home screen" and for
// push notifications (SPEC.md 9c). No offline mode: requests go to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'JustBread', {
    body: d.body || '', icon: '/admin/icons/icon-192.png', badge: '/admin/icons/icon-192.png', data: { url: d.url || '/admin/alerts/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/admin/alerts/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) if ('focus' in w) { w.navigate(url); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
