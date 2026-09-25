import * as places from './lib/places.js';
import * as wx from './lib/weather.js';
import * as community from './lib/community.js';
import { build, STAGES, STYLES, TRANSPORT, ADVENTURE, walkTime, endOf } from './lib/plan.js';
import { initCommunity, openCommunity } from './community-tab.js';

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
   `svh` is the viewport with the browser chrome expanded; it does not shrink
   when the software keyboard opens, so the layout stayed full height while
   only half was visible and the button sat behind the keyboard. The visual
   viewport does shrink, so drive the height from that. */
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => document.documentElement.style.setProperty('--vh', vv.height + 'px');
  vv.addEventListener('resize', fit);
  fit();
  document.addEventListener('focusin', e => {
    if (!e.target.matches('input,textarea')) return;
    setTimeout(() => e.target.scrollIntoView({block: 'center', behavior: 'smooth'}), 250);
  });
}

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
  };
}

async function submit() {
  const btn = $('#go');
  btn.disabled = true;
  $('#stale').classList.remove('on');
  working('Finding the place');

  try {
    const prefs = readForm();

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

    working('Checking the forecast');
    // What locals shared around here, asked for alongside the forecast. It
    // never fails and never waits long: without it the plan is simply made
    // from map data alone.
    const asking = community.localPicks(prefs.lat, prefs.lon);
    const weather = prefs.weatherText
      ? wx.parseOverride(prefs.weatherText)
      : await wx.forecast(prefs.lat, prefs.lon, prefs.date);

    const plan = await build(prefs, weather, working, await asking);

    const data = { plan, prefs, weather, saved: Date.now() };
    show(data);
    try { localStorage.setItem(LAST_PLAN, JSON.stringify(data)); } catch {}
  } catch (err) {
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

/* ---- route map -------------------------------------------------------
   A slippy map is about fifteen lines of Web Mercator, so there is no
   mapping library here: pick the zoom that fits every stop, lay the tiles
   that cover the frame, and put a numbered pin on each venue. */
function routeMap(stops, height) {
  const pts = stops.map((s, i) => ({s, i})).filter(o => o.s.lat != null && o.s.lon != null);
  if (pts.length < 2) return '';

  const W = Math.min(680, Math.max(280, ($('.wrap')?.clientWidth || 640) - 4));
  const H = height, TILE = 256, PAD = 42;
  const projX = (lon, z) => (lon + 180) / 360 * 2 ** z * TILE;
  const projY = (lat, z) => {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z * TILE;
  };

  let z = 18;
  for (; z > 2; z--) {
    const xs = pts.map(o => projX(o.s.lon, z)), ys = pts.map(o => projY(o.s.lat, z));
    if (Math.max(...xs) - Math.min(...xs) <= W - PAD * 2 &&
        Math.max(...ys) - Math.min(...ys) <= H - PAD * 2) break;
  }

  const xs = pts.map(o => projX(o.s.lon, z)), ys = pts.map(o => projY(o.s.lat, z));
  const left = (Math.max(...xs) + Math.min(...xs)) / 2 - W / 2;
  const top = (Math.max(...ys) + Math.min(...ys)) / 2 - H / 2;
  const span = 2 ** z;

  let tiles = '';
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + H) / TILE); ty++) {
      if (ty < 0 || ty >= span) continue;              // above the pole
      const wrapped = ((tx % span) + span) % span;     // across the date line
      // No loading="lazy": inside a short clipped box the browser decides
      // most tiles are off-screen and never fetches them.
      tiles += `<img src="https://tile.openstreetmap.org/${z}/${wrapped}/${ty}.png" `
             + `alt="" style="left:${tx * TILE - left}px;top:${ty * TILE - top}px">`;
    }
  }
  const pins = pts.map(o =>
    `<div class="pin" title="${esc(o.s.name)}" style="left:${projX(o.s.lon, z) - left}px;`
    + `top:${projY(o.s.lat, z) - top}px">${o.i + 1}</div>`).join('');

  return `<div class="map" style="height:${H}px"><div class="tiles">${tiles}</div>${pins}`
       + `<div class="credit">&copy; <a href="https://www.openstreetmap.org/copyright" `
       + `target="_blank" rel="noopener">OpenStreetMap</a></div></div>`;
}

