/* The finished evening, as a page.
 *
 * Top to bottom: the route as a full-bleed hero (the 60), the stops as a
 * timeline you tap into, then the controls that re-shape the night (the 40):
 * budget, start, length and what the kitchen has to cater for. Everything
 * below that is the fine print a plan owes you - warnings, locals, sources.
 */

import { endOf } from '../lib/plan.js';
import * as wx from '../lib/weather.js';
import { routeMap, visual } from './tiles.js';
import { DIET_LABEL } from './hero.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const mins = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const hhmm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;

export function planHtml(d, { community = false } = {}) {
  const p = d.plan, prefs = d.prefs, cur = prefs.currency;
  const money = n => n > 0 ? `${cur} ${Math.round(n)}` : 'Free';
  const when = prefs.date
    ? new Date(prefs.date + 'T12:00').toLocaleDateString(undefined,
        { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  const head = [prefs.location?.split(',')[0], when].filter(Boolean).map(esc).join(' &middot; ');

  const W = Math.min(innerWidth, 680), H = Math.round(Math.min(innerHeight * 0.6, 620));
  // The title covers the lower part of the hero; keep the pins above it.
  const map = routeMap(p.stops, W, H, { clearTop: 56, clearBottom: Math.round(H * 0.5) });
  const cover = map || visual(p.stops.find(s => s.photo || s.lat != null) || p.stops[0] || {}, W, H);

  const chips = [p.adventure, prefs.localOnly ? 'Local only' : '',
    `${money(p.totalCost)} for two`, wx.isKnown(d.weather) ? d.weather.summary : '']
    .filter(Boolean).map(c => `<span class="chip-s">${esc(c)}</span>`).join('');

  const rows = p.stops.map((s, i) => `
    <li class="tl-item" style="--i:${i}">
      <button class="row" type="button" data-i="${i}" aria-label="${esc(s.name)}, ${esc(s.start)}. Open details">
        <span class="row-node" aria-hidden="true">${i + 1}</span>
        <div class="row-vis">${visual(s, 96, 96, 16)}</div>
        <div class="row-txt">
          <p class="row-meta">${esc(s.start)}–${esc(endOf(s))} &middot; ${money(s.cost)}</p>
          <h3>${esc(s.name)}</h3>
          <p class="row-why">${esc(s.venueKind || s.kind)}${s.locals ? ' &middot; <span class="gold">Loved by locals</span>' : ''}</p>
        </div>
        <span class="chev" aria-hidden="true">&#8250;</span>
      </button>
    </li>
    ${s.travelNext ? `<li class="tl-leg" aria-hidden="false">${esc(s.travelNext)}</li>` : ''}`).join('');

  const notes = [['When', p.timing], ['Wear', p.wear], ['Getting around', p.transportNote],
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

    <h4 class="sec">The evening <small>Tap a stop to open it</small></h4>
    <ol class="timeline">${rows}</ol>

    ${tuneHtml(prefs)}
    ${warn}
    ${insights}
    <div class="card notes">${notes}</div>
    <p class="foot">Places and hours from <b>OpenStreetMap</b> contributors; photographs
      from <b>Wikipedia</b>${community ? '; local picks from the <b>Kindling community</b>' : ''}.
      Booking links may earn a commission. Everything here is an
      estimate &mdash; check before you go.${community ? ' <a href="privacy.html">Privacy</a>' : ''}</p>
    <button class="go" type="button" id="again" style="margin-top:20px">Plan another</button>`;
}

/* ---- tune the night -------------------------------------------------- */

const DIETS = ['vegetarian', 'vegan', 'gluten_free', 'halal'];

function tuneHtml(prefs) {
  const have = new Set(prefs.diet || []);
  const b = Math.round(prefs.budget);
  return `
    <section class="tune card" aria-labelledby="tune_t">
      <h4 id="tune_t" class="gold-h">Tune the night</h4>
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
