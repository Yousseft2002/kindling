/* Building the evening.
 *
 * Ported from the Python planner. The division of labour is the same and it
 * is the thing that makes the output usable: taste lives in the copy and the
 * slot choices, arithmetic lives in `check()`. The composer can be wrong
 * about whether a bar is nice; it is never wrong about whether the sums add
 * up, the clock is continuous, or the aquarium has shut.
 */

import { nearby, lookup, closesAt, isChain } from './places.js';
import { look as wikiLook } from './wiki.js';
import * as wx from './weather.js';
import { distanceKm } from './net.js';
import { attachLinks } from './links.js';

/* --- what the answers mean ------------------------------------------- */

export const STAGES = {
  first_date: { maxStops: 3, maxHours: 3.0,
    blurb: 'First meeting, probably from an app. Never met in person, or barely.' },
  getting_to_know: { maxStops: 4, maxHours: 4.0,
    blurb: 'Dates two through five. Interested, still auditioning.' },
  dating: { maxStops: 5, maxHours: 6.0,
    blurb: 'Established and exclusive. Months in. Comfortable.' },
  long_term: { maxStops: 5, maxHours: 6.0,
    blurb: 'Years in. Living together or close to it. Routine is the enemy.' },
  special_occasion: { maxStops: 5, maxHours: 6.0,
    blurb: 'Anniversary, birthday, celebration, or making up for something.' },
};

export const STYLES = {
  casual: 'Jeans, sneakers, t-shirt.',
  smart_casual: 'Dark denim or chinos, shirt or good knit, clean shoes.',
  dressy: 'Cocktail dress, blazer, heels, leather shoes.',
  formal: 'Suit, gown, jacket-required territory.',
  streetwear: 'Sneakers as the point, not the compromise. Loud is fine.',
  outdoorsy: 'Boots, layers, a jacket that can get rained on.',
};

export const TRANSPORT = {
  walking: 'On foot only.',
  transit: 'Bus, metro, subway, tram.',
  car: 'Own car. Parking is a real constraint.',
  rideshare: 'Uber/Lyft/taxi, paid per trip out of the same budget.',
  bike: 'Bikes or bikeshare.',
};

const HOP_LIMIT = { walking: 15, bike: 15, transit: 25, car: 20, rideshare: 20 };
const RADIUS_KM = { walking: 1.5, bike: 4, transit: 6, car: 12, rideshare: 8 };

/* How each way of getting around covers a city: km/h, the minutes it costs
 * before you move (finding the stop, the car park, the driver), and how to
 * say it. Straight-line distance times DETOUR is roughly the street route. */
const DETOUR = 1.3;
const PACE = {
  walking: [4.8, 0, 'on foot'],
  bike: [14, 3, 'by bike'],
  transit: [18, 8, 'by bus or metro'],
  car: [25, 8, 'by car, parking included'],
  rideshare: [25, 5, 'by taxi or rideshare'],
};
/* Nobody takes a car or waits for a tram to go somewhere this close. */
const JUST_WALK = 12;

/* The badge on a card for a place that came from the community rather than
 * the map search, by the kind of stop it was shared as. */
const LOCAL_KIND = {
  drinks: 'Bar', coffee: 'Café', food: 'Restaurant', music: 'Live music', show: 'Show',
  activity: 'Museum or gallery', aquarium: 'Aquarium', viewpoint: 'Viewpoint', shopping: 'Shop',
  treat: 'Local shop', sweet: 'Ice cream', takeout: 'Restaurant', sled: 'Outdoors', hill: 'Outdoors',
  nature: 'Outdoors', plunge: 'Outdoors', swim: 'Outdoors', rink: 'Ice rink',
};

/* Which kind of shared stop from the Community tab can fill each slot. */
const COMMUNITY_KIND = {
  treat: 'treat', sweet: 'treat', takeout: 'food', sled: 'outdoors', hill: 'outdoors', nature: 'outdoors',
  plunge: 'outdoors', swim: 'outdoors', rink: 'activity',
};

/* How brave the evening is. Level 2 is the planner as it always was; the
 * rest change which kinds of stop the night is made of - see slotsFor(). */
export const ADVENTURE = {
  1: ['Stay in', 'Local treats, dinner picked up on the way home, then blankets and a film chosen for the season.'],
  2: ['Easy', 'A drink, something to look at, and a good dinner. The classic, done well.'],
  3: ['Curious', 'Starts somewhere you would never have found: a cheese shop, a chocolatier, a bookshop.'],
  4: ['Outdoorsy', 'Outside first: sledding if there is snow, a hill at sunset if not. Then warm up somewhere local.'],
  5: ['Wild', 'A cold plunge in the nearest pond, a hot drink, and a big dinner. Not for the faint-hearted.'],
};

/* Minutes and share of budget per slot. Dinner gets the money and the time;
 * everything else is there to make dinner better. */
const SHAPE = {
  drinks: [50, 0.16], coffee: [40, 0.08], aquarium: [75, 0.22],
  activity: [70, 0.18], show: [110, 0.30], music: [70, 0.20],
  viewpoint: [40, 0.00], shopping: [35, 0.05], food: [95, 0.50],
  treat: [30, 0.10], sweet: [25, 0.06], takeout: [30, 0.35], home: [150, 0.00],
  sled: [75, 0.00], hill: [60, 0.00], nature: [70, 0.00], rink: [60, 0.12],
  plunge: [30, 0.00], swim: [60, 0.00],
};

