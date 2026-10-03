/* Itinerary-to-Hero: a stop opens into itself.
 *
 * Tapping a stop in the timeline never wipes to a new screen. The row's
 * thumbnail grows - uniformly, so the photograph is never stretched - into a
 * full-bleed header, while the rest of the timeline sinks back and the
 * detail rises underneath. Closing runs the same path in reverse, to
 * wherever that row now is.
 *
 * Layout is the 60/40 split: the top 60% of the screen is the place itself,
 * the bottom 40% the things you can do about it.
 */

import { springTo, riseIn, settled, REDUCED } from './spring.js';
import { visual, revealTiles, routeMap } from './tiles.js';
import { endOf, walkTime } from '../lib/plan.js';
import { ideaTime } from '../lib/ideas.js';
import { esc } from '../lib/fmt.js';

export const DIET_LABEL = { vegetarian: 'Vegetarian', vegan: 'Vegan', gluten_free: 'Gluten-free',
                            halal: 'Halal', kosher: 'Kosher' };

const EASE = 'cubic-bezier(.2,.85,.2,1)';
const MORPH_MS = 520;

let open = null;       // the one detail view that can exist

/** ctx: { index, stop, money(n) or null to leave prices out, canSwap, onSwap(index), rowFor(index) } */
export function openStop(ctx) {
  if (open) return;
  const row = ctx.rowFor(ctx.index);
  const thumb = row?.querySelector('.row-vis');
  if (!row || !thumb) return;

  const hv = document.createElement('div');
  hv.className = 'hv';
  hv.setAttribute('role', 'dialog');
  hv.setAttribute('aria-modal', 'true');
  hv.setAttribute('aria-label', ctx.flexible ? ctx.stop.idea || ctx.stop.kind : ctx.stop.name);
  hv.innerHTML = markup(ctx);
  document.body.appendChild(hv);
  document.documentElement.classList.add('locked');
  revealTiles(hv);
  wire(hv, ctx);

  const media = hv.querySelector('.hv-media');
  const T = thumb.getBoundingClientRect();
  const from = startFrame(T, media.getBoundingClientRect());

  row.classList.add('lifted');
  row.closest('.timeline')?.classList.add('focusing');
  open = { hv, ctx, onPop: null };

  // Back button closes the stop, not the page.
  history.pushState({ kindlingStop: ctx.index }, '');
  open.onPop = () => close(true);
  addEventListener('popstate', open.onPop, { once: true });

  if (REDUCED) {
    hv.classList.add('in');
    hv.querySelector('.hv-close').focus({ preventScroll: true });
    return;
  }
  media.animate([from, { transform: 'none', clipPath: 'inset(0px round 0px)' }],
                { duration: MORPH_MS, easing: EASE });
  hv.animate([{ backgroundColor: 'rgba(13,12,16,0)' }, { backgroundColor: 'rgba(13,12,16,1)' }],
             { duration: MORPH_MS * 0.8, easing: 'ease-out' });
  hv.classList.add('in');
  const parts = hv.querySelectorAll('.hv-over > *, .hv-panel > *');
  parts.forEach(p => { p.style.opacity = 0; });
  riseIn(parts, { gap: 45, distance: 22, delay: MORPH_MS * 0.45 });
  setTimeout(() => hv.querySelector('.hv-close')?.focus({ preventScroll: true }), MORPH_MS);
}

/** Show a different stop in the open view - after a swap. The picture
 *  cross-fades; the panel re-assembles. */
