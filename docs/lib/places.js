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

/* Nominatim resolves a category through its special-phrase table, which is
 * keyed on short names. Multi-word guesses mostly return nothing at all:
 * "live music venue" and "jazz club" both score zero in Lisbon and in Boston,
 * two cities not short of either, while "jazz" alone finds Onda Jazz. Same
 * trap with "market", which finds nothing anywhere - the phrase is
 * "marketplace", and it finds Mercado da Ribeira and Quincy Market. Measured
 * against both cities, not guessed. */
export const SLOT_WORDS = {
  drinks: ['bar', 'pub'],
  food: ['restaurant', 'bistro'],
  coffee: ['cafe', 'coffee shop'],
  music: ['jazz', 'nightclub'],
  show: ['theatre', 'cinema'],
  activity: ['museum', 'gallery'],
  aquarium: ['aquarium', 'zoo'],
  viewpoint: ['viewpoint', 'park'],
  shopping: ['marketplace', 'bookshop'],
  // The adventure levels. Same measuring as above, around Concord MA: "peak"
  // finds Nashawtuc Hill, "beach" finds Walden Pond's two beaches, "cheese"
  // finds The Cheese Shop. "pond", "trail", "sledding" and "brewery" find
  // nothing at all, so they are not asked.
  treat: ['cheese', 'chocolate', 'bakery'],
  sweet: ['ice cream', 'bakery'],
  takeout: ['restaurant', 'bistro'],
  sled: ['peak'],
  hill: ['peak', 'viewpoint'],
  nature: ['nature reserve', 'park'],
  rink: ['ice rink'],
  plunge: ['beach'],
  swim: ['beach'],
};

/* Stops you drive or cycle to on purpose. A hill or a pond is rarely inside
 * the few streets a walking evening covers, and nobody minds a short drive to
 * the start of the fun. */
const OUTDOORS = new Set(['sled', 'hill', 'nature', 'plunge', 'swim']);
const OUTDOOR_BOX = 0.07;

/* Chains, by name. OpenStreetMap tags them with `brand`, but Nominatim does
 * not return that tag, so the only signal left is the name: Dunkin' came back
 * from Concord untagged. Not exhaustive - it is the chains that actually turn
 * up in date searches - and matched on the start of the name, so "Dunkin'
 * Donuts" and "Starbucks Reserve" count. */
const CHAINS = [
  'starbucks', 'dunkin', 'mcdonalds', 'subway', 'chipotle', 'panera', 'olive garden',
  'applebees', 'chilis', 'tgi fridays', 'cheesecake factory', 'pf changs', 'outback steakhouse',
  'red lobster', 'buffalo wild wings', 'five guys', 'shake shack', 'sweetgreen', 'cava',
  'dominos', 'pizza hut', 'papa johns', 'burger king', 'wendys', 'taco bell', 'kfc', 'popeyes',
  'panda express', 'ihop', 'dennys', 'cracker barrel', 'texas roadhouse', 'longhorn steakhouse',
  'bjs restaurant', 'yard house', 'dave and busters', 'dave busters', 'hard rock cafe',
  'legal sea foods', 'ruths chris', 'the capital grille', 'capital grille', 'mortons',
  'flemings', 'smith and wollensky', 'bonefish grill', 'carrabbas', 'maggianos',
  'california pizza kitchen', 'uno pizzeria', 'pizzeria uno', 'bertuccis', 'the 99',
  'friendlys', 'jersey mikes', 'jimmy johns', 'wingstop', 'raising canes', 'chick fil a',
  'in n out', 'whataburger', 'sonic drive in', 'arbys', 'dairy queen', 'cold stone',
  'baskin robbins', 'ben and jerrys', 'krispy kreme', 'insomnia cookies', 'tim hortons',
  'peets coffee', 'caribou coffee', 'costa coffee', 'caffe nero', 'pret a manger', 'pret',
  'nandos', 'wagamama', 'pizza express', 'zizzi', 'prezzo', 'bella italia', 'franco manca',
  'honest burgers', 'byron', 'gourmet burger kitchen', 'all bar one', 'slug and lettuce',
  'browns', 'jd wetherspoon', 'wetherspoon', 'greggs', 'leon', 'itsu', 'wasabi', 'yo sushi',
  'vapiano', 'telepizza', 'amc', 'regal', 'cinemark', 'odeon', 'vue', 'cineworld',
  'barnes and noble', 'whole foods', 'trader joes', 'total wine', 'bevmo', 'walmart', 'target',
  '7 eleven', 'cvs', 'walgreens',
];
const chainKey = s => fold(s).replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function isChain(name) {
  const n = chainKey(name);
  return CHAINS.some(c => n === c || n.startsWith(c + ' '));
}

/* Last resort for the music slot, matched against bar names. Deliberately
 * not the bare word "music": that returns Music Hall Place and Music Oval -
 * a street and a green - rather than anywhere you can hear a band. */
