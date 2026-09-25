import * as places from './lib/places.js';
import * as wx from './lib/weather.js';
import * as community from './lib/community.js';
import { build, swapStop, photograph, STAGES, STYLES, TRANSPORT, ADVENTURE } from './lib/plan.js';
import { initCommunity, openCommunity } from './community-tab.js';
import { openInvitation } from './ui/invitation.js';
import { openStop, refreshStop, close as closeStop, isOpen as stopOpen } from './ui/hero.js';
import { openSwap } from './ui/swap.js';
import { planHtml, wireTune } from './ui/results.js';
import { revealTiles } from './ui/tiles.js';
import { springTo } from './ui/spring.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const LAST_PLAN = 'kindling.lastplan';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- is this page able to run? --------------------------------------
   Kindling is a static app now - there is no server to be missing. The one
   way to get a broken page is opening index.html straight off the disk:
   ES modules are blocked on file://, so nothing below would have loaded
   anyway. This message only ever renders if that somehow changes. */
const SERVED = location.protocol === 'http:' || location.protocol === 'https:';

function setStale(msg) {
  $('#stale_text').textContent = msg;
  $('#stale').classList.remove('open');
  $('#stale').classList.add('on');
}
$('#stale_text').addEventListener('click', () => $('#stale').classList.toggle('open'));
$('#stale_x').addEventListener('click', () => $('#stale').classList.remove('on'));

if (!SERVED) {
  setStale('Opened as a file. Serve this folder over http, or use the published '
         + 'address, and it will work.');
  $('#go').disabled = true;
}

/* ---- service worker ------------------------------------------------- */
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw failed', e));
}

/* ---- install prompt ------------------------------------------------- */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  $('#install').classList.add('on');
});
$('#install_go').addEventListener('click', async () => {
  $('#install').classList.remove('on');
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
});
window.addEventListener('appinstalled', () => $('#install').classList.remove('on'));
$('#install_x').addEventListener('click', () => $('#install').classList.remove('on'));

/* ---- the phone keyboard ---------------------------------------------
   On an iPhone the keyboard does not resize the page: it covers the bottom
   of it, and Safari then scrolls or pans the page to show the field being
   typed in - usually by putting it at the very top of the screen. Every
   attempt to scroll things back afterwards raced Safari and lost.

   So on the questions the page does not scroll at all. The app is pinned to
   the visual viewport - the part of the screen above the keyboard - with its
   height and position set from it (--vvh, --vvt in index.html), so wherever
   Safari pans, the app is exactly what is visible. While a field is being
   typed in, body.kb folds away everything but the question, the field and
   the button, and the field is centred in what is left.

   Pinch-zoom is left alone: while zoomed, the viewport is not followed, so
   the layout keeps its normal size and zooming back out restores it. */
const vv = window.visualViewport;
const COARSE = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const onQuestions = () => !document.body.classList.contains('done')
                       && !document.body.classList.contains('tab-community');
function typingIn() {
  const el = document.activeElement;
  return el && el.matches('input:not([type=range]):not([type=checkbox]):not([type=hidden]),textarea,select')
    ? el : null;
}

function followViewport() {
  if (!vv || (vv.scale || 1) > 1.01) return;
  const s = document.documentElement.style;
  s.setProperty('--vvh', vv.height + 'px');
  s.setProperty('--vvt', vv.offsetTop + 'px');
  s.setProperty('--vh', vv.height + 'px');
}

function keyboardMode() {
  const on = COARSE && !!typingIn();
  if (document.body.classList.contains('kb') === on) return;
  document.body.classList.toggle('kb', on);
  measure();                       // the question lost its eyebrow and sentence
}

/** Put the field in the middle of what can be seen: the question area on
 *  the questions, the sheet in a sheet, the page on pages that scroll. */
function centre(el) {
  if (!el?.isConnected) return;
  const top = vv ? vv.offsetTop : 0;
  const bottom = top + (vv ? vv.height : innerHeight);
  const r = el.getBoundingClientRect();
  const box = el.closest('dialog') || (onQuestions() && el.closest('.deck'));
  if (box) {
    const b = box.getBoundingClientRect();
    const lo = Math.max(b.top, top), hi = Math.min(b.bottom, bottom);
    const off = (r.top + r.height / 2) - (lo + hi) / 2;
    if (Math.abs(off) > 4) box.scrollTop += off;
    return;
  }
  const off = (r.top + r.height / 2) - (top + bottom) / 2;
  if (Math.abs(off) > 8) window.scrollBy(0, off);
}