export function refreshStop(ctx) {
  if (!open) return;
  open.ctx = ctx;
  const hv = open.hv;
  const scroller = hv.scrollTop;
  hv.innerHTML = markup(ctx);
  hv.scrollTop = scroller;
  hv.setAttribute('aria-label', ctx.flexible ? ctx.stop.idea || ctx.stop.kind : ctx.stop.name);
  revealTiles(hv);
  wire(hv, ctx);
  if (!REDUCED) {
    hv.querySelector('.hv-media').animate([{ opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0)' }],
                                          { duration: 420, easing: 'ease-out' });
    riseIn(hv.querySelectorAll('.hv-over > *, .hv-panel > *'), { gap: 35, distance: 16 });
  }
}

export const isOpen = () => !!open;

/** Close, morphing back into the row. `fromPop` when the browser already
 *  went back. */
export async function close(fromPop = false) {
  if (!open) return;
  const { hv, ctx, onPop } = open;
  open = null;
  if (!fromPop) {
    removeEventListener('popstate', onPop);
    if (history.state?.kindlingStop != null) history.back();
  }
  const row = ctx.rowFor(ctx.index);
  const thumb = row?.querySelector('.row-vis');
  const timeline = row?.closest('.timeline');
  timeline?.classList.remove('focusing');

  if (!REDUCED && thumb) {
    const media = hv.querySelector('.hv-media');
    // The view may have been scrolled; morph from where the header is now.
    const M = media.getBoundingClientRect();
    const to = startFrame(thumb.getBoundingClientRect(), M);
    hv.querySelectorAll('.hv-over, .hv-panel').forEach(p =>
      p.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(16px)' }],
                { duration: 200, easing: 'ease-in', fill: 'forwards' }));
    hv.animate([{ backgroundColor: 'rgba(13,12,16,1)' }, { backgroundColor: 'rgba(13,12,16,0)' }],
               { duration: MORPH_MS * 0.8, easing: 'ease-in', fill: 'forwards' });
    // Through settled(), because a backgrounded page freezes the timeline and
    // this await is what removes the overlay: hanging here leaves the hero
    // view covering the itinerary for good.
    await settled(media.animate([{ transform: 'none', clipPath: 'inset(0px round 0px)' }, to],
                                { duration: MORPH_MS * 0.85, easing: EASE, fill: 'forwards' }),
                  MORPH_MS);
  }
  hv.remove();
  document.documentElement.classList.remove('locked');
  if (row) {
    row.classList.remove('lifted');
    if (!REDUCED) springTo(row, { scale: 0.97 }, { scale: 1 }, { tension: 220, friction: 18 });
    row.focus({ preventScroll: true });
  }
}

/** The transform and clip that make the full header look exactly like the
 *  thumbnail: scale uniformly until it covers the thumbnail, centre it
 *  there, and crop the rest away. */
function startFrame(T, M) {
  const s = Math.max(T.width / M.width, T.height / M.height);
  const w = T.width / s, h = T.height / s;              // the crop, in header pixels
  const ix = (M.width - w) / 2, iy = (M.height - h) / 2;
  const tx = (T.left + T.width / 2) - (M.left + M.width / 2);
  const ty = (T.top + T.height / 2) - (M.top + M.height / 2);
  return {
    transform: `translate(${tx}px, ${ty}px) scale(${s})`,
    clipPath: `inset(${iy}px ${ix}px ${iy}px ${ix}px round ${16 / s}px)`,
  };
}

export function venueOptionsHtml(options, index, money, canPick = false) {
  if (!options.length) return '<p class="detail">No named place was verified here. Keep the idea, but check locally before setting out.</p>';
  return `<ul class="venue-options">${options.map((v, n) => `<li>
    <b>${esc(v.name)}</b>
    ${v.address ? `<p class="detail">${esc(v.address)}</p>` : ''}
    ${v.openingHours ? `<p class="detail">Published hours: ${esc(v.openingHours)} · check before going</p>` : '<p class="detail">Hours unconfirmed — check before going</p>'}
    ${money && v.cost != null ? `<p class="detail">Estimate for two: ${esc(money(v.cost))}</p>` : ''}
    <div class="hv-actions">
      ${v.website ? `<a class="btn ghost" href="${esc(v.website)}" target="_blank" rel="noopener">Check the place</a>` : ''}
      ${canPick ? `<button class="btn ghost" type="button" data-venue-stop="${index}" data-venue-option="${n}">Choose this place</button>` : ''}
    </div>
  </li>`).join('')}</ul>`;
}

