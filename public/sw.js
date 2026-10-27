/* Background notifications only. No page/API caching and no polling on visitors' devices. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { payload = null; }
  const title = typeof payload?.title === 'string' ? payload.title.slice(0, 140) : 'Pickup Hunt update';
  const body = typeof payload?.body === 'string' ? payload.body.slice(0, 350) : 'Open Pickup Hunt to see your latest hunt.';
  event.waitUntil((async () => {
    // Every push produces a visible notification, including when the page is open.
    await self.registration.showNotification(title, { body, icon: '/notification-icon.png', badge: '/notification-icon.png',
      tag: typeof payload?.tag === 'string' ? payload.tag.slice(0, 32) : 'pickup-hunt', data: { url: '/' }, timestamp: Date.parse(payload?.observedAt) || Date.now() });
    if (/^[a-f0-9]{64}$/.test(payload?.delivery?.id || '') && typeof payload?.delivery?.token === 'string') {
      try {
        await fetch('/api/push/receipt', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload.delivery) });
      } catch { /* A display receipt is best effort; do not redisplay the alert. */ }
    }
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'pickup-push-displayed' });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL('/', self.location.origin).href;
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) { await client.focus(); return; }
    }
    await self.clients.openWindow(target);
  })());
});