/* Slot -> the kind recorded on the stop, which drives the booking link and
 * whether a missing venue is worth warning about. */
const AS_KIND = {
  aquarium: 'activity', coffee: 'coffee', drinks: 'drinks', activity: 'activity',
  music: 'music', show: 'show', viewpoint: 'viewpoint', shopping: 'shopping',
  food: 'food', treat: 'shopping', sweet: 'shopping', takeout: 'food', home: 'home', rink: 'activity',
  sled: 'outdoors', hill: 'outdoors', nature: 'outdoors', plunge: 'outdoors', swim: 'outdoors',
};
const OUTSIDE = new Set(['viewpoint', 'outdoors']);

/* The weekday of the evening being planned, so opening hours are read for that
 * day. Set by build(); null means read them the old, day-blind way. */
let weekday = null;
const closes = hours => closesAt(hours, weekday);

/* A night in still needs a film, and the season should choose it. */
const FILMS = {
  1: ['About Time', 'Paddington 2'], 2: ['Before Sunrise', 'Crazy, Stupid, Love'],
  3: ['Amélie', 'Notting Hill'], 4: ['Notting Hill', 'The Princess Bride'],
  5: ['La La Land', 'Mamma Mia!'], 6: ['Mamma Mia!', 'Jaws'], 7: ['Jaws', 'Dirty Dancing'],
  8: ['Dirty Dancing', 'La La Land'], 9: ['The Princess Bride', 'When Harry Met Sally'],
  10: ['Hocus Pocus', 'Practical Magic'], 11: ['When Harry Met Sally', 'Knives Out'],
  12: ['Home Alone', 'Elf', 'The Holiday'],
};

/* Kinds that should exist as a listing, so a miss means something. A walk
 * described as "the waterfront" is not a listing and flagging it would cry
 * wolf on every plan. */
const VERIFIABLE = new Set(['food', 'drinks', 'coffee', 'music', 'show', 'activity', 'shopping']);
const PHOTO_KINDS = new Set(['activity', 'show', 'music', 'viewpoint', 'outdoors']);

/* Written to sound like someone who has been there. The alternative - "a
 * specialist coffee bar in a walkable part of town" - is what this said
 * before it had any data, and it read like a form letter. */
const COPY = {
  drinks: ['Start here. One drink, somewhere with a bit of noise, while you work out what kind of night this is.',
           'A drink first: cheap, short, and it gives you something to do with your hands.'],
  coffee: ['Coffee first - low stakes, easy to leave, and you can always upgrade to a drink after.',
           'Somewhere to sit down before anything is decided.'],
  aquarium: ['The good part of the evening. Nobody runs out of things to say in front of a tank of fish.',
             'This is the stop that does the work: something to look at, and something to react to.'],
  activity: ['The part you will actually talk about afterwards. Wander, disagree about something, move on.',
             'Enough to look at that the conversation writes itself.'],
  music: ['If the night is still going, this is where it goes. Optional by design.',
          'Something to end on that is not another drink in another room.'],
  show: ['The anchor of the evening - check what is actually on before you commit.',
         'Book this one. Turning up hopeful is how you end up eating crisps for dinner.'],
  viewpoint: ['Free, outdoors, and the light does the work for you.',
              'Start above the noise. It costs nothing and it sets the whole evening up.'],
  shopping: ['Twenty minutes of poking about. You learn more about someone here than over dinner.',
             'Cheap, warm, and full of things to have an opinion about.'],
  food: ['Dinner, and the only stop worth booking ahead.',
         'The anchor. Everything before this was warm-up.'],
  treat: ['Somewhere small and local. Ask what they would take home tonight, and taste before you buy.',
          'A local shop worth the detour - the kind of place that knows its regulars by name.'],
  takeout: ['Dinner from somewhere the neighbourhood actually eats. Call ahead so it is hot when you get there.',
            'Pick up dinner on the way home. Order one thing neither of you has tried.'],
  sled: ['Sledding, while there is still light. Race to the bottom; the loser buys the treats.',
         'Bring a sled, or a bin bag if you must. Nobody stays cool on the way down.'],
  hill: ['Up the hill for the last of the light. Free, and the view does the talking.',
         'A short climb to somewhere with a view, timed for the sunset.'],
  nature: ['A walk in the woods before dinner, phones away. It is better than it sounds.',
           'Somewhere green and quiet to walk and actually talk.'],
  rink: ['Skating. Holding hands is structurally necessary here.',
         'An hour on the ice. Someone will fall over; it will be the best part.'],
  plunge: ['The cold plunge: in to the shoulders, a count of sixty, out. Together, never alone, with dry clothes laid out before you go in.',
           'Two minutes in cold water at most, feet first, then straight to somewhere warm. You will talk about it for years.'],
  swim: ['A swim before dinner. Stay where other people swim, and check for posted closures.',
         'In the water while it is still light. Swim where others do, and never alone.'],
};

COPY.sweet = ['Ice cream, eaten on the walk to dinner. Get two flavours and swap halfway.',
              'Something cold and sweet while your hair dries.'];

/* After cold water, the next stop is not "coffee", it is rescue. */
const WARM_UP = ['Hot drinks, fast. You have earned them.',
                 'Warm up here: the hottest thing on the menu and a seat by the heater.'];

/* The opener's lines say "start here", and respectHours moves the opener
 * behind anything that shuts early - which printed "Start here" on stop two,
 * after the aquarium. The same kinds of stop, for anywhere but first. */
