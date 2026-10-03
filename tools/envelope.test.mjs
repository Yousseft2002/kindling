/* Node tests for the sealed envelope: a plan packed into a link and opened
 * again, and what happens when the link is not what it claims to be.
 * Offline, like the rest. Run: node tools/envelope.test.mjs */
import './mock-fetch.js';
import assert from 'node:assert/strict';
const { build } = await import('../docs/lib/plan.js');
const { seal, unseal, tokenFrom, linkFor, MAX_NOTE } = await import('../docs/lib/envelope.js');

const prefs = {
  location: 'Boston, Massachusetts', lat: 42.3555, lon: -71.0565, budget: 180, currency: 'USD',
  stage: 'dating', style: 'smart_casual', transport: 'walking', interests: ['art galleries'],
  date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), startTime: '17:30', hours: 5,
  note: '', weatherText: 'clear', adventure: 2, localOnly: false, diet: [], planMode: 'specific',
};
const weather = { summary: 'clear', highC: 21, lowC: 13, precip: 10, windKph: 9, sunset: 18 * 60 + 41, source: 'manual' };
const plan = await build(prefs, weather, () => {});
const d = { plan, prefs, weather };

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log('  ok  ', name); };
const rejects = (token) => assert.rejects(() => unseal(token));

const token = await seal(d, { note: 'Wear something you can dance in.', surprise: true });
const back = await unseal(token);