function settle() {
  followViewport();
  keyboardMode();
  // The stage animates to its new height over .34s; centre once it is there.
  centre(typingIn());
  setTimeout(() => centre(typingIn()), 380);
}

if (vv) {
  vv.addEventListener('resize', settle);
  vv.addEventListener('scroll', () => { followViewport(); });
}
followViewport();
document.addEventListener('focusin', () => {
  if (!typingIn()) return;
  // Now, and again as the keyboard finishes sliding up.
  requestAnimationFrame(settle);
  setTimeout(settle, 300);
  setTimeout(settle, 650);
});
document.addEventListener('focusout', () => {
  // Moving from one field to the next blurs then focuses; only leave typing
  // mode if nothing took the focus.
  setTimeout(() => { if (!typingIn()) { keyboardMode(); followViewport(); } }, 60);
});

/* ====================================================================
   The deck: one question per screen.
   ==================================================================== */
const screens = [...document.querySelectorAll('[data-step]')];
const stage = $('#stage');
const deck = $('#deck');
let step = 0;

function affordance() {
  // Show the fade only while there is something below the fold to reach -
  // and never once the deck is gone, or it floats over the results page.
  const f = $('#f');
  if (!deck || !f) return;
  const more = !deck.hidden && deck.scrollHeight - deck.clientHeight - deck.scrollTop > 24;
  f.classList.toggle('more', more);
}

function measure() {
  const el = screens[step];
  if (el) stage.style.height = el.scrollHeight + 'px';
  setTimeout(affordance, 360);   // just after the .34s stage move
}

const ENTER = ['enter-up', 'enter-down'];
const EXIT = ['exit-up', 'exit-down'];

function go(next, back = false) {
  if (next < 0 || next >= screens.length) return;
  const leaving = screens[step];
  step = next;
  const el = screens[step];

  // The entering screen starts on the far side of the direction of travel,
  // and skips the stagger when you are going back to something already read.
  el.classList.remove('active', ...EXIT, 'quick');
  el.classList.add(back ? 'enter-down' : 'enter-up');
  if (back) el.classList.add('quick');

  // Flush the start state synchronously. This used to sit inside
  // requestAnimationFrame, which is deferred indefinitely on a page that is
  // not being painted - switch apps mid-form and the queued callbacks all
  // fired at once, stacking every question on top of every other.
  void el.offsetWidth;

  el.classList.remove(...ENTER);
  el.classList.add('active');
  if (leaving && leaving !== el) {
    leaving.classList.remove('active', 'quick');
    leaving.classList.add(back ? 'exit-down' : 'exit-up');
  }

  measure();
  chrome();
  const focus = el.dataset.focus && document.getElementById(el.dataset.focus);
  if (focus && !REDUCED) setTimeout(() => focus.focus({preventScroll: true}), 320);
  else if (focus) focus.focus({preventScroll: true});
}

function chrome() {
  const last = step === screens.length - 1;
  $('#bar').style.width = (step / (screens.length - 1) * 100) + '%';
  $('#count').textContent = step ? `${step}/${screens.length - 1}` : '';
  $('#back').hidden = step === 0;
  $('#skip').hidden = !screens[step].hasAttribute('data-optional') || last;
  $('#go').textContent = step === 0 ? 'Start' : last ? 'Plan my evening' : 'Next';
  validate();
}

function validate() {
  const need = screens[step].dataset.required;
  const ok = !need || document.getElementById(need).value.trim().length > 1;
  if (SERVED) $('#go').disabled = !ok;
  return ok;
}

function advance() {
  if (!validate()) return;
  if (step === screens.length - 1) submit();
  else go(step + 1);
}

$('#go').addEventListener('click', advance);
$('#back').addEventListener('click', () => go(step - 1, true));
$('#skip').addEventListener('click', () => go(step + 1));

$('#f').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
  if ($('#ac').classList.contains('open')) return;   // the picker owns Enter
  e.preventDefault();
  advance();
});
$('#f').addEventListener('submit', e => { e.preventDefault(); advance(); });
$('#f').addEventListener('input', validate);
addEventListener('resize', measure);
deck.addEventListener('scroll', affordance, {passive: true});