const LATER = {
  drinks: ['One drink, somewhere with a bit of noise, to talk over what you just saw.',
           'A drink in between: cheap, short, and a chance to sit down.'],
  coffee: ['Somewhere to sit down and compare notes before anything else is decided.',
           'Coffee in between - low stakes, and easy to leave.'],
  viewpoint: ['Free, outdoors, and the light does the work for you.',
              'A breather above the noise. It costs nothing and the view does the talking.'],
};
const NIGHTCAP = ['One more, somewhere quieter, before you call it a night.',
                  'A nightcap. Short, and entirely optional.'];

/* --- time helpers ----------------------------------------------------- */
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const mins = s => { const [h, m] = String(s).split(':').map(Number);
                    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
export const endOf = stop => hhmm((mins(stop.start) ?? 0) + stop.minutes);

export const walkTime = s => !s.distanceM ? ''
  : s.distanceM < 1000 ? `${s.distanceM} m away` : `${(s.distanceM / 1000).toFixed(1)} km away`;

/* --- choosing the shape of the night ---------------------------------- */

/** Which kinds of stop this particular evening is made of.
 *
 *  This is where the answers stop being decoration. Someone who said
 *  "aquarium" and someone who said "jazz" should not get the same night, and
 *  in the rain neither should be marched up a hill to a viewpoint. */
export function slotsFor(prefs, weather) {
  const said = (prefs.interests || []).join(' ').toLowerCase();
  const wants = (...w) => w.some(x => said.includes(x));
  const level = Math.min(5, Math.max(1, Math.round(Number(prefs.adventure) || 2)));
  const month = Number(String(prefs.date || '').slice(5, 7)) || (new Date().getMonth() + 1);
  const winter = [12, 1, 2].includes(month);
  const snowy = /snow/i.test(weather?.summary || '')
    || (winter && weather?.highC != null && weather.highC <= 2);
  const warm = weather?.highC != null ? weather.highC >= 22 : [6, 7, 8].includes(month);
  const stormy = /thunder/i.test(weather?.summary || '');

  // A night in: something good from a local shop, dinner picked up on the
  // way, then home.
  if (level === 1) return ['treat', 'takeout', 'home'];

  // Outside first, in daylight - build() moves the start earlier to fit -
  // then somewhere local to warm up, then dinner. Concord in January:
  // Nashawtuc Hill, The Cheese Shop, dinner.
  if (level === 4 && !stormy) {
    let out = snowy ? 'sled' : wants('hike', 'walk', 'nature', 'woods', 'forest') ? 'nature' : 'hill';
    if (wants('skat', 'ice')) out = 'rink';
    else if (wx.isWet(weather) && !snowy) out = winter ? 'rink' : 'activity';
    return [out, 'treat', 'food'];
  }
  if (level === 5 && !stormy) return warm ? ['swim', 'sweet', 'food'] : ['plunge', 'coffee', 'food'];

  let anchor;
  if (wants('aquarium', 'fish', 'animal', 'zoo')) anchor = 'aquarium';
  else if (wants('skat')) anchor = 'rink';
  else if (wants('sled') && snowy) anchor = 'sled';
  else if (wants('hike', 'hiking', 'nature', 'woods') && !wx.isWet(weather)) anchor = 'nature';
  else if (wants('music', 'jazz', 'gig', 'band', 'live')) anchor = 'music';
  else if (wants('film', 'cinema', 'movie', 'theatre', 'theater', 'comedy')) anchor = 'show';
  else if (wants('art', 'museum', 'history', 'gallery', 'exhibition')) anchor = 'activity';
  else if (wants('book', 'vintage', 'record', 'market', 'shopping')) anchor = 'shopping';
  else if (wx.isWet(weather) || wx.isCold(weather)) anchor = 'activity';
  else anchor = 'viewpoint';

  const early = (mins(prefs.startTime) ?? 17 * 60) < 17 * 60;
  let opener = (prefs.stage === 'first_date' && early) ? 'coffee' : 'drinks';
  // Curious: open somewhere you would not have found on your own.
  if (level === 3 || wants('cheese', 'chocolate', 'bakery', 'dessert')) opener = 'treat';

  const slots = [opener, anchor, 'food'];
  // A closer, for the stages where the night can run on. It is a nightcap,
  // not a second helping of the anchor: someone who asked for jazz was
  // getting two music stops, which in a city with one tagged jazz bar meant
  // the same sentence printed twice.
  if (['dating', 'long_term', 'special_occasion'].includes(prefs.stage)) {
    slots.push(anchor === 'music' ? 'drinks' : 'music');
  }
  return slots;
}

/* --- building it ------------------------------------------------------ */

/** `locals` is what the community shared near here - see localPicks() in
 *  community.js. Optional: without it this is the plain map-data planner. */
export async function build(prefs, weather, onPhase = () => {}, locals = null) {
  const stage = STAGES[prefs.stage] || STAGES.getting_to_know;
  weekday = prefs.date ? new Date(prefs.date + 'T12:00').getDay() : null;
  const slots = slotsFor(prefs, weather);
  const known = new Map((locals?.picks || []).map(p => [p.name.toLowerCase(), p]));

  let t = mins(prefs.startTime) ?? 17 * 60;
  const gh = wx.goldenHour(weather);
  if (slots.includes('viewpoint') && gh && !wx.isWet(weather)) {
    const idx = slots.indexOf('viewpoint');
    const light = gh.start - (slots.length - idx - 1) * 70;
    t = Math.max(t, Math.min(t + 90, light));
  }
  // An adventure that starts outside starts in daylight. A 17:00 start in
  // January puts the sledding in the dark, so the evening moves earlier -
  // never before noon - and the plan says why.
  let timing = '';
  const firstOut = AS_KIND[slots[0]] === 'outdoors';
  if (firstOut && weather?.sunset) {
    const lit = Math.max(12 * 60, weather.sunset - SHAPE[slots[0]][0] - 10);
    if (lit < t) {
      timing = `Starts at ${hhmm(lit)} rather than ${hhmm(t)}, so you are outside while it is `
             + `light - sunset is ${hhmm(weather.sunset)}.`;
      t = lit;
    }
  }

  onPhase('Looking for places near you');
  const stops = [];
  const used = new Set();
  const opening = t;
  let from = prefs.lat != null ? { lat: prefs.lat, lon: prefs.lon } : null;
  let keep = null;          // the anchor: the stop built from what they said they like
  let left = prefs.budget;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const [minutes, share] = SHAPE[slot] || [60, 0.2];
    const cost = Math.round(Math.min(left, prefs.budget * share) * 100) / 100;
    const last = i === slots.length - 1;

    // Anything but dinner may be moved to the front by respectHours, so it
    // only has to be open for half an hour after the evening starts. Dinner
    // always ends the night, so it has to stay open to the end of it.
    const needUntil = slot === 'food' ? t + minutes : opening + 30;
    let venue = null;
    if (slot !== 'home') {
      const hits = await nearby(slot, prefs.lat, prefs.lon, prefs.transport, 6);
      venue = pick(withLocals(hits, slot, locals, prefs), used,
                   { from, needUntil, known, localOnly: prefs.localOnly });
      if (venue) from = venue;
    }

    const stop = slot === 'home' ? homeStop(prefs, t, minutes)
      : venue ? realStop(slot, venue, prefs, t, minutes, cost, last)
      : placeholder(slot, prefs, t, minutes, cost, last);
    const said = venue && known.get(venue.name.toLowerCase());
    if (said) stop.locals = { posts: said.posts, loves: said.loves, notes: said.notes.slice(0, 2) };
    // An unfillable slot produces the same sentence every time, so two of
    // them read as "somewhere with live music near Boston" twice - which is
    // the app looking broken rather than looking honest. Skip the repeat and
    // spend neither the time nor the budget on it.
    if (used.has(stop.name.toLowerCase())) continue;

    stops.push(stop);
    used.add(stop.name.toLowerCase());
    if (i === 1) keep = stop.name;
    left = Math.max(0, left - cost);
    t += minutes + (last ? 0 : 12);
  }

  // Daylight is a closing time too, for anything outside.
  const sunset = weather?.sunset ?? null;
  respectHours(stops, sunset);
  legs(stops, prefs.transport);
  fitWindow(stops, Math.min(stage.maxHours, prefs.hours), prefs.transport, keep);
  closeOnTime(stops, sunset);
  retell(stops);

  onPhase('Finding a photograph');
  for (const s of stops) {
    if (s.verified && PHOTO_KINDS.has(s.kind)) {
      const shot = await wikiLook(s.name, s.lat, s.lon);
      if (shot) { s.photo = shot.photo; s.blurb = shot.blurb; s.photoCredit = shot.url; }
    }
  }

  const total = stops.reduce((a, s) => a + s.cost, 0);
  const named = stops.filter(s => s.verified).map(s => s.name);
  const anchorStop = stops.find(s => ['activity', 'music', 'show', 'outdoors'].includes(s.kind) && s.verified);
  const where = (prefs.location || '').split(',')[0];
  const home = stops.some(s => s.kind === 'home');

  const plan = {
    title: home ? 'A night in, done properly'
         : anchorStop ? `${anchorStop.name}, and either side of it`
         : `An evening around ${where}`,
    adventure: ADVENTURE[Math.min(5, Math.max(1, Math.round(Number(prefs.adventure) || 2)))][0],
    timing,
    pitch: named.length >= 2
      ? `${named[0]}, then ${named[1]}${named[2] ? `, then ${named[2]}` : ''}`
        + ` - about ${prefs.currency} ${Math.round(total)} for two.`
      : `A night around ${where} for about ${prefs.currency} ${Math.round(total)}, for two.`,
    stops,
    totalCost: Math.round(total * 100) / 100,
    transportNote: transportNote(prefs, stops),
    weatherCall: weatherNote(weather, stops),
    wear: wear(prefs, weather, slots),
    backup: `${named[0] || where} is the one to check before you leave - opening hours `
          + `move, and everything else here is close enough to swap at short notice.`,
    // Real People's Insights: the best-loved evenings locals shared near here,
    // kept on the plan so they are still there offline.
    insights: (locals?.posts || []).slice(0, 3).map(p => ({
      id: p.id, title: p.title, author: p.author_name, guide: !!p.author_is_guide,
      loves: p.love_count || 0, city: p.city, stops: (p.stops || []).map(s => s.name),
    })),
  };

  attachLinks(plan, prefs.location);
  plan.warnings = check(plan, prefs, weather);
  return plan;
}

