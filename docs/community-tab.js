/* The Community tab: pick a city, read the evenings locals shared there, love
 * the good ones, share your own. Talks to lib/community.js for everything
 * that leaves the page.
 *
 * Signing in happens by email, so it can land in a different tab from the one
 * that asked - an emailed link opens wherever the mail app says. Anything the
 * person was in the middle of (a half-written evening, a love) is kept in
 * localStorage and picked up again on the other side.
 */

import * as C from './lib/community.js';
import * as places from './lib/places.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const CITY = 'kindling.community.city';
const DRAFT = 'kindling.community.draft';
const NEXT = 'kindling.community.next';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

/* The same kinds of stop the planner builds evenings from, so a shared place
 * can be routed to as that kind of stop. */
const KINDS = {
  drinks: 'Drinks', coffee: 'Coffee', food: 'Dinner', music: 'Live music', show: 'Show or film',
  activity: 'Museum or gallery', aquarium: 'Aquarium or zoo', viewpoint: 'View or park',
  shopping: 'Market or shops', treat: 'Local treats (cheese, bakery)',
  outdoors: 'Outdoors (hill, swim, sledding)',
};
const STAGE = {
  first_date: 'First date', getting_to_know: 'Getting to know', dating: 'Dating',
  long_term: 'Long term', special_occasion: 'Special occasion',
};
const MAX_STOPS = 6;

let city = store.get(CITY);          // { label, detail, lat, lon }
let shareCity = null;
let sort = 'loved';
let loading = 0;
let planLocation = () => null;
let onPlanShown = () => {};

export const enabled = C.enabled;

export function initCommunity(opts = {}) {
  if (!C.enabled) return;
  planLocation = opts.planLocation || planLocation;
  onPlanShown = opts.onPlanShown || onPlanShown;

  const tabs = [$('#tab_plan'), $('#tab_community')];
  $('#tabs').hidden = false;
  tabs[0].onclick = () => selectTab('plan');
  tabs[1].onclick = () => selectTab('community');
  // Arrow keys move between tabs, as a tab list is expected to.
  $('#tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = tabs[tabs.indexOf(document.activeElement) === 0 ? 1 : 0];
    next.focus();
    next.click();
  });

  placePicker($('#c_city'), $('#c_ac'), p => {
    if (!p) return;
    city = p;
    store.set(CITY, p);
    load();
  });
  $('#c_here').onclick = hereAndNow;
  $('#c_sort_loved').onclick = () => setSort('loved');
  $('#c_sort_new').onclick = () => setSort('new');
  $('#c_share').onclick = () => whenSignedIn('share', openShare);
  $('#c_feed').addEventListener('click', onFeedClick);

  document.querySelectorAll('dialog [data-close]').forEach(b => {
    b.onclick = () => b.closest('dialog').close();
  });
  $('#signin_form').addEventListener('submit', onSignIn);
  $('#name_form').addEventListener('submit', onName);
  $('#share_form').addEventListener('submit', onShare);
  $('#share_form').addEventListener('input', saveDraft);
  $('#sh_add').onclick = () => { addStop(); saveDraft(); };
  placePicker($('#sh_city'), $('#sh_ac'), p => { shareCity = p; saveDraft(); });

  C.onChange(renderAccount);
  renderAccount();

  // Back from the emailed link: finish signing in, then carry on with
  // whatever they were doing before they left. Usually that is a fresh page
  // load, but a link opened in a tab already showing Kindling only changes
  // the fragment, and the page never reloads.
  const back = () => C.takeRedirect().then(r => {
    if (!r) return;
    selectTab('community');
    if (r.error) toast(r.error);
    else afterSignIn();
  });
  back();
  addEventListener('hashchange', back);
}

/* --- tabs ---------------------------------------------------------------- */

export function selectTab(which) {
  const on = which === 'community';
  document.body.classList.toggle('tab-community', on);
  $('#community').hidden = !on;
  $('#tab_plan').setAttribute('aria-selected', String(!on));
  $('#tab_community').setAttribute('aria-selected', String(on));
  $('#tab_plan').tabIndex = on ? -1 : 0;
  $('#tab_community').tabIndex = on ? 0 : -1;
  scrollTo({ top: 0 });
  if (!on) return onPlanShown();
  if (!city) {
    city = planLocation();
    if (city) store.set(CITY, city);
  }
  load();
}