/* ---- option cards, built from the vocabularies ---------------------- */
for (const [field, entries] of Object.entries({
  relationship_stage: Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.blurb])),
  clothing_style: STYLES,
  transportation: TRANSPORT,
})) {
  const box = document.getElementById('opts_' + field);
  const store = document.getElementById(field);
  if (!box || !store) continue;
  for (const [value, desc] of Object.entries(entries)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt' + (value === store.value ? ' on' : '');
    b.innerHTML = `<b>${esc(value.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()))}</b>`
                + `<span>${esc(desc)}</span>`;
    // Picking an option answers the question, so it moves on by itself -
    // that is the whole appeal of one-thing-per-screen.
    b.onclick = () => {
      store.value = value;
      [...box.children].forEach(c => {
        c.classList.toggle('on', c === b);
        c.classList.remove('chose');
      });
      if (!REDUCED) b.classList.add('chose');
      setTimeout(() => go(step + 1), REDUCED ? 0 : 220);
    };
    box.appendChild(b);
  }
}
measure();

/* ---- interest chips -------------------------------------------------- */
const SUGGESTIONS = ['aquarium','jazz','cheese','hiking','sledding','skating','film','live music',
  'markets','art galleries','bookshops','chocolate','cocktails','vintage','natural wine'];
const chipFor = {};
for (const s of SUGGESTIONS) {
  const el = document.createElement('span');
  el.className = 'chip'; el.textContent = s;
  el.onclick = () => {
    const f = $('#interests');
    const have = f.value.split(',').map(x => x.trim()).filter(Boolean);
    f.value = (have.includes(s) ? have.filter(x => x !== s) : [...have, s]).join(', ');
    syncChips();
  };
  chipFor[s] = el;
  $('#chips').appendChild(el);
}
function syncChips() {
  const have = $('#interests').value.split(',').map(x => x.trim().toLowerCase());
  for (const [s, el] of Object.entries(chipFor)) el.classList.toggle('on', have.includes(s));
}
$('#interests').addEventListener('input', syncChips);

/* ---- dietary needs ----------------------------------------------------
   Real filters, not decoration: they steer dinner towards kitchens that
   OpenStreetMap says cater for them, and a stop the map cannot vouch for
   gets a "call ahead" rather than a false promise. */
const DIET = { vegetarian: 'Vegetarian', vegan: 'Vegan', gluten_free: 'Gluten-free', halal: 'Halal' };
for (const [k, label] of Object.entries(DIET)) {
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'chip'; el.textContent = label; el.dataset.diet = k;
  el.setAttribute('aria-pressed', 'false');
  el.onclick = () => {
    const on = el.getAttribute('aria-pressed') !== 'true';
    el.setAttribute('aria-pressed', String(on));
    el.classList.toggle('on', on);
    $('#diet').value = [...document.querySelectorAll('#diets [aria-pressed=true]')].map(b => b.dataset.diet).join(',');
  };
  $('#diets').appendChild(el);
}
function setDiet(list = []) {
  $('#diet').value = list.join(',');
  document.querySelectorAll('#diets [data-diet]').forEach(b => {
    const on = list.includes(b.dataset.diet);
    b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
  });
}

/* ---- location --------------------------------------------------------
   Two ways in, both ending at coordinates. Coordinates are what make the
   suggestions local: the name alone leaves it guessing which Springfield. */
const acBox = $('#ac');
let acTimer = null, acItems = [], acIndex = -1;

function setAnchor(lat, lon, label) {
  $('#lat').value = lat ?? '';
  $('#lon').value = lon ?? '';
  const el = $('#anchored');
  if (lat == null) { el.classList.remove('on'); el.textContent = ''; measure(); return; }
  el.classList.add('on');
  el.textContent = '◉ Anchored on ' + (label || `${(+lat).toFixed(3)}, ${(+lon).toFixed(3)}`)
                 + ' — stops will be near here.';
  measure();
}

function closeAc() { acBox.classList.remove('open'); acBox.innerHTML = ''; acItems = []; acIndex = -1; measure(); }