/** The candidate to use. Never one already in the plan, and never one that
 *  has shut before it is needed: this used to take the first place with
 *  published hours whatever they said, and a Chicago evening sent you to a
 *  museum that closes at four and a lunch counter that closes at five. Then
 *  published hours - a decent proxy for a place someone maintains - and then
 *  the nearest to the last stop, so the evening is a route, not a scatter. */
export function pick(candidates, used,
                     { from = null, needUntil = null, known = null, localOnly = false } = {}) {
  const shut = c => closes(c.openingHours);
  const fresh = candidates.filter(c => !used.has(c.name.toLowerCase()))
    .filter(c => needUntil == null || shut(c) == null || shut(c) >= needUntil)
    // "Only local, independent places" means it: no chains at all.
    .filter(c => !localOnly || !isChain(c.name));
  if (!fresh.length) return null;
  // Even without that switch, an independent beats a chain: a date at the
  // Starbucks you pass every morning is not a plan.
  const chain = c => (isChain(c.name) ? 1 : 0);
  const away = c => (from && c.lat != null) ? distanceKm(c.lat, c.lon, from.lat, from.lon) : 0;
  // Somewhere locals shared and loved beats anything the map search can
  // infer from tags - that is the whole point of asking them.
  const liked = c => {
    const p = known?.get(c.name.toLowerCase());
    return p ? 1 + p.posts + p.loves : 0;
  };
  return fresh.sort((a, b) =>
    (liked(b) - liked(a))
    || (chain(a) - chain(b))
    || ((a.openingHours ? 0 : 1) - (b.openingHours ? 0 : 1))
    || (away(a) - away(b)))[0];
}

