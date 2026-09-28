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

  // Timing diagnostics: log when the device received the push and how
  // long after the server sent it. The server stamps every payload with
  // `sentAt` (see src/lib/push/send.ts). A large gap here means the push
  // was delivered late by the provider/OS — NOT a service-worker delay,
  // because showNotification runs immediately below. Visible in the
  // browser's service-worker console.
  const receivedAt = Date.now();
  const sentAt = payload.sentAt ? Date.parse(payload.sentAt) : NaN;
  if (Number.isFinite(sentAt)) {
    console.log(
      `[sw] push received at ${new Date(receivedAt).toISOString()} — ${receivedAt - sentAt}ms after server send`
    );
  } else {
    console.log(`[sw] push received at ${new Date(receivedAt).toISOString()}`);
  }

  const title = payload.title || 'New message';
  const options = {
    body: payload.body || '',
    // Valid production asset (the app's icon — see /logo.png in the web
    // manifest). A 404 icon can make strict platforms fail to display the
    // notification at all, so this must always resolve to a real file.
    icon: '/logo.png',
    badge: '/logo.png',
    // Same tag → a follow-up push for the same conversation replaces the
    // previous notification instead of stacking.
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag),
    data: { url: payload.url || '/inbox' },
  };

  // Always settle the push event. A rejected showNotification (missing
  // icon, revoked OS permission, unsupported platform) must never become
  // an unhandled rejection or leave the event dangling — the notification
  // just won't display, and we log enough to diagnose it without exposing
  // payload or credential material.
  event.waitUntil(
    self.registration.showNotification(title, options).catch((err) => {
      const reason =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: unknown }).message)
          : String(err);
      console.error('[sw] showNotification failed:', reason);
    }),
  );
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