function renderAc(list) {
  acItems = list; acIndex = -1;
  if (!list.length) return closeAc();
  acBox.innerHTML = list.map((p, i) =>
    `<div role="option" data-i="${i}">${esc(p.label)}<small>${esc(p.detail || '')}</small></div>`).join('');
  acBox.classList.add('open');
  acBox.querySelectorAll('div[data-i]').forEach(el => { el.onclick = () => pick(list[+el.dataset.i]); });
  measure();
}

function pick(p) {
  $('#location').value = p.detail ? `${p.label}, ${p.detail}` : p.label;
  setAnchor(p.lat, p.lon, p.label);
  closeAc(); validate();
}

$('#location').addEventListener('input', () => {
  setAnchor(null);                 // typing invalidates a picked pin
  clearTimeout(acTimer);
  const q = $('#location').value.trim();
  if (q.length < 2) return closeAc();
  acTimer = setTimeout(() => places.suggest(q).then(renderAc).catch(closeAc), 250);
});

$('#location').addEventListener('keydown', e => {
  if (!acBox.classList.contains('open')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    acIndex = (acIndex + (e.key === 'ArrowDown' ? 1 : -1) + acItems.length) % acItems.length;
    acBox.querySelectorAll('div[data-i]').forEach((el, i) => el.setAttribute('aria-selected', i === acIndex));
  } else if (e.key === 'Enter' && acIndex >= 0) {
    e.preventDefault(); pick(acItems[acIndex]);
  } else if (e.key === 'Escape') { closeAc(); }
});

document.addEventListener('click', e => { if (!e.target.closest('.loc')) closeAc(); });

$('#here').addEventListener('click', () => {
  const btn = $('#here');
  if (!navigator.geolocation) return setStale('This browser will not share your location.');
  btn.disabled = true; btn.textContent = '···';
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude, longitude } = pos.coords;
      const place = await places.reverse(latitude, longitude);
      // A failed reverse lookup still leaves usable coordinates.
      $('#location').value = place?.label || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      setAnchor(latitude, longitude, place?.label);
      closeAc(); validate();
      btn.disabled = false; btn.innerHTML = '&#9678;';
    },
    err => {
      btn.disabled = false; btn.innerHTML = '&#9678;';
      setStale(err.code === 1
        ? 'Location permission denied — type where you are instead.'
        : (window.isSecureContext
            ? 'Could not get a location fix — type where you are instead.'
            : 'Location needs https. Type where you are instead.'));
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
});

/* ---- planning --------------------------------------------------------
   No server and no job polling any more: the work happens here. It still
   takes a few seconds, because OpenStreetMap asks for one request a second
   and an evening needs several, so the button reports what it is doing. */