/** From a plan: show what locals shared around where it was planned. */
export function openCommunity(loc, then) {
  if (loc) { city = loc; store.set(CITY, loc); }
  selectTab('community');
  if (then === 'share') whenSignedIn('share', openShare);
}

/* --- the feed ------------------------------------------------------------ */

function setSort(s) {
  sort = s;
  $('#c_sort_loved').setAttribute('aria-pressed', String(s === 'loved'));
  $('#c_sort_new').setAttribute('aria-pressed', String(s === 'new'));
  load();
}

async function load() {
  const feedEl = $('#c_feed');
  if (!city) {
    $('#c_guides').innerHTML = '';
    feedEl.innerHTML = `<div class="card empty"><b>Where are you?</b>Pick a city to see what locals do there.</div>`;
    return;
  }
  $('#c_city').value = city.detail ? `${city.label}, ${city.detail}` : city.label;
  const mine = ++loading;
  feedEl.innerHTML = `<p class="empty"><span class="spin"></span>Asking the locals</p>`;
  try {
    const [posts, leaders] = await Promise.all([
      C.feed(city.lat, city.lon, { sort }),
      C.leaders(city.lat, city.lon).catch(() => []),
    ]);
    const lovedIt = await C.loved(posts.map(p => p.id)).catch(() => new Set());
    if (mine !== loading) return;              // a newer city or sort has taken over
    renderLeaders(leaders);
    renderFeed(posts, lovedIt);
  } catch (e) {
    if (mine !== loading) return;
    $('#c_guides').innerHTML = '';
    feedEl.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}

function renderLeaders(rows) {
  // One row per person per city, and a 30 km search can span two cities.
  const best = new Map();
  for (const r of rows) {
    const had = best.get(r.author_id);
    if (!had || r.loves > had.loves || (r.is_guide && !had.is_guide)) best.set(r.author_id, r);
  }
  const all = [...best.values()];
  const guides = all.filter(r => r.is_guide);
  const shown = (guides.length ? guides : all).slice(0, 6);
  const where = esc(city.label);
  $('#c_guides').innerHTML = `<div class="card guides">
      <h4>${guides.length ? `Local guides in ${where}` : `Most loved in ${where}`}</h4>
      ${shown.length ? `<div class="people">${shown.map(r => `<span class="person">${esc(r.display_name)}${
        r.is_guide ? ' <span class="badge">Local guide</span>' : ''}<small>${r.loves} ${plural(r.loves, 'love')} · ${
        r.posts} ${plural(r.posts, 'evening')}</small></span>`).join('')}</div>` : ''}
      <p class="hint">Share ${C.GUIDE_POSTS} evenings in a city that get ${C.GUIDE_LOVES} loves between them and you become one of its local guides.</p>
    </div>`;
}

function renderFeed(posts, lovedIt) {
  if (!posts.length) {
    $('#c_feed').innerHTML = `<div class="card empty"><b>Nobody has shared ${esc(city.label)} yet</b>
      Been somewhere good? It takes two minutes, and the planner starts sending people there.
      <div style="margin-top:16px"><button class="btn" type="button" data-act="share">Share an evening</button></div></div>`;
    return;
  }
  $('#c_feed').innerHTML = posts.map(p => card(p, lovedIt.has(p.id))).join('');
}

function card(p, lovedIt) {
  const me = C.user()?.id;
  const stops = (p.stops || []).map(s => `<li><b>${esc(s.name)}</b><span class="k">${
    esc(KINDS[s.kind] || '')}</span>${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</li>`).join('');
  const facts = [
    STAGE[p.stage],
    p.budget != null ? `${p.currency || ''} ${Math.round(p.budget)} for two`.trim() : '',
  ].filter(Boolean);
  const actions = p.author_id === me
    ? `<span class="hint" style="margin:0 8px 0 0">${p.love_count} ${plural(p.love_count, 'love')}</span>
       <button class="quiet" type="button" data-act="delete">Delete</button>`
    : `<button class="love" type="button" data-act="love" aria-pressed="${lovedIt}">&#9829; Love this<span>${p.love_count}</span></button>
       <button class="quiet" type="button" data-act="report">Report</button>`;
  return `<article class="card post" data-id="${esc(p.id)}">
      <div class="meta">${esc(p.city)} &middot; ${esc(ago(p.created_at))}</div>
      <h3>${esc(p.title)}</h3>
      <p class="by">by <b>${esc(p.author_name)}</b>${p.author_is_guide ? ' <span class="badge">Local guide</span>' : ''}</p>
      <ol class="route">${stops}</ol>
      ${p.tips ? `<p class="tips">${esc(p.tips)}</p>` : ''}
      ${facts.length ? `<div class="detail">${esc(facts.join(' · '))}</div>` : ''}
      <div class="post-actions">${actions}</div>
    </article>`;
}

async function onFeedClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'share') return whenSignedIn('share', openShare);
  const id = btn.closest('[data-id]')?.dataset.id;
  if (!id) return;

  if (act === 'love') return whenSignedIn(`love:${id}`, () => toggleLove(btn, id));
  if (act === 'report') {
    return whenSignedIn(`report:${id}`, async () => {
      if (!confirm('Report this evening? Three reports hide it until it is reviewed.')) return;
      try { await C.report(id); toast('Reported. Thank you.'); } catch (ex) { toast(ex.message); }
    });
  }
  if (act === 'delete') {
    if (!confirm('Delete this evening? Its loves go with it.')) return;
    try { await C.remove(id); toast('Deleted.'); load(); } catch (ex) { toast(ex.message); }
  }
}

