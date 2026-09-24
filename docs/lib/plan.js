/* Building the evening.
 *
 * Ported from the Python planner. The division of labour is the same and it
 * is the thing that makes the output usable: taste lives in the copy and the
 * slot choices, arithmetic lives in `check()`. The composer can be wrong
 * about whether a bar is nice; it is never wrong about whether the sums add
 * up, the clock is continuous, or the aquarium has shut.
 */

import { nearby, lookup, closesAt } from './places.js';
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

/* Minutes and share of budget per slot. Dinner gets the money and the time;
 * everything else is there to make dinner better. */
const SHAPE = {
  drinks: [50, 0.16], coffee: [40, 0.08], aquarium: [75, 0.22],
  activity: [70, 0.18], show: [110, 0.30], music: [70, 0.20],
  viewpoint: [40, 0.00], shopping: [35, 0.05], food: [95, 0.50],
};

/* Slot -> the kind recorded on the stop, which drives the booking link and
 * whether a missing venue is worth warning about. */
const AS_KIND = {
  aquarium: 'activity', coffee: 'coffee', drinks: 'drinks', activity: 'activity',
  music: 'music', show: 'show', viewpoint: 'viewpoint', shopping: 'shopping',
  food: 'food',
};

/* Kinds that should exist as a listing, so a miss means something. A walk
 * described as "the waterfront" is not a listing and flagging it would cry
 * wolf on every plan. */
const VERIFIABLE = new Set(['food', 'drinks', 'coffee', 'music', 'show', 'activity', 'shopping']);
const PHOTO_KINDS = new Set(['activity', 'show', 'music', 'viewpoint']);

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
};

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

  let anchor;
  if (wants('aquarium', 'fish', 'animal', 'zoo')) anchor = 'aquarium';
  else if (wants('music', 'jazz', 'gig', 'band', 'live')) anchor = 'music';
  else if (wants('film', 'cinema', 'movie', 'theatre', 'theater', 'comedy')) anchor = 'show';
  else if (wants('art', 'museum', 'history', 'gallery', 'exhibition')) anchor = 'activity';
  else if (wants('book', 'vintage', 'record', 'market', 'shopping')) anchor = 'shopping';
  else if (wx.isWet(weather) || wx.isCold(weather)) anchor = 'activity';
  else anchor = 'viewpoint';

  const early = (mins(prefs.startTime) ?? 17 * 60) < 17 * 60;
  const opener = (prefs.stage === 'first_date' && early) ? 'coffee' : 'drinks';

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

export async function build(prefs, weather, onPhase = () => {}) {
  const stage = STAGES[prefs.stage] || STAGES.getting_to_know;
  const slots = slotsFor(prefs, weather);

  let t = mins(prefs.startTime) ?? 17 * 60;
  const gh = wx.goldenHour(weather);
  if (slots.includes('viewpoint') && gh && !wx.isWet(weather)) {
    const idx = slots.indexOf('viewpoint');
    const light = gh.start - (slots.length - idx - 1) * 70;
    t = Math.max(t, Math.min(t + 90, light));
  }

  onPhase('Looking for places near you');
  const stops = [];
  const used = new Set();
  let left = prefs.budget;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const [minutes, share] = SHAPE[slot] || [60, 0.2];
    const cost = Math.round(Math.min(left, prefs.budget * share) * 100) / 100;
    const last = i === slots.length - 1;

    const hits = await nearby(slot, prefs.lat, prefs.lon, prefs.transport, 6);
    const venue = pick(hits, used);

    const stop = venue ? realStop(slot, venue, prefs, t, minutes, cost, last)
                       : placeholder(slot, prefs, t, minutes, cost, last);
    // An unfillable slot produces the same sentence every time, so two of
    // them read as "somewhere with live music near Boston" twice - which is
    // the app looking broken rather than looking honest. Skip the repeat and
    // spend neither the time nor the budget on it.
    if (used.has(stop.name.toLowerCase())) continue;

    stops.push(stop);
    used.add(stop.name.toLowerCase());
    left = Math.max(0, left - cost);
    t += minutes + (last ? 0 : 12);
  }

  respectHours(stops);
  fitWindow(stops, Math.min(stage.maxHours, prefs.hours));

  onPhase('Finding a photograph');
  for (const s of stops) {
    if (s.verified && PHOTO_KINDS.has(s.kind)) {
      const shot = await wikiLook(s.name, s.lat, s.lon);
      if (shot) { s.photo = shot.photo; s.blurb = shot.blurb; s.photoCredit = shot.url; }
    }
  }

  const total = stops.reduce((a, s) => a + s.cost, 0);
  const named = stops.filter(s => s.verified).map(s => s.name);
  const anchorStop = stops.find(s => ['activity', 'music', 'show'].includes(s.kind) && s.verified);
  const where = (prefs.location || '').split(',')[0];

  const plan = {
    title: anchorStop ? `${anchorStop.name}, and either side of it`
                      : `An evening around ${where}`,
    pitch: named.length >= 2
      ? `${named[0]}, then ${named[1]}${named[2] ? `, then ${named[2]}` : ''}`
        + ` - about ${prefs.currency} ${Math.round(total)} for two.`
      : `A night around ${where} for about ${prefs.currency} ${Math.round(total)}, for two.`,
    stops,
    totalCost: Math.round(total * 100) / 100,
    transportNote: transportNote(prefs, stops),
    weatherCall: weatherNote(weather, stops),
    wear: wear(prefs, weather),
    backup: `${named[0] || where} is the one to check before you leave - opening hours `
          + `move, and everything else here is close enough to swap at short notice.`,
  };

  attachLinks(plan, prefs.location);
  plan.warnings = check(plan, prefs, weather);
  return plan;
}

