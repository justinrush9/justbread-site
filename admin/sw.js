// JustBread admin service worker. Needed for "Add to Home screen" and, later,
// push notifications (Phase 7). No offline mode (SPEC.md section 9): every
// request goes to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
