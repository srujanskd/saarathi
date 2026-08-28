/**
 * The only reason this file exists: Chrome will not install a page as an app
 * -- a real icon on her home screen rather than a bookmark -- unless the page
 * controls a service worker with a fetch handler.
 *
 * It caches nothing, deliberately. An overlay or a control page served stale
 * out of a cache mid-stream is a far worse bug than anything offline support
 * could buy on a LAN, and she has no way to clear a cache without a terminal.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