/** Nearest unused candidate, preferring ones with published hours - a decent
 *  proxy for a place someone actually maintains. */
function pick(candidates, used) {
  const fresh = candidates.filter(c => !used.has(c.name.toLowerCase()));
  if (!fresh.length) return null;
  return fresh.sort((a, b) => (a.openingHours ? 0 : 1) - (b.openingHours ? 0 : 1))[0];
}

function realStop(slot, v, prefs, t, minutes, cost, last) {
  const kind = AS_KIND[slot] || 'activity';
  const lines = COPY[slot] || COPY.activity;
  let why = lines[Math.abs(hash(v.name)) % lines.length];
  // Only the cuisine. The kind already has its own badge on the card, and
  // repeating it reads like a database dump.
  if (v.cuisine) why += ` Expect ${v.cuisine.split(',')[0].trim()}.`;

  const outdoors = kind === 'viewpoint';
  return {
    name: v.name, kind, start: hhmm(t), minutes, cost, why,
    travelNext: last ? '' : 'A few minutes on foot.',
    travelMinutes: last ? 0 : 12,
    booking: kind === 'food' ? 'Worth booking - it is the busiest stop of the night.'
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
    viewpoint: 'high ground or a park', shopping: 'a market' }[slot] || 'somewhere';
  const kind = AS_KIND[slot] || 'activity';
  const outdoors = kind === 'viewpoint';
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

/** Put whatever closes first, first.
 *
 *  Museums and aquariums shut at six while bars run late, so the obvious arc
 *  - drink, attraction, dinner - marches you to the aquarium exactly as the
 *  doors close. The first Boston plan did precisely that: 18:02 to 19:17,
 *  closing time 18:00. Dinner stays last regardless; nobody wants an evening
 *  reordered into eating at six and a museum at nine. */
export function respectHours(stops) {
  if (stops.length < 2) return;
  const shuts = s => closesAt(s.openingHours) ?? 24 * 60;
  if (stops.every(s => shuts(s) === 24 * 60)) return;

  const tail = stops.filter(s => s.kind === 'food');
  const head = stops.filter(s => s.kind !== 'food').sort((a, b) => shuts(a) - shuts(b));
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

function reflow(stops) {
  let t = mins(stops[0].start) ?? 17 * 60;
  for (const s of stops) { s.start = hhmm(t); t += s.minutes + s.travelMinutes; }
}

/** Trim until the evening fits the time it was given. The last stop goes
 *  first: it is the optional one by construction, and cutting the closer
 *  always beats rushing dinner. */
export function fitWindow(stops, maxHours) {
  const span = () => {
    const a = mins(stops[0].start) ?? 0, z = stops[stops.length - 1];
    return (mins(z.start) ?? 0) + z.minutes - a;
  };
  const limit = Math.round(maxHours * 60);
  while (stops.length > 2 && span() > limit) {
    // Not simply the last stop. respectHours has already moved dinner to the
    // end, so popping blindly cuts the one thing this is supposed to protect
    // - a Boston evening came back as drinks, live music and more drinks,
    // with no dinner in it at all. Cut the last stop that is not food.
    let i = -1;
    for (let n = stops.length - 1; n > 0; n--) {
      if (stops[n].kind !== 'food') { i = n; break; }
    }
    if (i < 0) i = stops.length - 1;       // nothing but food: cut the tail
    stops.splice(i, 1);
    const last = stops[stops.length - 1];
    last.travelNext = '';
    last.travelMinutes = 0;
    reflow(stops);
  }
  for (const s of [...stops].sort((a, b) => b.minutes - a.minutes).slice(0, 2)) {
    const over = span() - limit;
    if (over <= 0) break;
    s.minutes = Math.max(30, s.minutes - over);
    reflow(stops);
  }
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
    if (travel > hop) {
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
    const shut = closesAt(s.openingHours);
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
      if (s.kind !== 'viewpoint') continue;
      const start = mins(s.start);
      if (start == null) continue;
      if (start > weather.sunset) {
        out.push(`'${s.name}' starts after sunset (${hhmm(weather.sunset)}). Move it earlier.`);
      }
    }
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

function wear(prefs, weather) {
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
