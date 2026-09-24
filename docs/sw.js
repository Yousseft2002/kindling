/* Service worker: makes Kindling open instantly and survive losing signal.
 *
 * The realistic failure this is built for is not "offline at home", it is
 * standing outside a bar with one bar of signal trying to remember which
 * street the next stop is on. So the shell is cached hard, and the page keeps
 * the last plan in localStorage - between them the app always opens to
 * something useful.
 *
 * Every path here resolves against the worker's own location rather than
 * being written as "/...". A GitHub Pages project site lives at
 * you.github.io/kindling/, where an absolute "/" points at the domain root
 * and would cache the wrong thing, or nothing at all.
 */

const VERSION = 'kindling-v1';
const ROOT = new URL('./', self.location);           // .../kindling/
const at = path => new URL(path, ROOT).toString();

// Everything needed to open the app with no network at all.
const SHELL = [
  at('./'),
  at('index.html'),
  at('app.js'),
  at('lib/net.js'),
  at('lib/places.js'),
  at('lib/weather.js'),
  at('lib/wiki.js'),
  at('lib/plan.js'),
  at('lib/links.js'),
  at('manifest.webmanifest'),
  at('icons/icon-192.png'),
  at('icons/icon-512.png'),
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

  // Live data - places, weather, photographs, map tiles - is never cached.
  // A stale itinerary carrying yesterday's opening hours is worse than an
  // honest error, and the tiles are somebody else's bandwidth.
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network so a redeployed app is picked up, fall back
  // to the cached shell when there is no signal.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(VERSION).then(c => c.put(at('./'), copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(at('./'))
          .then(hit => hit || caches.match(at('index.html')) || Response.error()))
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