function revealTiles() {
  // A cached tile finishes before any handler is attached, so `complete` has
  // to be checked as well as listened for - otherwise the second plan you
  // make has an invisible map.
  for (const img of document.querySelectorAll('.map img')) {
    if (img.complete && img.naturalWidth > 0) img.classList.add('on');
    else img.addEventListener('load', () => img.classList.add('on'), {once: true});
    img.addEventListener('error', () => img.classList.add('on'), {once: true});
  }
}

/* ---- results ---------------------------------------------------------- */
function show(d) {
  const p = d.plan, prefs = d.prefs, cur = prefs.currency;
  const money = n => n > 0 ? `${cur} ${Math.round(n)}` : 'Free';
  const when = prefs.date
    ? new Date(prefs.date + 'T12:00').toLocaleDateString(undefined,
        {weekday: 'long', day: 'numeric', month: 'long'}) : '';
  const head = [prefs.location, when, p.adventure, prefs.localOnly ? 'Local only' : '',
    `${cur} ${Math.round(p.totalCost)} for two`]
    .filter(Boolean).join(' &middot; ');

  const mapHtml = routeMap(p.stops, 240);

  const stops = p.stops.map((s, i) => {
    const shot = s.photo
      ? `<div class="shot"><img src="${esc(s.photo)}" alt="" loading="lazy">`
        + (s.photoCredit ? `<a class="src" href="${esc(s.photoCredit)}" target="_blank" rel="noopener">Wikipedia</a>` : '')
        + `</div>` : '';
    const kind = s.venueKind ? `<span class="kind">${esc(s.venueKind)}</span>` : '';
    const blurb = s.blurb ? `<div class="blurb">${esc(s.blurb)}</div>` : '';
    const local = s.locals ? `<div class="local">Recommended by ${
        s.locals.posts === 1 ? 'a local' : `${s.locals.posts} locals`}${
        s.locals.loves ? ` &middot; ${s.locals.loves} ${s.locals.loves === 1 ? 'love' : 'loves'}` : ''}${
        (s.locals.notes || []).map(n => `<q>${esc(n.note)}</q><small>${esc(n.author)}${
          n.guide ? ', local guide' : ''}</small>`).join('')}</div>` : '';

    const facts = [s.cuisine, walkTime(s)].filter(Boolean);
    const bits = [];
    if (facts.length) bits.push(`<div class="detail">${esc(facts.join(' · '))}</div>`);
    if (s.address) bits.push(`<div class="detail"><b>Address:</b> ${esc(s.address)}</div>`);
    if (s.openingHours) bits.push(`<div class="detail"><b>Hours:</b> ${esc(s.openingHours)}</div>`);
    if (s.website) bits.push(`<div class="detail"><b>Site:</b> <a href="${esc(s.website)}" `
      + `target="_blank" rel="noopener">${esc(s.website.replace(/^https?:\/\//, '').slice(0, 40))}</a></div>`);
    if (s.tip) bits.push(`<div class="detail"><b>Tip:</b> ${esc(s.tip)}</div>`);
    if (s.booking) bits.push(`<div class="detail"><b>Booking:</b> ${esc(s.booking)}</div>`);
    if (!s.indoor && s.fallback) bits.push(`<div class="detail"><b>If it rains:</b> ${esc(s.fallback)}</div>`);

    const links = [];
    if (s.bookUrl) links.push(`<a class="btn" href="${esc(s.bookUrl)}" target="_blank" rel="noopener">Book</a>`);
    if (s.mapUrl) links.push(`<a class="btn ghost" href="${esc(s.mapUrl)}" target="_blank" rel="noopener">`
      + `${s.verified ? 'Open in Maps' : 'Map'}</a>`);

    return `<div class="card stop" style="animation-delay:${Math.min(i * 55, 220)}ms">
        ${shot}
        <div class="meta">${i + 1} &middot; ${esc(s.start)}–${esc(endOf(s))} &middot; ${money(s.cost)}</div>
        ${kind}
        <h3>${esc(s.name)}</h3>
        <p class="why">${esc(s.why)}</p>
        ${local}
        ${blurb}
        ${bits.join('')}
        <div class="links">${links.join('')}</div>
      </div>` + (s.travelNext ? `<div class="travel">&darr;&nbsp; ${esc(s.travelNext)}</div>` : '');
  }).join('');

  const notes = [['When', p.timing], ['Wear', p.wear], ['Getting around', p.transportNote],
                 ['Weather', p.weatherCall], ['If it breaks', p.backup]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="detail"><b>${k}:</b> ${esc(v)}</div>`).join('');

  const warn = p.warnings?.length
    ? `<div class="card warn"><h4>Check before you commit</h4><ul>${
        p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';

  // Real People's Insights: evenings locals shared near here. With none yet,
  // ask for one - that is how a city's first local picks arrive.
  const where = esc((prefs.location || '').split(',')[0]);
  const insights = p.insights?.length
    ? `<div class="card insights"><h4>Real People's Insights</h4>${p.insights.map(i => `
        <div class="insight"><b>${esc(i.title)}</b>
          <div class="detail">by ${esc(i.author)}${i.guide ? ' <span class="badge">Local guide</span>' : ''}
            &middot; &#9829; ${i.loves}</div>
          <div class="detail">${esc(i.stops.join(' → '))}</div></div>`).join('')}
        ${community.enabled ? '<button class="btn ghost" type="button" id="locals_more" style="margin-top:14px">More from locals</button>' : ''}
      </div>`
    : community.enabled
      ? `<div class="card insights"><h4>Real People's Insights</h4>
          <p class="detail" style="margin-top:0">Nobody has shared an evening around ${where} yet. Been somewhere good? The planner will start sending people there.</p>
          <button class="btn ghost" type="button" id="locals_share" style="margin-top:12px">Share an evening</button></div>`
      : '';

  $('#out').innerHTML = `
    <div class="hero">
      <p class="eyebrow">${head}</p>
      <h2>${esc(p.title)}</h2>
      <p class="pitch">${esc(p.pitch)}</p>
    </div>
    ${mapHtml}
    <div class="arc"><b>${esc(p.stops.map(s => s.name).join(' → '))}</b>${
      wx.isKnown(d.weather) ? `<br>Forecast: ${esc(wx.brief(d.weather))}` : ''}</div>
    ${stops}
    ${warn}
    ${insights}
    <div class="card" style="margin-top:18px">${notes}</div>
    <p class="foot">Places and hours from <b>OpenStreetMap</b> contributors; photographs
      from <b>Wikipedia</b>${community.enabled ? '; local picks from the <b>Kindling community</b>' : ''}.
      Booking links may earn a commission. Everything here is an
      estimate &mdash; check before you go.${community.enabled ? ' <a href="privacy.html">Privacy</a>' : ''}</p>
    <button class="go" type="button" id="again" style="margin-top:20px">Plan another</button>`;

  const here = prefs.lat != null
    ? { label: (prefs.location || '').split(',')[0], detail: (prefs.location || '').split(',').slice(1).join(',').trim(),
        lat: prefs.lat, lon: prefs.lon }
    : null;
  $('#locals_more')?.addEventListener('click', () => openCommunity(here));
  $('#locals_share')?.addEventListener('click', () => openCommunity(here, 'share'));

  revealTiles();
  deck.hidden = true;
  affordance();
  $('#nav').style.display = 'none';
  document.body.classList.add('done');
  $('#out').classList.add('on');
  $('#bar').style.width = '100%';
  $('#count').textContent = '';
  $('#again').onclick = () => {
    $('#out').classList.remove('on');
    deck.hidden = false;
    $('#nav').style.display = '';
    document.body.classList.remove('done');
    $('#stale').classList.remove('on');
    affordance();
    go(1);
  };
  scrollTo({top: 0, behavior: REDUCED ? 'auto' : 'smooth'});
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
  const put = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
  put('location', p.location); put('budget', p.budget); put('currency', p.currency);
  put('relationship_stage', p.stage); put('clothing_style', p.style);
  put('transportation', p.transport); put('hours', p.hours);
  put('party_note', p.note); put('lat', p.lat); put('lon', p.lon);
  put('adventure', p.adventure); $('#local_only').checked = !!p.localOnly; sayAdventure();
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
