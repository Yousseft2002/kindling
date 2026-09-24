/* Where things are, and what is around them. OpenStreetMap, no key.
 *
 * Ported from the Python `geo.py` and `osm.py`, guards included - those were
 * learned from specific failures and are the difference between a plan and a
 * plausible-looking wrong answer:
 *
 *  - `bounded=1` with a viewbox, or searching "Ramiro" from Lisbon returns a
 *    Ramiro in Brazil and the plan is "verified" against another continent.
 *  - Transit noise filtered, or "aquarium" in Boston returns the New England
 *    Aquarium and then four subway stops named after it.
 *  - Compound locations resolved broadest-part-first. "Williamsburg, Brooklyn"
 *    finds nothing whole, and falling back to the specific part alone finds
 *    Williamsburg *Virginia* - a confident answer 500 km from the date. The
 *    container is resolved first and the specific part is only accepted if it
 *    is actually near it.
 */

import { getJSON, nominatim, memo, distanceKm, DAY } from './net.js';

const SEARCH = 'https://nominatim.openstreetmap.org/search';
const REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

/* How wide to look, by how you are getting around. Roughly 0.01 degrees is a
 * kilometre of latitude. */
const BOX = { walking: 0.02, bike: 0.05, transit: 0.08, rideshare: 0.10, car: 0.15 };
const DEFAULT_BOX = 0.08;

/* A named neighbourhood more than this far from the city it was said to be in
 * is a different place. */
const NEAR_KM = 150;

/* Reverse geocode at suburb level: 10 gives the whole city and 18 gives the
 * building you are standing in, and neither helps pick a bar. */
const REVERSE_ZOOM = 14;

const KIND_LABEL = {
  restaurant: 'Restaurant', bar: 'Bar', cafe: 'Café', pub: 'Pub',
  fast_food: 'Casual food', nightclub: 'Club', biergarten: 'Beer garden',
  theatre: 'Theatre', cinema: 'Cinema', arts_centre: 'Arts centre',
  museum: 'Museum', gallery: 'Gallery', attraction: 'Attraction',
  aquarium: 'Aquarium', zoo: 'Zoo', viewpoint: 'Viewpoint', park: 'Park',
  garden: 'Garden', marketplace: 'Market', books: 'Bookshop',
  wine: 'Wine shop', ice_cream: 'Ice cream', bakery: 'Bakery', deli: 'Deli',
};

export const SLOT_WORDS = {
  drinks: ['bar', 'pub'],
  food: ['restaurant', 'bistro'],
  coffee: ['cafe', 'coffee shop'],
  music: ['live music venue', 'jazz club'],
  show: ['theatre', 'cinema'],
  activity: ['museum', 'gallery'],
  aquarium: ['aquarium', 'zoo'],
  viewpoint: ['viewpoint', 'park'],
  shopping: ['market', 'bookshop'],
};

const NOISE_CATEGORIES = new Set(
  ['railway', 'highway', 'public_transport', 'barrier', 'waterway']);
const NOISE_TYPES = new Set([
  'station', 'platform', 'stop', 'stop_position', 'bus_stop', 'halt',
  'subway_entrance', 'tram_stop', 'parking', 'parking_entrance', 'toilets',
  'bicycle_parking', 'taxi', 'fuel', 'atm', 'bench', 'waste_basket',
]);

export function label(kind) {
  if (!kind) return '';
  return KIND_LABEL[kind] || (kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));
}

/** Best-effort closing time in minutes past midnight, or null.
 *
 *  Not a parser for the OSM opening_hours language - it takes the last clock
 *  time in the string, which is the closing time in every common shape:
 *    "Mo-Fr 09:00-18:00; Sa,Su 09:00-18:00" -> 18:00
 *    "Tu 17:00-02:00, We-Mo 12:00-02:00"    -> 02:00, i.e. open late
 *  A result before noon means it shuts after midnight, which no evening is
 *  going to hit, so that is reported as no limit. */
export function closesAt(hours) {
  if (!hours) return null;
  const found = [...String(hours).matchAll(/\b([0-2]?\d):([0-5]\d)\b/g)];
  if (!found.length) return null;
  const [, h, m] = found[found.length - 1];
  const mins = (+h) * 60 + (+m);
  return mins < 12 * 60 ? null : mins;
}

function usable(r) {
  if (!String(r.name || '').trim()) return false;
  if (NOISE_CATEGORIES.has(r.category) || NOISE_CATEGORIES.has(r.class)) return false;
  return !NOISE_TYPES.has(r.type);
}

