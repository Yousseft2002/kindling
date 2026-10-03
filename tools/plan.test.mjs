/* Node tests for the browser planner's swap and diet logic, against the
 * offline fixture in mock-fetch.js. Run: node tools/plan.test.mjs */
import './mock-fetch.js';
import assert from 'node:assert/strict';
const { build, swapStop, rank, slotsFor, setPlanMode, venueOptions, respectHours, leg } = await import('../docs/lib/plan.js');
const { invitationSummary, ideaLabel, ideaTime } = await import('../docs/lib/ideas.js');
const { isOpenFor } = await import('../docs/lib/places.js');

const prefs = {
  location: 'Boston, Massachusetts', lat: 42.3555, lon: -71.0565, budget: 180, currency: 'USD',
  stage: 'dating', style: 'smart_casual', transport: 'walking', interests: ['art galleries'],
  date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), startTime: '17:30', hours: 5,
  note: '', weatherText: 'clear', adventure: 2, localOnly: false, diet: ['vegetarian'],
};
const weather = { summary: 'clear', highC: 21, lowC: 13, precip: 10, windKph: 9, sunset: 18 * 60 + 41, source: 'manual' };

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ', name); };
const phases = [];
const plan = await build(prefs, weather, (label, info) => phases.push([label, info]));

ok('plan has two core ideas with at most one extension', () => assert.ok(plan.stops.length >= 2 && plan.stops.length <= 3));
ok('plans default to open with a broad, supplied area', () => {
  assert.equal(plan.planMode, 'open'); assert.equal(plan.area, 'Boston');
  assert.ok(plan.stops.every(s => s.idea && !s.specific && !s.timeSensitive));
  assert.equal(plan.stops[0].role, 'core');
  assert.equal(plan.stops.find(s => s.kind === 'food').role, 'next');
});
ok('open title and pitch lead with concepts, not evidence venue names', () => {
  plan.stops.forEach(s => { assert.ok(!plan.title.includes(s.name)); assert.ok(!plan.pitch.includes(s.name)); });
});
ok('progress reports each venue found', () =>
  assert.ok(phases.filter(([, i]) => i?.found).length >= 2));
ok('every real stop keeps alternatives', () =>
  plan.stops.filter(s => s.verified).forEach(s => assert.ok(Array.isArray(s.alts))));
ok('alternatives never repeat the stop itself', () =>
  plan.stops.forEach(s => assert.ok(!(s.alts || []).some(a => a.name === s.name))));
const dinner = plan.stops.find(s => s.kind === 'food');
ok('dinner prefers a kitchen tagged for the diet', () => assert.ok(dinner.diet.includes('vegetarian')));
ok('plan survives a JSON round-trip (it is saved to localStorage)', () =>
  assert.deepEqual(JSON.parse(JSON.stringify(plan)).stops.length, plan.stops.length));

const i = plan.stops.indexOf(dinner);
const before = { name: dinner.name, start: dinner.start, minutes: dinner.minutes, cost: dinner.cost,
  idea: dinner.idea, role: dinner.role };
const alt = dinner.alts[0];
swapStop(plan, i, alt, prefs, weather);
const now = plan.stops[i];
ok('swap puts the alternative in place', () => assert.equal(now.name, alt.name));
ok('swap keeps the slot: length and cost (the start moves only by the new walk)', () => {
  assert.equal(now.minutes, before.minutes); assert.equal(now.cost, before.cost);
  const m = t => +t.slice(0, 2) * 60 + +t.slice(3);
  assert.ok(Math.abs(m(now.start) - m(before.start)) <= 30);
});
ok('the old stop becomes an alternative, so a swap can be undone', () =>
  assert.equal(now.alts[0].name, before.name));
