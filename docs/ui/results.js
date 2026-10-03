/* The finished evening, as a page.
 *
 * Top to bottom: the route as a full-bleed hero (the 60), the stops as a
 * timeline you tap into, then the controls that re-shape the night (the 40):
 * budget, start, length and what the kitchen has to cater for. Everything
 * below that is the fine print a plan owes you - warnings, locals, sources.
 */

import { endOf, venueOptions } from '../lib/plan.js';
import { ideaTime } from '../lib/ideas.js';
import * as wx from '../lib/weather.js';
import { routeMap, visual } from './tiles.js';
import { DIET_LABEL, venueOptionsHtml } from './hero.js';
import { routeUrl, areaUrl } from '../lib/outing.js';
import { esc } from '../lib/fmt.js';

const mins = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const hhmm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;

export function planHtml(d, { community = false } = {}) {
  const shared = !!d.shared;   // opened from someone's sealed envelope
  community = community && !shared;
  const p = d.plan, prefs = d.prefs, cur = prefs.currency;
  const flexible = p.planMode === 'open';
  const money = n => n > 0 ? `${cur} ${Math.round(n)}` : 'Free';
  const rough = n => n > 0 ? `${cur} ${Math.floor(n * 0.8)}–${Math.ceil(n * 1.2)}` : 'No planned spend';
  const when = prefs.date
    ? new Date(prefs.date + 'T12:00').toLocaleDateString(undefined,
        { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  const head = [p.area || prefs.location?.split(',')[0], when].filter(Boolean).map(esc).join(' &middot; ');

  const W = Math.min(innerWidth, 680), H = Math.round(Math.min(innerHeight * 0.6, 620));
  // The title covers the lower part of the hero; keep the pins above it.
  const options = flexible ? p.stops.flatMap((s, i) => venueOptions(p, i, prefs)) : p.stops;
  const map = routeMap(options, W, H, { clearTop: 56, clearBottom: Math.round(H * 0.5), options: flexible });
  const cover = map || visual(flexible ? { kind: p.stops[0]?.kind }
    : p.stops.find(s => s.photo || s.lat != null) || p.stops[0] || {}, W, H);
  const coreCost = p.stops.filter(s => s.role !== 'optional').reduce((n, s) => n + (s.cost || 0), 0);

  const chips = [p.adventure, prefs.localOnly ? 'Local only' : '',
    shared ? '' : flexible
      ? coreCost > 0 ? `Core ideas: roughly ${rough(coreCost)} for two` : 'No planned spend'
      : `${money(p.totalCost)} for two`, wx.isKnown(d.weather) ? d.weather.summary : '']
    .filter(Boolean).map(c => `<span class="chip-s">${esc(c)}</span>`).join('');

  const rows = p.stops.map((s, i) => {
    const openIdea = flexible && !s.specific;
    const time = flexible ? ideaTime(s, i) : `${s.start}–${endOf(s)}`;
    const label = openIdea ? s.idea || s.kind : s.name;
    return `
    <li class="tl-item" style="--i:${i}">
      <button class="row" type="button" data-i="${i}" aria-label="${esc(label)}, ${esc(time)}. Open ${openIdea ? 'idea and possible places' : 'details'}">
        <span class="row-node" aria-hidden="true">${s.role === 'optional' ? '+' : i + 1}</span>
        <div class="row-vis">${visual(openIdea ? { kind: s.kind } : s, 96, 96, 16)}</div>
        <div class="row-txt">
          <p class="row-meta">${esc(time)}${shared ? '' : ` &middot; ${esc(openIdea ? rough(s.cost) : money(s.cost))}`}</p>
          <h3>${esc(label)}</h3>
          <p class="row-why">${s.role === 'optional' ? 'Optional · only if you feel like it' : openIdea ? 'Choose the place on the night' : esc(s.venueKind || s.kind)}${!openIdea && s.locals ? ' &middot; <span class="gold">Loved by locals</span>' : ''}</p>
        </div>
        <span class="chev" aria-hidden="true">&#8250;</span>
      </button>
    </li>
    ${!flexible && s.travelNext ? `<li class="tl-leg" aria-hidden="false">${esc(s.travelNext)}</li>` : ''}`;
  }).join('');

  const places = flexible ? `<details class="card possible-places">
    <summary>Possible places — not commitments</summary>
    <p class="detail">Real options around ${esc(p.area || prefs.location || 'your area')}. Prices are rough estimates, not quotes. Check hours and availability; keep the choice open or pick just one part.</p>
    ${p.stops.map((s, i) => `<h4>${esc(s.idea || s.kind)}</h4>${venueOptionsHtml(venueOptions(p, i, prefs), i, shared ? null : money, !shared)}`).join('')}
  </details>` : '';

  const notes = [['When', flexible ? 'A loose rhythm, not an appointment. Skip the optional extension whenever you like.' : p.timing], ['Wear', p.wear], ['Getting around', p.transportNote],
                 ['Weather', p.weatherCall], ['If it breaks', p.backup]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="pnote"><b>${k}</b><span>${esc(v)}</span></div>`).join('');

  const warn = p.warnings?.length
    ? `<div class="card warn"><h4>Check before you commit</h4><ul>${
        p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';

  const where = esc((prefs.location || '').split(',')[0]);
  const insights = p.insights?.length
    ? `<div class="card insights"><h4>Real People's Insights</h4>${p.insights.map(i => `
        <div class="insight"><b>${esc(i.title)}</b>
          <div class="detail">by ${esc(i.author)}${i.guide ? ' <span class="badge">Local guide</span>' : ''}
            &middot; &#9829; ${i.loves}</div>
          <div class="detail">${esc(i.stops.join(' → '))}</div></div>`).join('')}
        ${community ? '<button class="btn ghost" type="button" id="locals_more" style="margin-top:14px">More from locals</button>' : ''}
      </div>`
    : community
      ? `<div class="card insights"><h4>Real People's Insights</h4>
          <p class="detail" style="margin-top:0">Nobody has shared an evening around ${where} yet. Been somewhere good? The planner will start sending people there.</p>
          <button class="btn ghost" type="button" id="locals_share" style="margin-top:12px">Share an evening</button></div>`
      : '';

  return `
    <section class="plan-hero" style="--h:${H}px">
      <div class="plan-cover">${cover}</div>
      <div class="plan-shade" aria-hidden="true"></div>
      <div class="plan-over">
        <p class="eyebrow">${head}</p>
        <h2>${esc(p.title)}</h2>
        <p class="pitch">${esc(p.pitch)}</p>
        <div class="chips-s">${chips}</div>
      </div>
    </section>

    ${shared && d.note ? `<div class="card note-in"><p class="ev-hi">A line from them</p><p class="pitch">${esc(d.note)}</p></div>` : ''}
    <h4 class="sec">${flexible ? 'The move' : 'The evening'} <small>${flexible ? 'Room to improvise.' : 'Tap a stop to open it'}</small></h4>
    <ol class="timeline">${rows}</ol>
    ${places}

    ${takeHtml(p, prefs)}
    ${shared ? '' : sendHtml()}
    ${shared ? '' : tuneHtml(prefs, p)}
    ${warn}
    ${insights}
    <div class="card notes">${notes}</div>
    <p class="foot">Places and hours from <b>OpenStreetMap</b> contributors; photographs
      from <b>Wikipedia</b>${community ? '; local picks from the <b>Kindling community</b>' : ''}.
      Booking links may earn a commission. Everything here is an
      estimate &mdash; check before you go.${community ? ' <a href="privacy.html">Privacy</a>' : ''}</p>
    <button class="go" type="button" id="again" style="margin-top:20px">${shared ? 'Plan one back' : 'Plan another'}</button>`;
}

/* ---- take it with you ------------------------------------------------ */

/* The plan has to survive leaving the app, or the whole "settle it
 * beforehand and put the phone away" idea collapses into another tab you
 * forget to reopen. Three ways out: the calendar that already nags you, a
 * message to the person you are going with, and a route the maps app can
 * follow. A shared evening gets these too - it is their night as well. */
function takeHtml(p, prefs) {
  const open = p.planMode === 'open';
  const route = open ? areaUrl(p, prefs) : routeUrl(p.stops, prefs.transport);
  return `
    <section class="take card" aria-labelledby="take_t">
      <h4 id="take_t" class="gold-h">Take it with you</h4>
      <p class="detail">Out of the app, so the phone can stay in a pocket.</p>
      <div class="take-row">
        <button class="btn ghost" type="button" id="to_cal">Add to calendar</button>
        <button class="btn ghost" type="button" id="to_txt">Copy as text</button>
        ${route ? `<a class="btn ghost" id="to_map" href="${esc(route)}" target="_blank" rel="noopener">${open ? 'Explore the area' : 'Open the route'}</a>` : ''}
      </div>
    </section>`;
}

/* ---- send it, sealed ------------------------------------------------- */

function sendHtml() {
  return `
    <section class="send card" aria-labelledby="send_t">
      <h4 id="send_t" class="gold-h">Send it, sealed</h4>
      <p class="detail">Wrap this evening in an envelope for your partner. One link; they break the seal to see it.</p>
      <button class="cta wide" type="button" id="seal">Seal &amp; send</button>
    </section>`;
}

/* ---- tune the night -------------------------------------------------- */

const DIETS = ['vegetarian', 'vegan', 'gluten_free', 'halal'];

function tuneHtml(prefs, plan) {
  const have = new Set(prefs.diet || []);
  const b = Math.round(prefs.budget);
  return `
    <section class="tune card" aria-labelledby="tune_t">
      <h4 id="tune_t" class="gold-h">Tune the night</h4>
      <p class="detail">${plan.planMode === 'open' ? 'The idea is settled. The places can wait.' : 'Prefer a little more room to improvise?'}</p>
      <button class="btn ghost wide" type="button" data-plan-mode="${plan.planMode === 'open' ? 'specific' : 'open'}">${plan.planMode === 'open' ? 'Pick the places for us' : 'Make it more spontaneous'}</button>
      <div class="tune-row">
        <label for="t_budget">Budget for two</label>
        <output id="t_budget_out">${esc(prefs.currency)} ${b}</output>
      </div>
      <input id="t_budget" type="range" min="20" max="600" step="10" value="${Math.min(600, Math.max(20, b))}" aria-label="Budget for two">
      <div class="tune-grid">
        <div>
          <span class="lbl" id="t_start_l">Start</span>
          <div class="stepper" role="group" aria-labelledby="t_start_l">
            <button type="button" data-step="-30" aria-label="30 minutes earlier">&minus;</button>
            <output id="t_start">${esc(prefs.startTime)}</output>
            <button type="button" data-step="30" aria-label="30 minutes later">+</button>
          </div>
        </div>
        <div>
          <span class="lbl"><label for="t_hours">Length</label> <output id="t_hours_out">${prefs.hours} h</output></span>
          <input id="t_hours" type="range" min="2" max="8" step="0.5" value="${prefs.hours}">
        </div>
      </div>
      <span class="lbl" id="t_diet_l">The kitchen has to cater for</span>
      <div class="tags pick" role="group" aria-labelledby="t_diet_l">
        ${DIETS.map(k => `<button type="button" class="tag" data-diet="${k}" aria-pressed="${have.has(k)}">${DIET_LABEL[k]}</button>`).join('')}
      </div>
      <button class="cta wide" type="button" id="t_go" disabled>Re-plan with these</button>
    </section>`;
}

/** Wire the tune panel. `onReplan(changes)` receives only what differs. */
export function wireTune(root, prefs, onReplan) {
  const $ = s => root.querySelector(s);
  if (!$('#t_go')) return;
  const state = { budget: prefs.budget, startTime: prefs.startTime, hours: prefs.hours,
                  diet: [...(prefs.diet || [])] };
  const dirty = () => state.budget !== prefs.budget || state.startTime !== prefs.startTime
    || state.hours !== prefs.hours
    || [...state.diet].sort().join() !== [...(prefs.diet || [])].sort().join();
  const sync = () => { $('#t_go').disabled = !dirty(); };

  $('#t_budget').addEventListener('input', e => {
    state.budget = +e.target.value;
    $('#t_budget_out').textContent = `${prefs.currency} ${state.budget}`;
    sync();
  });
  $('#t_hours').addEventListener('input', e => {
    state.hours = +e.target.value;
    $('#t_hours_out').textContent = `${state.hours} h`;
    sync();
  });
  root.querySelectorAll('.stepper button').forEach(b => b.addEventListener('click', () => {
    const m = (mins(state.startTime) ?? 17 * 60) + +b.dataset.step;
    state.startTime = hhmm(Math.max(10 * 60, Math.min(23 * 60, m)));
    $('#t_start').textContent = state.startTime;
    sync();
  }));
  root.querySelectorAll('[data-diet]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.diet, on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    state.diet = on ? [...state.diet, k] : state.diet.filter(x => x !== k);
    sync();
  }));
  $('#t_go').addEventListener('click', () => onReplan({ ...state }));
}
