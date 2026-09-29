/* Node tests for the browser planner's swap and diet logic, against the
 * offline fixture in mock-fetch.js. Run: node tools/plan.test.mjs */
import './mock-fetch.js';
import assert from 'node:assert/strict';
const { build, swapStop, rank } = await import('../docs/lib/plan.js');

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

ok('plan has stops', () => assert.ok(plan.stops.length >= 3));
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
const before = { name: dinner.name, start: dinner.start, minutes: dinner.minutes, cost: dinner.cost };
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
ok('pitch names the new stop when it is among the first three', () =>
  assert.ok(plan.stops.slice(0, 3).every(s => !s.verified || plan.pitch.includes(s.name))));
ok('untagged kitchen gets an honest call-ahead warning', () => {
  if (!now.diet.includes('vegetarian')) assert.ok(plan.warnings.some(w => w.includes(now.name)));
});
swapStop(plan, i, now.alts[0], prefs, weather);
ok('swapping back restores the original', () => assert.equal(plan.stops[i].name, before.name));
ok('rank puts diet matches above unknowns', () => {
  const r = rank([{ name: 'A', diet: [] }, { name: 'B', diet: ['vegan'] }], new Set(), { diet: ['vegan'] });
  assert.equal(r[0].name, 'B');
});

/* ---- taking it with you ---------------------------------------------- */

const { asICS, asText, routeUrl, icsName } = await import('../docs/lib/outing.js');

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