ok('swap re-links and re-checks', () => { assert.ok(now.bookUrl); assert.ok(Array.isArray(plan.warnings)); });
ok('open option pick fixes only its venue while preserving the concept, role and broad invitation', () => {
  assert.ok(!plan.pitch.includes(now.name)); assert.equal(now.specific, true);
  assert.equal(plan.planMode, 'open');
  assert.equal(now.idea, before.idea); assert.equal(now.role, before.role);
  assert.ok(plan.stops.filter((_, n) => n !== i).every(s => !s.specific));
});
ok('untagged kitchen gets an honest call-ahead warning', () => {
  if (!now.diet.includes('vegetarian')) assert.ok(plan.warnings.some(w => w.includes(now.name)));
});
swapStop(plan, i, now.alts[0], prefs, weather);
ok('swapping back restores the original', () => assert.equal(plan.stops[i].name, before.name));
ok('rank puts diet matches above unknowns', () => {
  const r = rank([{ name: 'A', diet: [] }, { name: 'B', diet: ['vegan'] }], new Set(), { diet: ['vegan'] });
  assert.equal(r[0].name, 'B');
});

/* ---- concepts and feasible choices ----------------------------------- */

ok('early stages stop at two ideas, established stages get one optional closer', () => {
  for (const stage of ['first_date', 'getting_to_know']) {
    assert.deepEqual(slotsFor({ ...prefs, stage }, weather), ['activity', 'food']);
    for (const adventure of [1, 2, 3, 4, 5]) {
      assert.equal(slotsFor({ ...prefs, stage, adventure }, weather).length, 2);
    }
  }
  assert.deepEqual(slotsFor(prefs, weather), ['activity', 'food', 'music']);
  assert.deepEqual(slotsFor({ ...prefs, interests: ['clay painting'] }, weather), ['pottery', 'food', 'music']);
  assert.deepEqual(slotsFor({ ...prefs, adventure: 1 }, weather), ['treat', 'takeout', 'home']);
  assert.deepEqual(slotsFor({ ...prefs, adventure: 5 }, weather), ['plunge', 'coffee', 'food']);
});
ok('invitation is the exact broad clay-painting sentence in either mode', () => {
  const concept = { area: 'Boston', stops: [{ slot: 'pottery', kind: 'activity' }, { slot: 'food', kind: 'food' }] };
  assert.equal(invitationSummary(concept, prefs), 'You, Me, Clay Painting & dinner in Boston.');
  concept.planMode = 'specific';
  concept.stops[0].name = 'Named Studio';
  assert.equal(invitationSummary(concept, prefs), 'You, Me, Clay Painting & dinner in Boston.');
});
ok('invitations survive old plans, no venues and no restaurant without inventing dinner', () => {
  assert.equal(invitationSummary({ stops: [{ kind: 'coffee' }] }, prefs), 'You, Me, Coffee in Boston.');
  assert.equal(invitationSummary({ stops: [] }, prefs), 'You, Me, Time Together in Boston.');
  assert.equal(ideaLabel({ kind: 'food' }), 'Dinner nearby');
  assert.ok(!invitationSummary({ stops: [{ kind: 'activity' }, { kind: 'music', role: 'optional' }] }, prefs).includes('music'));
});
ok('opening windows include openings, split shifts, weekday closures and overnight hours', () => {
  assert.equal(isOpenFor('', 18 * 60, 20 * 60, 1), true);
  assert.equal(isOpenFor('by appointment', 18 * 60, 20 * 60, 1), true);
  assert.equal(isOpenFor('24/7', 18 * 60, 20 * 60, 1), true);
  assert.equal(isOpenFor('Mo-Su 18:00-23:00', 17 * 60, 19 * 60, 1), false);
  assert.equal(isOpenFor('Mo-Su 12:00-15:00,18:00-23:00', 17 * 60, 19 * 60, 1), false);
  assert.equal(isOpenFor('Mo-Su 12:00-15:00,18:00-23:00', 18 * 60, 20 * 60, 1), true);
  assert.equal(isOpenFor('Tu-Su 12:00-23:00', 18 * 60, 20 * 60, 1), false);
  assert.equal(isOpenFor('closed', 18 * 60, 20 * 60), false);
  assert.equal(isOpenFor('Mo-Su 12:00-23:00; Mo off', 18 * 60, 20 * 60, 1), false);
  assert.equal(isOpenFor('Mo-Su 18:00-02:00', 23 * 60, 25 * 60, 1), true);
});
const choicePrefs = { ...prefs, lat: 42, lon: -71, date: '2026-10-05' };
const evidence = (name, lat = 42, lon = -71, hours = 'Mo-Su 12:00-23:00') => ({
  name, lat, lon, openingHours: hours, verified: true, kind: 'activity', slot: 'activity',
  start: '17:00', minutes: 60, cost: 10, alts: [], role: 'core',
});
ok('options enforce radius, both neighboring hops and actual reflowed visit windows', () => {
  const a = evidence('Before', 42, -71.008);
  const b = evidence('Current', 42, -71);
  const c = { ...evidence('Dinner', 42, -70.992), kind: 'food', slot: 'food', role: 'next' };
  b.alts = [
    evidence('Good', 42.001, -71),
    evidence('Too far', 42.04, -71),
    evidence('Bad hop', 42, -71.017),
    evidence('Closed by actual visit', 42, -71, 'Mo-Su 12:00-18:00'),
    evidence('Not yet open', 42, -71, 'Mo-Su 20:00-23:00'),
  ];
  const names = venueOptions({ stops: [a, b, c] }, 1, choicePrefs).map(v => v.name);
  assert.deepEqual(names, ['Current', 'Good']);
  assert.ok(leg(b.alts[2], c, 'walking').minutes > 15);
});
ok('optional extension remains after dinner even when it closes earlier', () => {
  const stops = [evidence('Activity'), { ...evidence('Dinner'), kind: 'food', role: 'next' },
    { ...evidence('Optional', 42, -71, 'Mo-Su 12:00-19:00'), kind: 'music', role: 'optional' }];
  respectHours(stops);
  assert.deepEqual(stops.map(s => s.name), ['Activity', 'Dinner', 'Optional']);
});
ok('mode switching is offline, keeps serializable evidence and rechecks old plans', () => {
  const copy = JSON.parse(JSON.stringify(plan));
  setPlanMode(copy, 'specific', prefs, weather);
  assert.ok(copy.stops.every(s => s.specific));
  assert.ok(copy.pitch.includes(copy.stops[0].name));
  setPlanMode(copy, 'open', prefs, weather);
  assert.ok(copy.stops.every(s => !s.specific));
  assert.ok(!copy.pitch.includes(copy.stops[0].name));
  const old = { stops: [evidence('Old'), { ...evidence('Old dinner'), kind: 'food', slot: 'food' }] };
  setPlanMode(old, 'open', choicePrefs, weather);
  assert.equal(old.area, 'Boston'); assert.ok(old.stops.every(s => s.idea && s.role));
});
ok('loose times never expose calculated start times or closing limits as appointments', () => {
  assert.equal(ideaTime({ start: '17:37', closingTime: '18:00', role: 'core' }), 'Around 17:30');
  assert.equal(ideaTime({ start: '19:00', role: 'optional' }, 2), 'Later, if you feel like it');
  assert.equal(ideaTime({ sessionStart: '18:15', timeSensitive: true }), 'Suggested arrival 18:15');
  assert.equal(ideaTime({ start: '19:05', kind: 'food' }, 1), 'Afterward');
  assert.equal(ideaTime({ start: 'invalid' }), 'Start together');
});
ok('an open swap rejects a closed or distant venue instead of breaking the route', () => {
  const copy = JSON.parse(JSON.stringify(plan));
  const name = copy.stops[0].name;
  swapStop(copy, 0, { ...evidence('Closed'), openingHours: 'closed' }, prefs, weather);
  assert.equal(copy.stops[0].name, name);
});
ok('choosing the current evidence fixes that item without changing the open plan or its metadata', () => {
  const copy = JSON.parse(JSON.stringify(plan));
  setPlanMode(copy, 'open', prefs, weather);
  const current = venueOptions(copy, 0, prefs)[0];
  const { name, idea, role } = copy.stops[0];
  assert.equal(current.name, name);
  swapStop(copy, 0, current, prefs, weather);
  assert.equal(copy.planMode, 'open');
  assert.equal(copy.stops[0].name, name);
  assert.equal(copy.stops[0].idea, idea); assert.equal(copy.stops[0].role, role);
  assert.equal(copy.stops[0].specific, true);
  assert.ok(copy.stops.slice(1).every(s => !s.specific));
});