/* Optimistic, because a heart that waits for a round trip feels broken. Put
 * back if the server says no. */
async function toggleLove(btn, id) {
  if (!btn?.isConnected) btn = document.querySelector(`[data-id="${CSS.escape(id)}"] [data-act=love]`);
  if (!btn) return;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  const count = btn.querySelector('span');
  const set = v => {
    btn.setAttribute('aria-pressed', String(v));
    count.textContent = Math.max(0, +count.textContent + (v ? 1 : -1));
  };
  set(on);
  try { await C.love(id, on); } catch (e) { set(!on); toast(e.message); }
}

/* --- signing in ---------------------------------------------------------- */

/** Do `then` now if signed in with a name, otherwise remember it as `key` and
 *  sign in first - possibly by way of an email and another tab. */
async function whenSignedIn(key, then) {
  if (C.user()) {
    let p = null;
    try { p = await C.profile(); } catch (e) { return toast(e.message); }
    if (p) return then();
    store.set(NEXT, key);
    return openName();
  }
  store.set(NEXT, key);
  openSignIn();
}

async function afterSignIn() {
  let p = null;
  try { p = await C.profile(); } catch (e) { return toast(e.message); }
  if (!p) return openName();
  toast(`Signed in as ${p.display_name}.`);
  resume();
}

function resume() {
  const next = store.get(NEXT);
  store.set(NEXT, null);
  load();
  if (next === 'share') return openShare();
  const [act, id] = String(next || '').split(':');
  if (act === 'love' && id) setTimeout(() => toggleLove(null, id), 700);
}

function openSignIn() {
  $('#si_step1').hidden = false;
  $('#si_step2').hidden = true;
  $('#si_err').textContent = '';
  $('#si_go').textContent = 'Email me a link';
  $('#si_say').textContent = 'We will email you a sign-in link. No password to remember.';
  $('#d_signin').showModal();
}

async function onSignIn(e) {
  e.preventDefault();
  const email = $('#si_email').value.trim();
  const err = $('#si_err');
  const go = $('#si_go');
  err.textContent = '';
  const coding = !$('#si_step2').hidden;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'That email does not look right.'; return; }
  go.disabled = true;
  try {
    if (!coding) {
      await C.sendLink(email);
      $('#si_step1').hidden = true;
      $('#si_step2').hidden = false;
      $('#si_say').textContent = `Check ${email}. Tap the link in the email, or type its code here.`;
      go.textContent = 'Sign in';
      $('#si_code').focus();
    } else {
      await C.verifyCode(email, $('#si_code').value);
      $('#d_signin').close();
      afterSignIn();
    }
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    go.disabled = false;
  }
}