/** The map search's candidates plus places locals shared as this kind of
 *  stop, so the planner can route to one the search never returned. Only
 *  shared places with coordinates, and only within reach. */
export function withLocals(hits, slot, locals, prefs) {
  const outside = AS_KIND[slot] === 'outdoors';
  const reach = Math.max(RADIUS_KM[prefs.transport] ?? 8, outside ? 12 : 0);
  const want = COMMUNITY_KIND[slot] || slot;
  const have = new Set(hits.map(h => h.name.toLowerCase()));
  const extra = (locals?.picks || [])
    .filter(p => p.kind === want && p.lat != null && !have.has(p.name.toLowerCase())
      && prefs.lat != null && distanceKm(p.lat, p.lon, prefs.lat, prefs.lon) <= reach)
    .map(p => ({ name: p.name, lat: p.lat, lon: p.lon, kind: LOCAL_KIND[slot] || 'Local pick',
                 cuisine: '', openingHours: '', website: '', address: '' }));
  return [...hits, ...extra];
}

function realStop(slot, v, prefs, t, minutes, cost, last) {
  const kind = AS_KIND[slot] || 'activity';
  const lines = COPY[slot] || COPY.activity;
  let why = lines[Math.abs(hash(v.name)) % lines.length];
  // Only the cuisine. The kind already has its own badge on the card, and
  // repeating it reads like a database dump.
  if (v.cuisine) why += ` Expect ${v.cuisine.split(',')[0].trim()}.`;

  const outdoors = OUTSIDE.has(kind);
  // "Main Beach" is somewhere; "Main Beach, Walden Pond" is somewhere you can find.
  if (outdoors && v.within && !v.name.includes(v.within)) why = `At ${v.within}. ${why}`;
  return {
    slot, name: v.name, kind, start: hhmm(t), minutes, cost, why,
    travelNext: last ? '' : 'A few minutes on foot.',
    travelMinutes: last ? 0 : 12,
    booking: slot === 'takeout' ? 'Call ahead to order for pick-up.'
           : kind === 'food' ? 'Worth booking - it is the busiest stop of the night.'
           : v.openingHours ? 'Check the hours before you set off.' : '',
    dressCode: kind === 'food' ? prefs.style : 'casual',
    indoor: !outdoors,
    fallback: outdoors ? 'Anywhere with a roof on the same street.' : '',
    tip: v.openingHours ? `Open ${v.openingHours}.` : '',
    lookedUp: true, verified: true,
    lat: v.lat, lon: v.lon, address: v.address, venueKind: v.kind,
    cuisine: v.cuisine, openingHours: v.openingHours, website: v.website,
    distanceM: (prefs.lat != null)
      ? Math.round(distanceKm(v.lat, v.lon, prefs.lat, prefs.lon) * 1000) : 0,
    photo: '', blurb: '', photoCredit: '',
  };
}

function placeholder(slot, prefs, t, minutes, cost, last) {
  const what = { drinks: 'a bar', coffee: 'a coffee place', food: 'somewhere to eat',
    music: 'somewhere with live music', show: 'a cinema or theatre',
    activity: 'a museum or gallery', aquarium: 'an aquarium',
    viewpoint: 'high ground or a park', shopping: 'a market',
    treat: 'a local cheese shop or bakery', sweet: 'an ice cream shop', takeout: 'somewhere local for takeaway',
    sled: 'a hill to sled down', hill: 'a hill with a view', nature: 'woods to walk in',
    rink: 'an ice rink', plunge: 'a pond or beach', swim: 'somewhere to swim' }[slot] || 'somewhere';
  const kind = AS_KIND[slot] || 'activity';
  const outdoors = OUTSIDE.has(kind);
  const where = (prefs.location || '').split(',')[0];
  return {
    name: `${what[0].toUpperCase()}${what.slice(1)} near ${where}`,
    kind, start: hhmm(t), minutes, cost,
    why: `Nothing matching ${what} came back on the map for this spot - worth a look `
       + `on the way, but do not build the night around it.`,
    travelNext: last ? '' : 'Short walk.', travelMinutes: last ? 0 : 12,
    dressCode: 'casual', indoor: !outdoors,
    fallback: outdoors ? 'Anywhere indoors nearby.' : '',
    tip: '', booking: '', lookedUp: false, verified: false,
    lat: null, lon: null, address: '', venueKind: '', cuisine: '',
    openingHours: '', website: '', distanceM: 0,
    photo: '', blurb: '', photoCredit: '',
  };
}