// Distinct origins avoid the real memo cache; every response is still offline.
const fixtureFetch = globalThis.fetch;
let fallbackPlan, noDinnerPlan, emptyPlan, clayPlan, specificPlan;
try {
  let scenario = 'closed';
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.href || input.url);
    const response = await fixtureFetch(input, init);
    if (url.host !== 'nominatim.openstreetmap.org' || !url.pathname.includes('search')) return response;
    const q = url.searchParams.get('q');
    let records = await response.json();
    if (scenario === 'empty' || (scenario === 'no dinner' && ['restaurant', 'bistro'].includes(q))) records = [];
    if (scenario === 'closed' && ['museum', 'gallery'].includes(q)) {
      records.forEach(r => { r.extratags.opening_hours = 'Mo-Su 09:00-16:00'; });
    }
    if (scenario === 'clay' && q === 'pottery') {
      const box = url.searchParams.get('viewbox').split(',').map(Number);
      records = [{ name: 'Real Ceramic Studio', type: 'arts_centre', category: 'amenity',
        lat: String((box[1] + box[3]) / 2), lon: String((box[0] + box[2]) / 2),
        extratags: { opening_hours: 'Mo-Su 12:00-23:00' } }];
    }
    return new Response(JSON.stringify(records), { headers: { 'Content-Type': 'application/json' } });
  };
  fallbackPlan = await build({ ...prefs, lat: 42.38, stage: 'first_date' }, weather);
  scenario = 'no dinner';
  noDinnerPlan = await build({ ...prefs, lat: 42.39, stage: 'first_date' }, weather);
  scenario = 'empty';
  emptyPlan = await build({ ...prefs, lat: 42.40, stage: 'first_date' }, weather);
  scenario = 'clay';
  clayPlan = await build({ ...prefs, lat: 42.41, stage: 'first_date', interests: ['clay painting'] }, weather);
  scenario = 'specific';
  specificPlan = await build({ ...prefs, lat: 42.42, stage: 'first_date', planMode: 'specific' }, weather);
} finally {
  globalThis.fetch = fixtureFetch;
}
ok('a closed activity falls back to a searched feasible category, never a placeholder', () => {
  assert.equal(fallbackPlan.stops[0].slot, 'coffee');
  assert.equal(fallbackPlan.stops[0].minutes, 40);
  assert.ok(fallbackPlan.stops.every(s => s.verified));
  assert.ok(!fallbackPlan.stops.some(s => s.slot === 'activity'));
});
ok('missing restaurants and total lookup failure are honest, without invented dinners or activities', () => {
  assert.ok(!noDinnerPlan.stops.some(s => s.kind === 'food'));
  assert.ok(noDinnerPlan.warnings.some(w => w.includes('No feasible dinner')));
  assert.ok(!invitationSummary(noDinnerPlan, prefs).includes('dinner'));
  assert.equal(emptyPlan.stops.length, 0);
  assert.ok(emptyPlan.warnings.some(w => w.includes('no stops')));
});
ok('warranted pottery searches produce a clay idea backed by the actual studio', () => {
  assert.equal(clayPlan.stops[0].name, 'Real Ceramic Studio');
  assert.equal(clayPlan.stops[0].idea, 'Clay painting');
  assert.equal(invitationSummary(clayPlan, prefs), 'You, Me, Clay Painting & dinner in Boston.');
});
ok('explicit specific requests expose verified names while invitations remain broad', () => {
  assert.equal(specificPlan.planMode, 'specific');
  assert.ok(specificPlan.stops.every(s => s.specific));
  assert.ok(specificPlan.pitch.includes(specificPlan.stops[0].name));
  assert.ok(!invitationSummary(specificPlan, prefs).includes(specificPlan.stops[0].name));
});