function openName() {
  $('#nm_err').textContent = '';
  $('#nm_city').value = $('#nm_city').value || city?.label || '';
  $('#d_name').showModal();
}

async function onName(e) {
  e.preventDefault();
  const name = $('#nm_name').value.trim();
  const err = $('#nm_err');
  if (name.length < 2) { err.textContent = 'Two letters at least.'; return; }
  $('#nm_go').disabled = true;
  try {
    await C.saveProfile(name, $('#nm_city').value);
    $('#d_name').close();
    toast(`Welcome, ${name}.`);
    resume();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    $('#nm_go').disabled = false;
  }
}

async function renderAccount() {
  const box = $('#c_account');
  if (!box) return;
  if (!C.user()) {
    box.innerHTML = `Share and react once you are signed in.
      <button class="quiet" type="button" id="c_signin">Sign in</button>`;
    $('#c_signin').onclick = () => whenSignedIn('', () => {});
    return;
  }
  let p = null;
  try { p = await C.profile(); } catch {}
  box.innerHTML = `Signed in as <b style="color:var(--muted)">${esc(p?.display_name || C.user().email)}</b>
    <button class="quiet" type="button" id="c_signout">Sign out</button>`;
  $('#c_signout').onclick = async () => { await C.signOut(); toast('Signed out.'); load(); };
}

/* --- sharing ------------------------------------------------------------- */