function working(label) {
  $('#go').innerHTML = `<span class="spin"></span>${esc(label)}`;
}

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + (((6 - d.getDay()) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

function readForm() {
  const f = Object.fromEntries(new FormData($('#f')).entries());
  return {
    location: (f.location || '').trim(),
    lat: f.lat === '' ? null : +f.lat,
    lon: f.lon === '' ? null : +f.lon,
    budget: parseFloat(f.budget) || 150,
    currency: (f.currency || 'USD').toUpperCase(),
    stage: f.relationship_stage || 'getting_to_know',
    style: f.clothing_style || 'smart_casual',
    transport: f.transportation || 'walking',
    interests: (f.interests || '').split(',').map(s => s.trim()).filter(Boolean),
    date: f.on || nextSaturday(),
    startTime: f.start_time || '17:00',
    hours: parseFloat(f.hours) || 5,
    note: f.party_note || '',
    weatherText: (f.weather || '').trim(),
    adventure: parseInt(f.adventure, 10) || 2,
    localOnly: f.local_only === '1',
    diet: (f.diet || '').split(',').filter(Boolean),
  };
}

let current = null;       // the plan on screen: { plan, prefs, weather, saved }

function submit() { return run(readForm()); }

/** Build an evening from a set of answers, behind the invitation. */
async function run(prefs) {
  const btn = $('#go');
  btn.disabled = true;
  $('#stale').classList.remove('on');
  closeStop();
  const invite = openInvitation(prefs.location);
  const phase = (label, info) => { working(label); invite.phase(label, info); };
  phase('Finding the place');

  try {
    // Resolve the location to a point if the picker was not used.
    if (prefs.lat == null || prefs.lon == null) {
      const hit = await places.locate(prefs.location);
      if (hit) {
        prefs.lat = hit.lat; prefs.lon = hit.lon;
        if (hit.detail && !prefs.location.toLowerCase().includes(hit.detail.toLowerCase())) {
          prefs.location = `${hit.label}, ${hit.detail}`;
        }
      }
    }
    if (prefs.lat == null) {
      throw new Error(`Could not find "${prefs.location}" on the map. Try a nearby town or city.`);
    }
    invite.note('place', `Anchored on ${prefs.location.split(',')[0]}`);

    phase('Checking the forecast');
    // What locals shared around here, asked for alongside the forecast. It
    // never fails and never waits long: without it the plan is simply made
    // from map data alone.
    const asking = community.localPicks(prefs.lat, prefs.lon);
    const weather = prefs.weatherText
      ? wx.parseOverride(prefs.weatherText)
      : await wx.forecast(prefs.lat, prefs.lon, prefs.date);
    invite.note('weather', wx.isKnown(weather) ? wx.brief(weather) : 'No forecast yet - planned for any sky');

    const plan = await build(prefs, weather, phase, await asking);
    invite.note('route', `${plan.stops.length} stops, ${plan.transportNote.split(' - ')[0].toLowerCase()}`);
    await invite.done();

    const data = { plan, prefs, weather, saved: Date.now() };
    show(data);
    save(data);
  } catch (err) {
    invite.fail();
    $('#out').classList.add('on');
    document.body.classList.add('done');
    deck.hidden = true; affordance();
    $('#nav').style.display = 'none';
    $('#out').innerHTML = `<div class="card err">${esc(
      navigator.onLine ? err.message : 'You are offline — no new plan until you have signal.')}</div>`
      + `<button class="go" type="button" style="margin-top:18px" onclick="location.reload()">Start over</button>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Plan my evening';
  }
}

function put(id, v) {
  const el = document.getElementById(id);
  if (el && v != null && v !== '') el.value = v;
}

function save(data) {
  try { localStorage.setItem(LAST_PLAN, JSON.stringify(data)); } catch {}
}

/* ---- results ---------------------------------------------------------- */
function show(d, { quiet = false } = {}) {
  current = d;
  const out = $('#out');
  out.innerHTML = planHtml(d, { community: community.enabled });

  const prefs = d.prefs;
  const here = prefs.lat != null
    ? { label: (prefs.location || '').split(',')[0], detail: (prefs.location || '').split(',').slice(1).join(',').trim(),
        lat: prefs.lat, lon: prefs.lon }
    : null;
  $('#locals_more')?.addEventListener('click', () => openCommunity(here));
  $('#locals_share')?.addEventListener('click', () => openCommunity(here, 'share'));

  out.querySelectorAll('.row').forEach(r => r.addEventListener('click', () => openRow(+r.dataset.i)));
  wireTune(out, prefs, changes => {
    const next = { ...prefs, ...changes };
    // Keep the question deck in step, so "Plan another" starts from here.
    put('budget', next.budget); put('start_time', next.startTime); put('hours', next.hours);
    $('#budget_range').value = next.budget; $('#budget_out').textContent = Math.round(next.budget);
    $('#hours_out').textContent = next.hours;
    setDiet(next.diet);
    run(next);
  });

  revealTiles(out);
  deck.hidden = true;
  affordance();
  $('#nav').style.display = 'none';
  document.body.classList.add('done');
  out.classList.add('on');
  $('#bar').style.width = '100%';
  $('#count').textContent = '';
  $('#again').onclick = () => {
    out.classList.remove('on');
    deck.hidden = false;
    $('#nav').style.display = '';
    document.body.classList.remove('done');
    $('#stale').classList.remove('on');
    affordance();
    go(1);
  };
  if (!quiet) scrollTo({top: 0, behavior: 'auto'});
}

/* ---- a stop, opened -------------------------------------------------- */
const rowFor = i => document.querySelector(`#out .row[data-i="${i}"]`);

function stopCtx(i) {
  const s = current.plan.stops[i], cur = current.prefs.currency;
  return {
    index: i, stop: s, rowFor,
    money: n => n > 0 ? `${cur} ${Math.round(n)}` : 'Free',
    canSwap: !!(s.slot && s.alts?.length),
    onSwap: swapAt,
  };
}

function openRow(i) { openStop(stopCtx(i)); }

function swapAt(i) {
  const s = current.plan.stops[i];
  openSwap({
    stop: s, index: i, alts: s.alts || [],
    async onPick(venue) {
      swapStop(current.plan, i, venue, current.prefs, current.weather);
      current.saved = Date.now();
      show(current, { quiet: true });
      if (stopOpen()) refreshStop(stopCtx(i));
      save(current);
      // A photograph, if the new place has one - it arrives when it arrives.
      const before = current.plan.stops[i].photo;
      await photograph(current.plan.stops[i]);
      if (current.plan.stops[i].photo !== before) {
        save(current);
        show(current, { quiet: true });
        if (stopOpen()) refreshStop(stopCtx(i));
      }
      const row = rowFor(i);
      if (row && !stopOpen()) springTo(row, { scale: 0.96 }, { scale: 1 }, { tension: 220, friction: 16 });
    },
  });
}

/* ---- opening state ---------------------------------------------------
   Show the last plan straight away. The app should open to something useful:
   standing outside a bar with one bar of signal, trying to remember which
   street the next stop is on, is the real failure case. */
(function start() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAST_PLAN) || 'null'); } catch {}

  go(0);
  if (!saved?.plan) return;

  const p = saved.prefs || {};
  put('location', p.location); put('budget', p.budget); put('currency', p.currency);
  put('relationship_stage', p.stage); put('clothing_style', p.style);
  put('transportation', p.transport); put('hours', p.hours);
  put('party_note', p.note); put('lat', p.lat); put('lon', p.lon);
  put('adventure', p.adventure); $('#local_only').checked = !!p.localOnly; sayAdventure();
  put('start_time', p.startTime); setDiet(p.diet || []);
  if (Array.isArray(p.interests) && p.interests.length) {
    $('#interests').value = p.interests.join(', ');
    syncChips();
  }
  if (p.budget) { $('#budget_range').value = p.budget; $('#budget_out').textContent = Math.round(p.budget); }
  if (p.currency) $('#cur_out').textContent = p.currency;
  if (p.lat != null && p.lon != null) setAnchor(p.lat, p.lon, p.location);

  show(saved);
  const when = new Date(saved.saved || Date.now());
  const today = when.toDateString() === new Date().toDateString();
  setStale((navigator.onLine ? 'Your last plan, from ' : 'Offline — showing your last plan, from ')
    + (today ? 'earlier today' : when.toLocaleDateString(undefined, {day: 'numeric', month: 'long'}))
    + '. Plan another any time.');
})();