/* ---- taking it with you ---------------------------------------------- */

const { asICS, asText, routeUrl, icsName } = await import('../docs/lib/outing.js');
setPlanMode(plan, 'specific', prefs, weather);

const cal = asICS(plan, prefs);
ok('the calendar has one event per stop', () =>
  assert.equal((cal.match(/BEGIN:VEVENT/g) || []).length, plan.stops.length));
ok('every line ends CRLF, which the spec requires and Outlook enforces', () =>
  assert.ok(!/[^\r]\n/.test(cal)));
ok('no line exceeds 75 octets unfolded', () =>
  cal.split('\r\n').forEach(l => assert.ok(new TextEncoder().encode(l).length <= 75, l)));
ok('semicolons and commas in a venue name are escaped, not left to break the file', () => {
  const c = asICS({ stops: [{ name: 'Ben; Jerry, Inc', start: '17:00', minutes: 60, cost: 0 }] },
                  { date: '2026-10-03' });
  assert.ok(c.includes('SUMMARY:Ben\\; Jerry\\, Inc'));
});
ok('the start is floating local time - no Z, no timezone database', () =>
  assert.ok(/DTSTART:\d{8}T\d{6}\r\n/.test(cal)));
ok('DTSTAMP is UTC, because that one the spec does pin', () =>
  assert.ok(/DTSTAMP:\d{8}T\d{6}Z/.test(cal)));