const MUSICAL = /\b(jazz|blues|fado|soul|vinyl|live|music|band|sessions)\b/i;

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
export function closesAt(hours, weekday = null) {
  if (!hours) return null;
  let text = String(hours);
  // Given the day of the evening (0 = Sunday), read that day's rule. The last
  // time in the whole string was the Sunday close: The Cheese Shop in Concord,
  // "Tu-Sa 10:00-17:30; Su 12:00-17:00", read as shutting at five on a
  // Saturday. Later rules override earlier ones, as in OSM. A day no rule
  // covers is a day it is shut, reported as 0 so nothing can be booked there.
  if (weekday != null && DAY_RE.test(text)) {
    let rule = null;
    for (const part of text.split(';')) {
      const m = part.trim().match(RULE_RE);
      if (m && covers(m[1], weekday)) rule = m[2];
    }
    if (rule == null || /\b(off|closed)\b/i.test(rule)) return 0;
    text = rule;
  }
  const found = [...text.matchAll(/\b([0-2]?\d):([0-5]\d)\b/g)];
  if (!found.length) return null;
  const [, h, m] = found[found.length - 1];
  const mins = (+h) * 60 + (+m);
  return mins < 12 * 60 ? null : mins;
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DAY_RE = /\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/;
const RULE_RE = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,?\s*)+)\s+(.+)$/;

/** Does "Mo-Fr", "Sa,Su" or "Fr-Mo" include this day? */
function covers(spec, weekday) {
  return spec.split(',').map(s => s.trim()).filter(Boolean).some(s => {
    const [a, b] = s.split('-').map(d => DAYS.indexOf(d.trim()));
    if (b == null || b < 0) return a === weekday;
    return a <= b ? weekday >= a && weekday <= b : weekday >= a || weekday <= b;
  });
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
  // What a place sits inside. "Main Beach" means nothing on its own; "Main
  // Beach, Walden Pond State Reservation" is somewhere you can drive to.
  const inside = String(r.display_name || '').split(',')[1]?.trim() || '';
  const within = inside && inside !== town && !/^\d/.test(inside) && inside !== ad.road ? inside : '';
  return {
    within,
    name: r.name || String(r.display_name || '').split(',')[0],
    lat, lon,
    kind: label(r.type),
    cuisine: (ex.cuisine || '').replace(/_/g, ' ').replace(/;/g, ', '),
    openingHours: ex.opening_hours || '',
    liveMusic: ex.live_music === 'yes',
    website: ex.website || ex['contact:website'] || '',
    address: [street || within, town].filter(Boolean).join(', '),
  };
}

const box = (t, slot) => Math.max(BOX[t] ?? DEFAULT_BOX, OUTDOORS.has(slot) ? OUTDOOR_BOX : 0);
const viewbox = (lat, lon, b) => `${lon - b},${lat + b},${lon + b},${lat - b}`;

/** Free text -> candidate places, for the autocomplete. Open-Meteo's geocoder,
 *  which is the same service the forecast comes from, so the coordinates the
 *  plan uses and the weather uses always agree. */
export function suggest(query, count = 6) {
  const q = String(query || '').trim();
  if (q.length < 2) return Promise.resolve([]);
  return memo(`suggest:${q.toLowerCase()}:${count}`, DAY, async () => {
    const d = await getJSON(GEOCODE, { name: q, count, language: 'en', format: 'json' });
    const all = (d?.results || []).map(r => ({
      label: r.name || q,
      lat: +r.latitude, lon: +r.longitude,
      detail: [r.admin1, r.country].filter(Boolean).join(', '),
    }));
    // The geocoder matches loosely: "Boston" also returns Brilliant, Alabama
    // and Moline, Kansas, which reads as a broken search. Keep the names that
    // start with what was typed - accents aside, so "Sao Paulo" keeps São
    // Paulo - unless that leaves nothing, when a loose match is the only help
    // on offer for a typo.
    const typed = fold(q.split(',')[0]);
    const close = all.filter(p => fold(p.label).startsWith(typed));
    return close.length ? close : all;
  });
}

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim();

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
    const b = box(transport, slot);
    for (const word of (SLOT_WORDS[slot] || [slot]).slice(0, 3)) {
      const d = await nominatim(SEARCH, {
        q: word, format: 'jsonv2', limit: limit * 2,
        addressdetails: 1, extratags: 1,
        viewbox: viewbox(lat, lon, b), bounded: 1,
      });
      const out = (d || []).filter(usable).map(toVenue).filter(Boolean).slice(0, limit);
      if (out.length) return out;
    }
    // Most places with a band on are tagged as an ordinary bar, so before
    // falling back to "somewhere with live music near Lisbon" - which is the
    // app admitting it does not know - read the bars it already fetched and
    // keep the ones that say they have music.
    if (slot === 'music') {
      const bars = await nearby('drinks', lat, lon, transport, limit);
      return bars.filter(v => v.liveMusic || MUSICAL.test(v.name)).slice(0, limit);
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