addEventListener('online', () => $('#stale').classList.remove('on'));

/* ---- budget slider, hours, currency ---------------------------------- */
const bRange = $('#budget_range'), bNum = $('#budget');
bRange.addEventListener('input', () => {
  bNum.value = bRange.value; $('#budget_out').textContent = Math.round(bRange.value);
});
bNum.addEventListener('input', () => {
  $('#budget_out').textContent = Math.round(bNum.value || 0);
  if (+bNum.value >= +bRange.min && +bNum.value <= +bRange.max) bRange.value = bNum.value;
});
$('#currency').addEventListener('input', e =>
  $('#cur_out').textContent = (e.target.value || 'USD').toUpperCase());
$('#hours').addEventListener('input', e => $('#hours_out').textContent = e.target.value);

/* ---- adventure ------------------------------------------------------- */
function sayAdventure() {
  const [name, say] = ADVENTURE[$('#adventure').value] || ADVENTURE[2];
  $('#adv_name').textContent = name;
  $('#adv_say').textContent = say;
  $('#adventure').setAttribute('aria-valuetext', `${name}: ${say}`);
}
$('#adventure').addEventListener('input', sayAdventure);
sayAdventure();

/* ---- community tab --------------------------------------------------- */
initCommunity({
  // Open the community on wherever the last plan was, if there was one.
  planLocation() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LAST_PLAN) || 'null'); } catch {}
    const p = saved?.prefs;
    if (p?.lat == null) return null;
    const [label, ...rest] = String(p.location || '').split(',');
    return { label: label.trim(), detail: rest.join(',').trim(), lat: p.lat, lon: p.lon };
  },
  // The deck was display:none while the other tab was up, so its height is stale.
  onPlanShown() { measure(); affordance(); },
});
