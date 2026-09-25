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
console.log(`\n${pass} passed`);