/** The last stop of a night in: your own sofa. */
function homeStop(prefs, t, minutes) {
  const month = Number(String(prefs.date || '').slice(5, 7)) || (new Date().getMonth() + 1);
  const films = FILMS[month] || FILMS[12];
  const film = films[Math.abs(hash(String(prefs.date || ''))) % films.length];
  return {
    name: 'Home', kind: 'home', start: hhmm(t), minutes, cost: 0,
    why: `Blankets, the good snacks, phones in another room, and ${film}.`,
    tip: 'Set the film up before you leave, so nobody spends twenty minutes scrolling.',
    travelNext: '', travelMinutes: 0, booking: '', dressCode: 'casual', indoor: true,
    fallback: '', lookedUp: false, verified: false,
    lat: null, lon: null, address: '', venueKind: 'Night in', cuisine: '',
    openingHours: '', website: '', distanceM: 0, photo: '', blurb: '', photoCredit: '',
  };
}

/** Put whatever closes first, first.
 *
 *  Museums and aquariums shut at six while bars run late, so the obvious arc
 *  - drink, attraction, dinner - marches you to the aquarium exactly as the
 *  doors close. The first Boston plan did precisely that: 18:02 to 19:17,
 *  closing time 18:00. Dinner stays last regardless; nobody wants an evening
 *  reordered into eating at six and a museum at nine. */
export function respectHours(stops, sunset = null) {
  if (stops.length < 2) return;
  const shuts = s => shutsAt(s, sunset) ?? 24 * 60;
  if (stops.every(s => shuts(s) === 24 * 60)) return;

  // Home is always last, after dinner has been picked up.
  const end = s => s.kind === 'food' || s.kind === 'home';
  const tail = [...stops.filter(s => s.kind === 'food'), ...stops.filter(s => s.kind === 'home')];
  const head = stops.filter(s => !end(s)).sort((a, b) => shuts(a) - shuts(b));
  const next = [...head, ...tail];
  if (next.map(s => s.name).join('|') === stops.map(s => s.name).join('|')) return;

  // Keep the evening's own start time: re-flowing from the new first stop's
  // old slot leaves it starting an hour late and still overrunning.
  const opening = stops[0].start;
  stops.splice(0, stops.length, ...next);
  stops[0].start = opening;
  stops.forEach((s, i) => {
    const last = i === stops.length - 1;
    s.travelMinutes = last ? 0 : (s.travelMinutes || 12);
    s.travelNext = last ? '' : (s.travelNext || 'A few minutes on foot.');
  });
  reflow(stops);
}

/** When a stop stops being any good: its closing time, or for anything
 *  outside, sunset. A hill in the dark is closed in every way that matters. */
function shutsAt(s, sunset) {
  const shut = closes(s.openingHours);
  if (OUTSIDE.has(s.kind) && sunset != null) return shut == null ? sunset : Math.min(shut, sunset);
  return shut;
}

function reflow(stops) {
  let t = mins(stops[0].start) ?? 17 * 60;
  for (const s of stops) { s.start = hhmm(t); t += s.minutes + s.travelMinutes; }
}

/** How long it takes to get from one stop to the next, and how to say it.
 *  Null when either end has no coordinates, which is a placeholder. */
export function leg(a, b, transport = 'walking') {
  if (a.lat == null || b.lat == null) return null;
  const km = distanceKm(a.lat, a.lon, b.lat, b.lon) * DETOUR;
  const [speed, extra, how] = PACE[transport] || PACE.walking;
  const walk = Math.ceil(km / PACE.walking[0] * 60);
  const onFoot = transport === 'walking'
    || (transport !== 'bike' && walk <= JUST_WALK);
  const minutes = onFoot ? walk : Math.ceil(km / speed * 60) + extra;
  const said = onFoot ? 'on foot' : how;
  if (minutes <= 5) return { minutes: 5, text: `A few minutes ${said}.` };
  const rounded = Math.ceil(minutes / 5) * 5;
  return { minutes: rounded, text: `About ${rounded} minutes ${said}.` };
}

/** Real travel between the stops, in the order the evening ended up in.
 *  Every hop used to be "A few minutes on foot" and twelve minutes, which a
 *  Lisbon transit plan with its stops 2 and 5 km apart made plainly untrue. */
export function legs(stops, transport) {
  if (!stops.length) return;
  stops.forEach((s, i) => {
    const next = stops[i + 1];
    if (!next) { s.travelNext = ''; s.travelMinutes = 0; return; }
    if (next.kind === 'home') { s.travelNext = 'Then home with it.'; s.travelMinutes = 15; return; }
    // A walking evening still drives to the hill or the pond - they are
    // rarely a walk from the restaurants - rather than hiking an hour to it.
    const toOutside = OUTSIDE.has(s.kind) || OUTSIDE.has(next.kind);
    let hop = leg(s, next, transport);
    s.drive = false;
    if (hop && toOutside && transport === 'walking' && hop.minutes > HOP_LIMIT.walking) {
      hop = leg(s, next, 'car');
      s.drive = true;
    }
    if (hop) { s.travelNext = hop.text; s.travelMinutes = hop.minutes; return; }
    s.travelNext = s.travelNext || 'A few minutes on foot.';
    s.travelMinutes = s.travelMinutes || 12;
  });
  reflow(stops);
}