function stopRow(s = {}, i = 0) {
  const kind = s.kind || ['drinks', 'activity', 'food'][i] || 'food';
  const n = i + 1;
  return `<div class="stop-row">
      <div class="pair">
        <div class="narrow"><select data-f="kind" aria-label="Kind of stop ${n}">${
          Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${v}</option>`).join('')
        }</select></div>
        <div><input data-f="name" maxlength="80" placeholder="Name of the place" aria-label="Place ${n}" value="${esc(s.name || '')}"></div>
      </div>
      <input data-f="note" maxlength="280" placeholder="Why go, what to order (optional)" aria-label="Why go, stop ${n}" value="${esc(s.note || '')}">
      <button class="quiet" type="button" data-remove>Remove</button>
    </div>`;
}

function addStop(s) {
  const box = $('#sh_stops');
  if (box.children.length >= MAX_STOPS) return;
  box.insertAdjacentHTML('beforeend', stopRow(s, box.children.length));
  box.lastElementChild.querySelector('[data-remove]').onclick = e => {
    if (box.children.length <= 2) return toast('Two stops at least - that is what makes it an evening.');
    e.target.closest('.stop-row').remove();
    saveDraft();
    syncStops();
  };
  syncStops();
}

function syncStops() {
  $('#sh_add').hidden = $('#sh_stops').children.length >= MAX_STOPS;
}

function readStops() {
  return [...document.querySelectorAll('#sh_stops .stop-row')].map(r => ({
    kind: r.querySelector('[data-f=kind]').value,
    name: r.querySelector('[data-f=name]').value.trim(),
    note: r.querySelector('[data-f=note]').value.trim(),
  }));
}

function saveDraft() {
  store.set(DRAFT, {
    city: shareCity, title: $('#sh_name').value, stops: readStops(), stage: $('#sh_stage').value,
    cur: $('#sh_cur').value, budget: $('#sh_budget').value, tips: $('#sh_tips').value,
  });
}

function openShare() {
  const d = store.get(DRAFT) || {};
  shareCity = d.city || city || null;
  $('#sh_city').value = shareCity ? (shareCity.detail ? `${shareCity.label}, ${shareCity.detail}` : shareCity.label) : '';
  $('#sh_name').value = d.title || '';
  $('#sh_stage').value = d.stage || '';
  $('#sh_cur').value = d.cur || 'USD';
  $('#sh_budget').value = d.budget || '';
  $('#sh_tips').value = d.tips || '';
  $('#sh_stops').innerHTML = '';
  const stops = d.stops?.length ? d.stops : [{}, {}, {}];
  stops.slice(0, MAX_STOPS).forEach((s, i) => addStop({ ...s, kind: s.kind || ['drinks', 'activity', 'food'][i] }));
  $('#sh_err').textContent = '';
  $('#d_share').showModal();
}

async function onShare(e) {
  e.preventDefault();
  const err = $('#sh_err');
  const go = $('#sh_go');
  err.textContent = '';
  const title = $('#sh_name').value.trim();
  const stops = readStops().filter(s => s.name);
  if (!shareCity) { err.textContent = 'Pick the city from the list, so it lands on the map.'; return; }
  if (title.length < 4) { err.textContent = 'Give it a name - four letters at least.'; return; }
  if (stops.length < 2) { err.textContent = 'Two stops at least - that is what makes it an evening.'; return; }

  go.disabled = true;
  try {
    // Pin each place, so the planner can route to it later. One lookup a
    // second is OpenStreetMap's rule, so say how far along it is.
    for (let i = 0; i < stops.length; i++) {
      go.innerHTML = `<span class="spin"></span>Finding place ${i + 1} of ${stops.length}`;
      const hit = await places.lookup(stops[i].name, shareCity.lat, shareCity.lon, 'car').catch(() => null);
      stops[i].lat = hit ? hit.lat : null;
      stops[i].lon = hit ? hit.lon : null;
    }
    go.innerHTML = '<span class="spin"></span>Sharing';
    const budget = parseFloat($('#sh_budget').value);
    const cur = $('#sh_cur').value.trim().toUpperCase();
    await C.share({
      title, city: shareCity.label, region: shareCity.detail || '',
      lat: shareCity.lat, lon: shareCity.lon,
      stage: $('#sh_stage').value || null,
      budget: Number.isFinite(budget) ? budget : null,
      currency: Number.isFinite(budget) ? (/^[A-Z]{3,4}$/.test(cur) ? cur : 'USD') : null,
      stops, tips: $('#sh_tips').value.trim(),
    });
    store.set(DRAFT, null);
    $('#d_share').close();
    city = shareCity;
    store.set(CITY, city);
    toast('Shared. Thank you.');
    setSort('new');
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    go.disabled = false;
    go.textContent = 'Share it';
  }
}

/* --- small parts --------------------------------------------------------- */

/** A place search box: type, pick from the list, get coordinates. */
function placePicker(input, box, onPick) {
  let timer = null, items = [], at = -1;
  const close = () => { box.classList.remove('open'); box.innerHTML = ''; items = []; at = -1; };
  const choose = p => {
    input.value = p.detail ? `${p.label}, ${p.detail}` : p.label;
    close();
    onPick(p);
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    onPick(null);                          // typing invalidates a picked place
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(() => places.suggest(q).then(list => {
      items = list;
      at = -1;
      if (!list.length) return close();
      box.innerHTML = list.map((p, i) =>
        `<div role="option" data-i="${i}">${esc(p.label)}<small>${esc(p.detail || '')}</small></div>`).join('');
      box.classList.add('open');
      box.querySelectorAll('[data-i]').forEach(el => { el.onclick = () => choose(items[+el.dataset.i]); });
    }).catch(close), 250);
  });
  input.addEventListener('keydown', e => {
    if (!box.classList.contains('open')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      box.querySelectorAll('[data-i]').forEach((el, i) => el.setAttribute('aria-selected', String(i === at)));
    } else if (e.key === 'Enter' && at >= 0) {
      e.preventDefault();
      choose(items[at]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  const home = input.closest('.loc') || input.parentElement;
  document.addEventListener('click', e => { if (!home.contains(e.target)) close(); });
}

function hereAndNow() {
  const btn = $('#c_here');
  if (!navigator.geolocation) return toast('This browser will not share your location.');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const at = await places.reverse(lat, lon).catch(() => null);
    btn.disabled = false;
    city = { label: at?.label || 'Near you', detail: at?.detail || '', lat, lon };
    store.set(CITY, city);
    load();
  }, err => {
    btn.disabled = false;
    toast(err.code === 1 ? 'Location permission denied - type a city instead.'
                         : 'Could not get a location fix - type a city instead.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}

let toastTimer = null;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 3800);
}

const plural = (n, word) => (n === 1 ? word : `${word}s`);

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  if (s < 86400 * 365) return rtf.format(-Math.round(s / (86400 * 30)), 'month');
  return rtf.format(-Math.round(s / (86400 * 365)), 'year');
}
