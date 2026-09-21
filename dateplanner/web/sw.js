// Service worker: makes the app open instantly and survive losing signal.
//
// The realistic failure this is built for is not "offline at home", it is
// standing outside a bar with one bar of signal trying to remember which
// street the next stop is on. So the shell is cached hard, and the page keeps
// the last plan in localStorage - between them the app always opens to
// something useful.
//
// API calls are never cached. A stale itinerary with yesterday's forecast and
// yesterday's opening hours is worse than an honest error.

const VERSION = 'date-planner-v1';

// Everything needed to render the form with no network at all.
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll is all-or-nothing; one 404 would leave the app with no cache
      // at all, so each file is added on its own and failures are tolerated.
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Planning, geocoding and reverse lookups all need the network by
  // definition. Let them fail and let the page say so.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: try the network so a redeployed app is picked up, fall back
  // to the cached shell when there is no signal.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(VERSION).then(c => c.put('/', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/').then(hit => hit || Response.error()))
    );
    return;
  }

  // Static assets: cache first. They only change when the app does, and the
  // app changing bumps VERSION.
  event.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(VERSION).then(c => c.put(request, copy)).catch(() => {});
      }
      return response;
    }))
  );
});