/** End a visit at closing time rather than after it. Moved to the front, the
 *  aquarium still ran 17:00-18:15 against an 18:00 close: the order was right
 *  and the length was not. Never below half an hour - a stop that short is
 *  not worth the walk, and check() will say so instead.
 *
 *  Run it after fitWindow, not before. Before, a Lisbon dinner was cut to 75
 *  minutes because a jazz bar ahead of it made it late - and then the jazz
 *  bar was trimmed from the evening and dinner kept the cut. */
export function closeOnTime(stops, sunset = null) {
  for (const s of stops) {
    const shut = shutsAt(s, sunset), start = mins(s.start);
    if (shut == null || start == null) continue;
    const room = shut - start;
    if (room < s.minutes && room >= 30) { s.minutes = room; reflow(stops); }
  }
}

/* An overrun this small is a shorter stay somewhere, not a lost stop. Boston
 * lost the bar between the aquarium and dinner because the three of them ran
 * four minutes past a four-hour window. */
const SLACK = 15;

/** Take `over` minutes out of the evening without cutting a stop: from the
 *  longest stops that are not dinner first, never below 30 minutes each.
 *  Changes nothing and returns false if it cannot be done. */
function shave(stops, over) {
  const order = [...stops].sort((a, b) =>
    ((a.kind === 'food') - (b.kind === 'food')) || (b.minutes - a.minutes));
  if (order.reduce((n, s) => n + Math.max(0, s.minutes - 30), 0) < over) return false;
  for (const s of order) {
    const take = Math.min(over, Math.max(0, s.minutes - 30));
    s.minutes -= take;
    over -= take;
    if (!over) break;
  }
  reflow(stops);
  return true;
}

/** Trim until the evening fits the time it was given. A few minutes over comes
 *  out of the stays; more than that costs a stop, and the last stop goes first:
 *  it is the optional one by construction, and cutting the closer always beats
 *  rushing dinner. `keep` names the anchor, which goes only when nothing
 *  else can. */
export function fitWindow(stops, maxHours, transport, keep = null) {
  const span = () => {
    const a = mins(stops[0].start) ?? 0, z = stops[stops.length - 1];
    return (mins(z.start) ?? 0) + z.minutes - a;
  };
  const limit = Math.round(maxHours * 60);
  while (stops.length > 2 && span() > limit) {
    if (span() - limit <= SLACK && shave(stops, span() - limit)) break;
    // Not simply the last stop. respectHours has already moved dinner to the
    // end, so popping blindly cuts the one thing this is supposed to protect
    // - a Boston evening came back as drinks, live music and more drinks,
    // with no dinner in it at all. Cut the last stop that is not food, and
    // not the anchor either: a Chicago evening asked for art galleries lost
    // the gallery and kept the bar in front of it.
    const cuttable = n => !['food', 'home'].includes(stops[n].kind) && stops[n].name !== keep;
    let i = -1;
    for (let n = stops.length - 1; n > 0; n--) {
      if (cuttable(n)) { i = n; break; }
    }
    if (i < 0 && cuttable(0)) i = 0;       // only the opener is left to give
    if (i < 0) {
      for (let n = stops.length - 1; n > 0; n--) {
        if (!['food', 'home'].includes(stops[n].kind)) { i = n; break; }
      }
    }
    if (i < 0) i = stops.length - 1;       // nothing but food: cut the tail
    // The evening still starts when it was told to, whoever is first now.
    if (i === 0) stops[1].start = stops[0].start;
    stops.splice(i, 1);
    const last = stops[stops.length - 1];
    last.travelNext = '';
    last.travelMinutes = 0;
    // The stops either side of the cut are now neighbours, and the walk
    // between them is not the walk either of them had before.
    if (transport) legs(stops, transport);
    else reflow(stops);
  }
  for (const s of [...stops].sort((a, b) => b.minutes - a.minutes).slice(0, 2)) {
    const over = span() - limit;
    if (over <= 0) break;
    s.minutes = Math.max(30, s.minutes - over);
    reflow(stops);
  }
}

/** Say the right thing for where each stop ended up. Only the lines that
 *  claim a position change; the rest read the same anywhere. */
function retell(stops) {
  stops.forEach((s, i) => {
    if (i === 0 || !s.verified || !LATER[s.kind]) return;
    const lines = (s.kind === 'coffee' && stops[i - 1].slot === 'plunge') ? WARM_UP
      : (s.kind === 'drinks' && i === stops.length - 1) ? NIGHTCAP : LATER[s.kind];
    s.why = lines[Math.abs(hash(s.name)) % lines.length]
          + (s.cuisine ? ` Expect ${s.cuisine.split(',')[0].trim()}.` : '');
  });
}

/* --- the checks -------------------------------------------------------
 * The composer is good at taste and bad at arithmetic, so this re-tests
 * everything measurable. Warnings are shown, not silently fixed: a plan 8%
 * over budget is usually still the plan you want.
 */

const BUDGET_TOLERANCE = 0.10;
const STYLE_RANK = { casual: 1, streetwear: 1, outdoorsy: 1, smart_casual: 2, dressy: 3, formal: 4 };

