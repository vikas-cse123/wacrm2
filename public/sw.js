/*
 * Service worker for the CRM PWA.
 *
 * Two jobs:
 *   1. Make the app installable ("Add to Home Screen") — a registered
 *      service worker + web manifest is the install prerequisite on
 *      Android/Chrome, and Web Push requires one on every platform
 *      (including installed PWAs on iOS 16.4+).
 *   2. Receive `push` events and show a system notification; focus or
 *      open the inbox when the notification is clicked.
 *
 * Plain JS (no build step) so it can be served statically from /sw.js
 * at the origin root, which is required for a root-scope service worker.
 */

// Activate a new service worker immediately instead of waiting for all
// tabs to close, and take control of open pages so pushes work right
// after the first install.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'New message', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'New message';
  const options = {
    body: payload.body || '',
    icon: '/interscale-logo.png',
    badge: '/interscale-logo.png',
    // Same tag → a follow-up push for the same conversation replaces the
    // previous notification instead of stacking.
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag),
    data: { url: payload.url || '/inbox' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/inbox';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus an already-open app tab and route it to the target.
        for (const client of clientList) {
          if ('focus' in client) {
            client.focus();
            if ('navigate' in client) {
              try {
                client.navigate(targetUrl);
              } catch {
                /* cross-origin or detached — fall through to openWindow */
              }
            }
            return;
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }),
  );
});
