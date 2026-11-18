// Stroll's service worker. It has one job: when the computer says something needs you and
// the app isn't open, show that as a notification, and open the right screen when it's
// tapped. It keeps nothing: no cache, no copy of anything from the computer.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Where a notification leads: only the screens the app has, never an address from the message.
const hashOf = view => (view && ['run', 'session', 'workflow'].includes(view.type) && /^[\w-]+$/.test(String(view.id)) ? `#/${view.type}/${view.id}` : '#/');

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data.json(); } catch (_) { /* shown as a bare notification */ }
  const hash = hashOf(m.view);
  e.waitUntil(self.registration.showNotification(String(m.title || 'Stroll'), {
    body: String(m.body || ''),
    icon: 'icon.png',
    tag: hash, // one notification per session or run: a newer one replaces it
    renotify: true,
    data: { hash },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hash = e.notification.data?.hash || '#/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(open => {
    const app = open[0];
    if (!app) return self.clients.openWindow(new URL(`./${hash}`, self.registration.scope).href);
    app.postMessage({ hash });
    return app.focus();
  }));
});