function markup({ stop: s, index, money, canSwap, flexible, softTiming, options = [], canPick }) {
  const W = Math.min(innerWidth, 1600), H = Math.round(innerHeight * 0.6);
  if (flexible) {
    const time = ideaTime(s, index);
    return `<div class="hv-media">
      ${routeMap(options, W, H, { options: true, clearTop: 56, clearBottom: 150 }) || visual({ kind: s.kind }, W, H)}
      <div class="hv-shade" aria-hidden="true"></div>
    </div>
    <button class="hv-close" type="button" aria-label="Back to the evening">&#8592;</button>
    <div class="hv-over">
      <p class="eyebrow">${esc(time)}${s.role === 'optional' ? ' · Optional' : ''}</p>
      <h2>${esc(s.idea || s.kind)}</h2>
      <p class="hv-kind">Keep the idea. Choose the place when you feel like it.</p>
    </div>
    <div class="hv-panel">
      <p class="insight-line"><span aria-hidden="true">✦</span> ${esc(s.why)}</p>
      ${s.tip ? `<p class="insight-line soft">${esc(s.tip)}</p>` : ''}
      ${s.sessionStart ? `<p class="detail">Listed session start: ${esc(s.sessionStart)}. Confirm the date and availability before booking.</p>`
        : s.timeSensitive ? '<p class="detail">Suggested arrival, not an event start. Check the venue hours before you go.</p>' : ''}
      ${s.closingTime ? `<p class="detail">The researched option closes at ${esc(s.closingTime)}. Check the hours below when choosing a place.</p>` : ''}
      ${s.daylightUntil ? `<p class="detail">Daylight ends around ${esc(s.daylightUntil)}. Keep the outdoor part before then.</p>` : ''}
      ${!s.indoor && s.fallback ? `<p class="detail">If it rains: ${esc(s.fallback)}</p>` : ''}
      <h4 class="gold-h">Possible places, not commitments</h4>
      <p class="detail">Nothing to choose before you seal this evening. Choosing a place only fixes this part.</p>
      ${venueOptionsHtml(options, index, money, canPick)}
    </div>`;
  }
  const facts = [s.cuisine, walkTime(s)].filter(Boolean).join(' · ');
  const diet = (s.diet || []).map(d => `<span class="tag">${esc(DIET_LABEL[d] || d)}</span>`).join('');
  const rows = [
    s.address && ['Address', esc(s.address)],
    s.openingHours && ['Hours', esc(s.openingHours)],
    s.website && ['Site', `<a href="${esc(s.website)}" target="_blank" rel="noopener">${
      esc(s.website.replace(/^https?:\/\//, '').slice(0, 40))}</a>`],
    s.booking && ['Booking', esc(s.booking)],
    (!s.indoor && s.fallback) && ['If it rains', esc(s.fallback)],
  ].filter(Boolean);
  const local = s.locals ? `<div class="local">Recommended by ${
      s.locals.posts === 1 ? 'a local' : `${s.locals.posts} locals`}${
      s.locals.loves ? ` &middot; ${s.locals.loves} ${s.locals.loves === 1 ? 'love' : 'loves'}` : ''}${
      (s.locals.notes || []).map(n => `<q>${esc(n.note)}</q><small>${esc(n.author)}${
        n.guide ? ', local guide' : ''}</small>`).join('')}</div>` : '';

  return `
    <div class="hv-media">
      ${visual(s, W, H, 17)}
      <div class="hv-shade" aria-hidden="true"></div>
      ${s.photoCredit ? `<a class="src" href="${esc(s.photoCredit)}" target="_blank" rel="noopener">Wikipedia</a>` : ''}
    </div>
    <button class="hv-close" type="button" aria-label="Back to the evening">&#8592;</button>
    <div class="hv-over">
      <p class="eyebrow">${s.role === 'optional' ? 'Optional extension' : `Stop ${index + 1}`} &middot; ${esc(softTiming ? ideaTime(s, index) : `${s.start}–${endOf(s)}`)}</p>
      <h2>${esc(s.name)}</h2>
      <p class="hv-kind">${[s.venueKind, facts].filter(Boolean).map(esc).join(' &middot; ')}</p>
    </div>
    <div class="hv-panel">
      <div class="hv-stats">
        <div><small>${s.role === 'optional' ? 'If you go' : softTiming ? 'When' : 'Arrive'}</small><b>${esc(softTiming ? ideaTime(s, index) : s.start)}</b></div>
        <div><small>Stay</small><b>${softTiming ? 'About ' : ''}${Math.round(s.minutes)} min</b></div>
        ${money ? `<div><small>Budget</small><b>${esc(money(s.cost))}</b></div>` : ''}
      </div>
      ${s.role === 'optional' ? '<p class="detail">Only if you feel like it. Choosing a place does not commit you to this extension.</p>' : ''}
      <p class="insight-line"><span aria-hidden="true">✦</span> ${esc(s.why)}</p>
      ${s.tip ? `<p class="insight-line soft">${esc(s.tip)}</p>` : ''}
      ${diet ? `<div class="tags">${diet}</div>` : ''}
      ${local}
      ${s.blurb ? `<p class="blurb">${esc(s.blurb)}</p>` : ''}
      ${rows.length ? `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
      <div class="hv-actions">
        ${s.bookUrl ? `<a class="cta" href="${esc(s.bookUrl)}" target="_blank" rel="noopener">${esc(s.bookLabel || 'Book')}</a>` : ''}
        ${s.mapUrl ? `<a class="btn ghost" href="${esc(s.mapUrl)}" target="_blank" rel="noopener">Directions</a>` : ''}
        ${canSwap ? `<button class="btn ghost swap-go" type="button">Swap this stop <span class="n">${s.alts.length}</span></button>` : ''}
      </div>
    </div>`;
}

function wire(hv, ctx) {
  hv.querySelector('.hv-close').onclick = () => close();
  hv.querySelector('.swap-go')?.addEventListener('click', () => ctx.onSwap(ctx.index));
  hv.querySelectorAll('[data-venue-option]').forEach(b => b.addEventListener('click', () =>
    ctx.onPick?.(ctx.index, ctx.options[+b.dataset.venueOption])));
  hv.onkeydown = e => { if (e.key === 'Escape' && !document.querySelector('.swap')) close(); };
}