export function check(plan, prefs, weather) {
  const out = [];
  const stops = plan.stops;
  if (!stops.length) return ['The plan came back with no stops.'];

  const total = stops.reduce((a, s) => a + s.cost, 0);
  if (total > prefs.budget * (1 + BUDGET_TOLERANCE)) {
    out.push(`Over budget: the stops add up to ${prefs.currency} ${Math.round(total)} `
           + `against ${prefs.currency} ${Math.round(prefs.budget)}.`);
  }

  const stage = STAGES[prefs.stage] || STAGES.getting_to_know;
  if (stops.length > stage.maxStops) {
    out.push(`${stops.length} stops is long for this kind of date - ${stage.maxStops} is the cap.`);
  }

  const hop = HOP_LIMIT[prefs.transport] ?? 20;
  let prevEnd = null;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i], start = mins(s.start);
    if (start == null) { out.push(`'${s.name}' has an unreadable start time.`); continue; }
    if (prevEnd != null && start < prevEnd) {
      out.push(`'${s.name}' starts at ${s.start}, before the previous stop finishes.`);
    }
    const travel = i < stops.length - 1 ? s.travelMinutes : 0;
    if (travel > (s.drive ? HOP_LIMIT.car : hop)) {
      out.push(`${travel} min from '${s.name}' to the next stop is a long hop by ${prefs.transport}.`);
    }
    prevEnd = start + s.minutes + travel;
  }

  const first = mins(stops[0].start);
  if (first != null && prevEnd != null) {
    const hours = (prevEnd - first) / 60;
    if (hours > stage.maxHours + 0.25) {
      out.push(`The evening runs ${hours.toFixed(1)} hours; ${stage.maxHours} is the ceiling here.`);
    }
  }

  const dressed = STYLE_RANK[prefs.style] ?? 2;
  for (const s of stops) {
    if ((STYLE_RANK[s.dressCode] ?? 1) > dressed) {
      out.push(`'${s.name}' expects ${String(s.dressCode).replace('_', ' ')} - check the door policy.`);
    }
    if (!s.indoor && !String(s.fallback).trim()) {
      out.push(`'${s.name}' is outdoors with no named indoor fallback.`);
    }
    if (s.lookedUp && !s.verified && VERIFIABLE.has(s.kind)) {
      out.push(`'${s.name}' could not be found in map data - check it exists.`);
    }
    const shut = closes(s.openingHours);
    const ends = mins(endOf(s));
    if (shut != null && ends != null && ends > shut) {
      out.push(`'${s.name}' closes at ${hhmm(shut)}, and this has you there until `
             + `${endOf(s)}. Move it earlier or pick somewhere else.`);
    }
  }

  // A viewpoint after dark is the most common silent failure in this kind of
  // plan, and the cheapest to catch.
  if (weather?.sunset != null) {
    for (const s of stops) {
      if (!OUTSIDE.has(s.kind)) continue;
      const start = mins(s.start);
      if (start == null) continue;
      if (start > weather.sunset) {
        out.push(`'${s.name}' starts after sunset (${hhmm(weather.sunset)}). Move it earlier.`);
      }
    }
  }

  // Cold water is the one stop here that can genuinely hurt someone.
  if (stops.some(s => s.slot === 'plunge')) {
    out.push('Cold water: never alone, in and out within two minutes, and not at all with a heart '
           + 'condition or after drinking. Only go in where others do, never on or under ice.');
  }
  return out;
}

/* --- prose ------------------------------------------------------------ */

function transportNote(prefs, stops) {
  const far = Math.max(0, ...stops.map(s => s.distanceM || 0));
  const lead = { walking: 'All on foot', bike: 'All bikeable',
    transit: 'All on one or two lines', car: 'Driveable, but park once and walk',
    rideshare: 'Two short rides at most' }[prefs.transport] || 'All close together';
  return far ? `${lead} - the furthest stop is about ${(far / 1000).toFixed(1)} km from where you started.`
             : `${lead}.`;
}

function weatherNote(weather, stops) {
  const outdoor = stops.filter(s => !s.indoor).map(s => s.name);
  if (!outdoor.length) {
    return `Forecast is ${wx.brief(weather)}. Everything here is indoors, so the sky is not your problem.`;
  }
  return `Forecast is ${wx.brief(weather)}. ${outdoor[0]} is the outdoor stop - check again `
       + `the morning of and use the fallback if it turns.`;
}

function wear(prefs, weather, slots = []) {
  // The adventurous evenings need kit more than a dress code.
  if (slots.includes('home')) return 'Whatever is softest. This one is at home.';
  if (slots.includes('plunge')) {
    return 'Swimsuit under your clothes, a big towel each, a warm hat, and dry layers '
         + 'you can pull on fast. Water shoes if you have them.';
  }
  if (slots.includes('swim')) return 'Swimsuit under your clothes, a towel, and something dry for dinner.';
  if (slots.includes('sled')) return 'Waterproof boots and gloves, a hat, and a sled. Dinner will forgive the hat hair.';
  if (slots.some(s => ['hill', 'nature'].includes(s))) {
    return 'Shoes with grip for the hill, and a layer for when the sun goes. Smart enough after for dinner.';
  }
  const base = String(prefs.style || '').replace(/_/g, ' ');
  const shoes = ['walking', 'transit'].includes(prefs.transport)
    ? 'shoes you can walk twenty minutes in' : 'something comfortable';
  const extra = wx.isWet(weather) ? ' and a jacket that can get rained on'
              : wx.isCold(weather) ? ' and a layer for when the sun goes' : '';
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}, with ${shoes}${extra}.`;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export const radiusKm = t => RADIUS_KM[t] ?? 8;