ok('an evening running past midnight lands on the next day', () => {
  const c = asICS({ stops: [{ name: 'Late', start: '23:30', minutes: 90, cost: 0 }] },
                  { date: '2026-10-03' });
  assert.ok(c.includes('DTSTART:20261003T233000'));
  assert.ok(c.includes('DTEND:20261004T010000'));
});
ok('one alarm, on the first stop only', () =>
  assert.equal((cal.match(/BEGIN:VALARM/g) || []).length, 1));
ok('the file has a findable name', () =>
  assert.match(icsName(prefs), /^kindling-boston-\d{4}-\d{2}-\d{2}\.ics$/));

const msg = asText(plan, prefs);
ok('the message names every stop, at its time', () =>
  plan.stops.forEach(s => assert.ok(msg.includes(s.name) && msg.includes(s.start))));
ok('the message carries the warnings, not just the good news', () =>
  (plan.warnings || []).forEach(w => assert.ok(msg.includes(w))));
ok('the message is plain text - no markup leaks from the page', () =>
  assert.ok(!/[<>]|&amp;|&quot;/.test(msg)));

ok('the route chains the placed stops in order', () => {
  const u = new URL(routeUrl(plan.stops, 'walking'));
  const placed = plan.stops.filter(s => typeof s.lat === 'number');
  assert.equal(u.searchParams.get('travelmode'), 'walking');
  assert.ok(u.searchParams.get('origin').startsWith(placed[0].lat.toFixed(6)));
  assert.ok(u.searchParams.get('destination').startsWith(placed.at(-1).lat.toFixed(6)));
});
ok('a stop with no coordinates is left out rather than guessed at', () => {
  const u = routeUrl([{ lat: 1, lon: 2 }, { name: 'Somewhere with live music' }, { lat: 3, lon: 4 }]);
  assert.ok(!u.includes('waypoints'));
});
ok('fewer than two placed stops is no route at all', () =>
  assert.equal(routeUrl([{ lat: 1, lon: 2 }]), ''));
ok('transit and driving carry through to the maps app', () => {
  const two = [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }];
  assert.ok(routeUrl(two, 'transit').includes('travelmode=transit'));
  assert.ok(routeUrl(two, 'car').includes('travelmode=driving'));
});

/* ---- one escaper ------------------------------------------------------ */

const { esc } = await import('../docs/lib/fmt.js');
ok('esc closes every hole that reaches innerHTML', () =>
  assert.equal(esc('<a href="x">Ben & Jerry</a>'),
               '&lt;a href=&quot;x&quot;&gt;Ben &amp; Jerry&lt;/a&gt;'));
ok('esc survives null and undefined, which a missing venue field will be', () => {
  assert.equal(esc(null), ''); assert.equal(esc(undefined), '');
});

console.log(`\n${pass} passed`);