await ok('an evening survives the round trip, stop by stop', () => {
  assert.equal(back.data.plan.stops.length, plan.stops.length);
  plan.stops.forEach((s, i) => {
    const t = back.data.plan.stops[i];
    for (const k of ['name', 'start', 'minutes', 'kind', 'why', 'lat', 'lon', 'photo', 'website'])
      assert.deepEqual(t[k] ?? '', s[k] ?? '', `${k} of stop ${i}`);
  });
  assert.equal(back.data.plan.title, plan.title);
    assert.equal(back.data.prefs.date, prefs.date);
});
await ok('the note and the surprise flag arrive', () => {
  assert.equal(back.note, 'Wear something you can dance in.');
  assert.equal(back.surprise, true);
  assert.equal(back.data.shared, true);
});
await ok('the link is short enough to paste (under 8 KB)', () => {
  console.log(`        ${plan.stops.length} stops -> ${token.length} characters`);
  assert.ok(token.length < 8000);
});
await ok('the token is URL-safe and found in a fragment', () => {
  assert.match(token, /^1\.[zr]\.[A-Za-z0-9_-]+$/);
  const link = linkFor(token, 'https://you.github.io/kindling/');
  assert.equal(tokenFrom('#' + link.split('#')[1]), token);
});
await ok('a fragment that is not an envelope is ignored', () => {
  assert.equal(tokenFrom(''), null);
  assert.equal(tokenFrom('#access_token=abc'), null);
  assert.equal(tokenFrom('#e=not a token'), null);
});
await ok('links are rebuilt on our side, not carried', () => {
  back.data.plan.stops.forEach(s => {
    assert.ok(s.mapUrl.startsWith('https://www.google.com/maps/'));
    assert.ok(/^https:\/\//.test(s.bookUrl));
  });
});
await ok('an older saved plan with no alts still seals', async () => {
  const old = JSON.parse(JSON.stringify(d));
  old.plan.stops.forEach(s => delete s.alts);
  delete old.plan.insights;
  assert.equal((await unseal(await seal(old))).data.plan.stops.length, plan.stops.length);
});
await ok('the note is capped', async () => {
  const long = await unseal(await seal(d, { note: 'x'.repeat(5000) }));
  assert.equal(long.note.length, MAX_NOTE);
});
await ok('script in a note or a name comes back as plain text, never as a link', async () => {
  const evil = JSON.parse(JSON.stringify(d));
  evil.plan.stops[0].name = '<img src=x onerror=alert(1)>';
  evil.plan.stops[0].website = 'javascript:alert(1)';
  evil.plan.stops[0].photo = 'https://x.test/a.png"onerror="alert(1)';
  evil.plan.stops[0].photoCredit = 'data:text/html,<script>alert(1)</script>';
  const got = await unseal(await seal(evil, { note: '<script>alert(1)</script>' }));
  const s = got.data.plan.stops[0];
  assert.equal(s.website, ''); assert.equal(s.photo, ''); assert.equal(s.photoCredit, '');
  // Text stays text: the page escapes it on the way to innerHTML (rule 8).
  assert.equal(s.name, '<img src=x onerror=alert(1)>');
});
await ok('numbers are numbers, and out-of-range pins are dropped', async () => {
  const odd = JSON.parse(JSON.stringify(d));
  odd.plan.stops[0].lat = 999; odd.plan.stops[0].minutes = -5;
  const s = (await unseal(await seal(odd))).data.plan.stops[0];
  assert.equal(s.lat, null); assert.equal(s.minutes, 0);
});
await ok('no price travels with the envelope', async () => {
  const cur = prefs.currency;
  const p = plan.pitch;
  assert.ok(p.includes(cur), 'the fixture pitch quotes a price');
  const priced = JSON.parse(JSON.stringify(d));
  priced.plan.warnings = ['Over budget: the stops add up to USD 250 against USD 180.', 'Brasa may be closed.'];
  const t = await seal(priced, { note: 'x' });
  const raw = JSON.parse(new TextDecoder().decode(await new Response(
    new Blob([Buffer.from(t.split('.')[2], 'base64url')]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
  const text = JSON.stringify(raw);
  assert.ok(!/cost|currency|USD/i.test(text), 'nothing priced in the payload: ' + text.slice(0, 200));
  const got = await unseal(t);
  assert.ok(!got.data.plan.pitch.includes(cur) && !/d/.test(got.data.plan.pitch), got.data.plan.pitch);
  assert.deepEqual(got.data.plan.warnings, ['Brasa may be closed.']);
  assert.equal(got.data.plan.totalCost, undefined);
  got.data.plan.stops.forEach(s => assert.equal(s.cost ?? 0, 0));
});
await ok('nothing to seal is refused', () => assert.rejects(() => seal({ plan: { stops: [] } })));
await ok('garbage, truncation and the wrong version are refused, not half-opened', async () => {
  await rejects('');
  await rejects('hello');
  await rejects('2.z.AAAA');
  await rejects(token.slice(0, Math.floor(token.length / 2)));
  await rejects(token.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) + 'zzzz');
  await rejects('1.r.' + Buffer.from('{"v":1,"st":[]}').toString('base64url'));
  await rejects('1.r.' + Buffer.from('{"v":1,"st":[{"start":"18:00"}]}').toString('base64url'));
});
await ok('a token that inflates enormously is refused', async () => {
  const bomb = Buffer.from(JSON.stringify({ v: 1, st: [{ name: 'a', why: 'x'.repeat(4e6) }] }));
  const z = await new Response(new Blob([bomb]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  await rejects('1.z.' + Buffer.from(z).toString('base64url'));
});

const { invitationSummary, ideaTime } = await import('../docs/lib/ideas.js');
const { asText, asICS, areaUrl } = await import('../docs/lib/outing.js');
const loose = {
  plan: {
    planMode: 'open', area: 'Boston', title: 'Clay Painting & Dinner',
    pitch: 'Start with clay painting, then find dinner nearby. Keep the rest open.',
    totalCost: 110,
    stops: [
      { slot: 'pottery', idea: 'Clay painting', role: 'core', name: 'Clay painting',
        kind: 'activity', start: '18:30', minutes: 70, cost: 40, indoor: true,
        specific: false, timeSensitive: false, lat: null, lon: null,
        alts: [{ name: 'Studio <A>', lat: 42.355, lon: -71.057, kind: 'Pottery studio',
          openingHours: 'Mo-Su 11:00-23:30', website: 'https://example.com/studio' }] },
      { slot: 'food', idea: 'Dinner nearby', role: 'next', name: 'Dinner nearby',
        kind: 'food', start: '19:45', minutes: 90, cost: 70, indoor: true,
        specific: false, lat: null, lon: null, alts: [] },
      { slot: 'drinks', idea: 'Drinks', role: 'optional', name: 'Drinks nearby',
        kind: 'drinks', start: '21:30', minutes: 40, cost: 0, indoor: true,
        specific: false, lat: null, lon: null, alts: [] },
    ],
  },
  prefs, weather,
};
await ok('invitation is short and human without any exact restaurant', () => {
  assert.equal(invitationSummary(loose.plan, prefs), 'You, Me, Clay Painting & dinner in Boston.');
  assert.ok(!invitationSummary(loose.plan, prefs).includes('18:30'));
});
await ok('a loose evening without a restaurant survives sealing and opening', async () => {
  const opened = (await unseal(await seal(loose))).data.plan;
  assert.equal(opened.planMode, 'open');
  assert.equal(opened.area, 'Boston');
  assert.equal(opened.stops[1].specific, false);
  assert.equal(opened.stops[1].lat, null);
  assert.equal(opened.stops[2].role, 'optional');
  assert.equal(opened.stops[0].alts[0].name, 'Studio <A>');
  assert.equal(invitationSummary(opened, prefs), invitationSummary(loose.plan, prefs));
});
await ok('loose envelopes keep meaningful times but leave prices behind', async () => {
  const timed = JSON.parse(JSON.stringify(loose));
  timed.plan.pitch += ' — about USD 110 for two.';
  Object.assign(timed.plan.stops[0], {
    timeSensitive: true, sessionStart: '18:35', closingTime: '20:00',
  });
  const opened = (await unseal(await seal(timed))).data.plan;
  assert.ok(!opened.pitch.includes('USD'));
  assert.equal(opened.stops[0].sessionStart, '18:35');
  assert.equal(opened.stops[0].closingTime, '20:00');
  assert.ok(ideaTime(opened.stops[0], 0).includes('18:35'));
});
await ok('old version-one envelope links still decode without new fields', async () => {
  const old = '1.r.' + Buffer.from(JSON.stringify({
    v: 1, p: { title: 'Our evening' }, st: [{ name: 'Old Café', kind: 'coffee', start: '17:00', minutes: 40 }],
    pf: { location: 'Boston' },
  })).toString('base64url');
  const opened = (await unseal(old)).data;
  assert.equal(opened.plan.title, 'Our evening');
  assert.equal(opened.plan.stops[0].name, 'Old Café');
  assert.notEqual(opened.plan.planMode, 'open');
});
await ok('new envelope fields cannot carry scripts as URLs or invalid modes', async () => {
  const hostile = JSON.parse(JSON.stringify(loose));
  hostile.plan.planMode = 'unexpected';
  hostile.plan.stops[0].alts[0].website = 'javascript:alert(1)';
  hostile.plan.stops[0].role = 'mandatory';
  const opened = (await unseal(await seal(hostile))).data.plan;
  assert.equal(opened.planMode, '');
  assert.equal(opened.stops[0].role, '');
  assert.equal(opened.stops[0].alts[0].website, '');
});
await ok('loose text keeps dinner flexible and extensions optional', () => {
  const text = asText(loose.plan, prefs);
  assert.ok(text.includes('Dinner nearby'));
  assert.ok(text.includes('Optional:'));
  assert.ok(!text.includes('19:45'));
  assert.equal((asICS(loose.plan, prefs).match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(areaUrl(loose.plan, prefs).includes('query=Boston'));
  const chosen = { ...loose.plan, planMode: 'specific' };
  assert.ok(asText(chosen, prefs).includes('Optional: 21:30'));
  assert.ok(asICS(chosen, prefs).includes('SUMMARY:Optional: Drinks nearby'));
});
await ok('time-sensitive ideas retain their meaningful time', () => {
  const session = { ...loose.plan.stops[0], timeSensitive: true, start: '18:35' };
  assert.ok(ideaTime(session, 0).includes('18:35'));
  const timed = JSON.parse(JSON.stringify(loose));
  Object.assign(timed.plan.stops[0], { timeSensitive: true, start: '18:35', closingTime: '20:00' });
  const text = asText(timed.plan, prefs);
  assert.ok(text.includes('18:35'));
  assert.ok(text.includes('Closes at 20:00'));
});

globalThis.innerWidth = 390;
globalThis.innerHeight = 844;
globalThis.matchMedia = () => ({ matches: true });
const { planHtml } = await import('../docs/ui/results.js');
await ok('loose results show the concept, optional language, and escaped venue options', () => {
  const html = planHtml(loose);
  assert.ok(html.includes('Clay Painting &amp; Dinner'));
  assert.ok(html.includes('The move'));
  assert.ok(/Optional|If you/i.test(html));
  assert.ok(!html.includes('19:45'));
  assert.ok(!html.includes('<A>'));
  assert.ok(!html.includes('<polyline'));
  assert.ok(html.includes('id="seal"'), 'a restaurant is not required to send an invitation');
  const shared = planHtml({ ...loose, shared: true });
  assert.ok(!shared.includes('data-plan-mode'));
  assert.ok(!shared.includes('data-venue-option'));
  assert.ok(!shared.includes('USD'));
});
await ok('old saved plans render their exact places and times', () => {
  const old = JSON.parse(JSON.stringify(d));
  delete old.plan.planMode;
  old.plan.stops.forEach(s => { delete s.idea; delete s.role; delete s.specific; });
  const html = planHtml(old);
  assert.ok(html.includes(old.plan.stops[0].start));
  assert.ok(html.includes(old.plan.stops[0].name.replace(/&/g, '&amp;')));
});
console.log(`\n${pass} passed`);
