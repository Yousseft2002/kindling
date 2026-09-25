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

const VERSION = 'kindling-v4';
const ROOT = new URL('./', self.location);           // .../kindling/
const at = path => new URL(path, ROOT).toString();

// Everything needed to open the app with no network at all.
const SHELL = [
  at('./'),
  at('index.html'),
  at('app.js'),
  at('config.js'),
  at('community-tab.js'),
  at('lib/net.js'),
  at('lib/places.js'),
  at('lib/weather.js'),
  at('lib/wiki.js'),
  at('lib/plan.js'),
  at('lib/links.js'),
  at('lib/community.js'),
  at('privacy.html'),
  at('manifest.webmanifest'),
  at('icons/icon-192.png'),
  at('icons/icon-512.png'),
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll is all-or-nothing; one 404 would leave the app with no cache
      // at all, so each file is added on its own and failures are tolerated.
      .then(cache => Promise.allSettled(SHELL.map(url =>
        cache.add(new Request(url, { cache: 'no-cache' })))))
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

  // Live data - places, weather, photographs, map tiles, the community - is
  // never cached. A stale itinerary carrying yesterday's opening hours is
  // worse than an honest error, and the tiles are somebody else's bandwidth.
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network so a redeployed app is picked up, fall back
  // to the cached copy when there is no signal.
  //
  // Each page is cached as itself. This used to store every navigation as
  // "./", which was harmless while the app was one page; with a privacy page
  // beside it, reading that and then losing signal would open the privacy
  // page in place of the app.
  if (request.mode === 'navigate') {
    const key = new URL(url.pathname, url).toString();   // no ?query, no #fragment
    const page = key === at('index.html') ? at('./') : key;
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then(c => c.put(page, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(page)
          .then(hit => hit || caches.match(at('./')))
          .then(hit => hit || caches.match(at('index.html')))
          .then(hit => hit || Response.error()))
    );
    return;
  }

  // Static assets: serve the cached copy at once, and replace it in the
  // background with whatever the network says.
  //
  // This used to be plain cache-first, on the reasoning that the assets only
  // change when the app does and the app changing bumps VERSION. Both halves
  // of that were wrong. A deploy that does not touch this file leaves the
  // worker byte-identical, so the browser never reinstalls it and never
  // refetches anything - the published fix sat on the server while the app
  // kept serving the bug, which is exactly what happened on the first
  // redeploy. Remembering to bump a constant by hand is not a mechanism.
  //
  // So the page still opens instantly from cache, and the next open has the
  // new version. Nothing here is a document, so no one reads a half-updated
  // page: index.html is handled above, network-first.
  event.respondWith(
    caches.match(request).then(hit => {
      // `no-cache` revalidates with the server rather than trusting the
      // browser's own freshness lifetime. Without it the background refresh
      // is answered by the HTTP cache - GitHub Pages sends max-age=600 - and
      // a stale worker cache is simply refilled from a stale browser cache.
      // It costs one conditional request per asset and usually a 304.
      const fresh = fetch(request, { cache: 'no-cache' }).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then(c => c.put(request, copy)).catch(() => {});
        }
        return response;
      });
      // Offline with nothing cached is the only case that can still fail,
      // and it fails as the network would.
      return hit || fresh;
    })
  );
});
