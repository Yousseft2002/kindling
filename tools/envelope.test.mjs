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
  note: '', weatherText: 'clear', adventure: 2, localOnly: false, diet: [],
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
console.log(`\n${pass} passed`);