function toVenue(r) {
  const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  const ex = r.extratags || {}, ad = r.address || {};
  const street = [ad.house_number, ad.road].filter(Boolean).join(' ');
  const town = ad.city || ad.town || ad.village || ad.suburb || '';
  return {
    name: r.name || String(r.display_name || '').split(',')[0],
    lat, lon,
    kind: label(r.type),
    cuisine: (ex.cuisine || '').replace(/_/g, ' ').replace(/;/g, ', '),
    openingHours: ex.opening_hours || '',
    website: ex.website || ex['contact:website'] || '',
    address: [street, town].filter(Boolean).join(', '),
  };
}

const box = t => BOX[t] ?? DEFAULT_BOX;
const viewbox = (lat, lon, b) => `${lon - b},${lat + b},${lon + b},${lat - b}`;

/** Free text -> candidate places, for the autocomplete. Open-Meteo's geocoder,
 *  which is the same service the forecast comes from, so the coordinates the
 *  plan uses and the weather uses always agree. */
export function suggest(query, count = 6) {
  const q = String(query || '').trim();
  if (q.length < 2) return Promise.resolve([]);
  return memo(`suggest:${q.toLowerCase()}:${count}`, DAY, async () => {
    const d = await getJSON(GEOCODE, { name: q, count, language: 'en', format: 'json' });
    return (d?.results || []).map(r => ({
      label: r.name || q,
      lat: +r.latitude, lon: +r.longitude,
      detail: [r.admin1, r.country].filter(Boolean).join(', '),
    }));
  });
}

/** The single best match for a typed location. See the note at the top about
 *  "Williamsburg, Brooklyn". */
export async function locate(query) {
  const q = String(query || '').trim();
  if (!q) return null;

  const whole = await suggest(q, 1);
  if (whole.length) return whole[0];

  const parts = q.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  // Broadest part first, to establish where we actually are.
  let anchor = null;
  for (const part of parts.slice(1).reverse()) {
    const got = await suggest(part, 1);
    if (got.length) { anchor = got[0]; break; }
  }

  const specific = await suggest(parts[0], 8);
  if (!anchor) return specific[0] || null;

  for (const c of specific) {
    if (distanceKm(c.lat, c.lon, anchor.lat, anchor.lon) <= NEAR_KM) return c;
  }
  return anchor;   // right city beats an identically named town elsewhere
}

/** Phone coordinates -> the neighbourhood someone would name. */
export function reverse(lat, lon) {
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return Promise.resolve(null);
  return memo(`rev:${lat.toFixed(3)}:${lon.toFixed(3)}`, DAY, async () => {
    const d = await nominatim(REVERSE, {
      lat, lon, zoom: REVERSE_ZOOM, format: 'jsonv2', addressdetails: 1,
    });
    const a = d?.address;
    if (!a) return null;
    const local = ['neighbourhood', 'suburb', 'quarter', 'city_district', 'borough',
                   'village', 'town', 'hamlet'].map(k => a[k]).find(Boolean) || '';
    const city = ['city', 'town', 'municipality', 'county', 'state']
                   .map(k => a[k]).find(Boolean) || '';
    const name = (local && city && local !== city) ? `${local}, ${city}`
               : (local || city || 'your current location');
    return { label: name, lat, lon, detail: a.country || '' };
  });
}

/** Real places near a point, for one slot in the evening. This is what turns
 *  "a bar in a walkable part of town" into "The Alley Bar". */
export function nearby(slot, lat, lon, transport = 'walking', limit = 6) {
  if (lat == null || lon == null) return Promise.resolve([]);
  const key = `near:${slot}:${lat.toFixed(3)}:${lon.toFixed(3)}:${transport}`;
  return memo(key, DAY, async () => {
    const b = box(transport);
    for (const word of (SLOT_WORDS[slot] || [slot]).slice(0, 2)) {
      const d = await nominatim(SEARCH, {
        q: word, format: 'jsonv2', limit: limit * 2,
        addressdetails: 1, extratags: 1,
        viewbox: viewbox(lat, lon, b), bounded: 1,
      });
      const out = (d || []).filter(usable).map(toVenue).filter(Boolean).slice(0, limit);
      if (out.length) return out;
    }
    return [];
  });
}

/** Does this named place exist near here? Used to check the AI has not
 *  invented a venue, and to pin a real one on the map. */
export function lookup(name, lat, lon, transport = 'walking') {
  const n = String(name || '').trim();
  if (!n || lat == null || lon == null) return Promise.resolve(null);
  return memo(`find:${n.toLowerCase()}:${lat.toFixed(3)}:${lon.toFixed(3)}`, DAY, async () => {
    const d = await nominatim(SEARCH, {
      q: n, format: 'jsonv2', limit: 1, addressdetails: 1, extratags: 1,
      viewbox: viewbox(lat, lon, box(transport)), bounded: 1,
    });
    return (d && d.length) ? toVenue(d[0]) : null;
  });
}
