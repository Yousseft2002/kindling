/* A stand-in for the public APIs Kindling calls, for tests and screenshots.
 *
 * Installs itself over `fetch` and answers Open-Meteo, Nominatim and
 * Wikipedia with small, deterministic payloads shaped like the real ones -
 * so the whole planner runs offline, in Node or in a headless browser, and
 * produces the same evening every time.
 *
 * Usage (Node):     await import('./tools/mock-fetch.js')
 * Usage (browser):  load as a classic <script> before the app.
 */
(function install(root) {
  const NAMES = {
    bar: ['The Velvet Hour', 'Copper & Ash', 'Lantern Room', 'Nightjar Bar'],
    pub: ['The Crooked Fox', 'Harbour Arms'],
    restaurant: ['Maison Ember', 'Osteria Luce', 'Kaze Robata', 'Saffron & Salt', 'Little Fig', 'Brasa'],
    bistro: ['Bistro Nuit', 'Le Petit Four'],
    cafe: ['Moonbean Coffee', 'Paper Crane Café'],
    jazz: ['Blue Cellar Jazz', 'The Standard'],
    museum: ['Harbour Museum of Art', 'City Gallery of Light', 'The Glasshouse'],
    gallery: ['Studio Nine Gallery'],
    theatre: ['Majestic Theatre'], cinema: ['Rialto Picturehouse'],
  };
  const TYPE = { bar: 'bar', pub: 'pub', restaurant: 'restaurant', bistro: 'restaurant', cafe: 'cafe',
                 jazz: 'bar', museum: 'museum', gallery: 'gallery', theatre: 'theatre', cinema: 'cinema' };
  const CUISINE = ['french', 'italian', 'japanese', 'persian', 'mediterranean', 'steak_house'];

  function box(url) {
    const v = (url.searchParams.get('viewbox') || '-71.06,42.36,-71.05,42.35').split(',').map(Number);
    return { lon: (v[0] + v[2]) / 2, lat: (v[1] + v[3]) / 2, span: Math.abs(v[2] - v[0]) / 2 };
  }

  function search(url) {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const names = NAMES[q];
    if (!names) return [];
    const b = box(url);
    // Each kind of place in its own part of town, so pins do not stack.
    const turn = [...q].reduce((a, c) => a + c.charCodeAt(0), 0) % 7;
    return names.map((name, i) => ({
      name, type: TYPE[q], category: 'amenity', class: 'amenity',
      lat: String(b.lat + Math.sin(i * 2.1 + turn) * b.span * (0.2 + 0.06 * turn)),
      lon: String(b.lon + Math.cos(i * 2.1 + turn) * b.span * (0.2 + 0.06 * turn)),
      display_name: `${name}, ${10 + i} Harbour Street, Boston`,
      address: { house_number: String(10 + i), road: 'Harbour Street', city: 'Boston' },
      extratags: {
        opening_hours: 'Mo-Su 11:00-23:30',
        cuisine: TYPE[q] === 'restaurant' ? CUISINE[i % CUISINE.length] : undefined,
        website: `https://example.com/${name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        'diet:vegetarian': i % 2 ? 'yes' : undefined,
        'diet:vegan': i === 3 ? 'yes' : undefined,
      },
    }));
  }

  function answer(href) {
    const url = new URL(href);
    if (url.host === 'geocoding-api.open-meteo.com') {
      return { results: [{ name: 'Boston', latitude: 42.3555, longitude: -71.0565,
                           admin1: 'Massachusetts', country: 'United States' }] };
    }
    if (url.host === 'api.open-meteo.com') {
      const d = url.searchParams.get('start_date');
      return { daily: { weather_code: [1], temperature_2m_max: [21], temperature_2m_min: [13],
                        precipitation_probability_max: [10], wind_speed_10m_max: [9],
                        sunset: [`${d}T18:41`] } };
    }
    if (url.host === 'nominatim.openstreetmap.org') {
      if (url.pathname.includes('reverse')) {
        return { address: { neighbourhood: 'North End', city: 'Boston', country: 'United States' } };
      }
      return search(url);
    }
    if (url.host === 'en.wikipedia.org') {
      const n = url.searchParams.get('gsrsearch') || '';
      return { query: { pages: [{ title: n, fullurl: 'https://en.wikipedia.org/wiki/Example',
        coordinates: [{ lat: 42.3555, lon: -71.0565 }],
        thumbnail: { source: `https://upload.wikimedia.org/mock/${encodeURIComponent(n)}.jpg` },
        extract: `${n} is a much-loved landmark on the waterfront, lit up after dark.` }] } };
    }
    return null;
  }

  const real = root.fetch;
  root.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input.href || input.url;
    let body = null;
    try { body = answer(href); } catch { body = null; }
    if (body == null) return real ? real(input, init) : new Response('null', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})(globalThis);
