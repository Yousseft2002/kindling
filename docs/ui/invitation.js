/* The "Unfolding Invitation": what you watch while the evening is built.
 *
 * A plan takes about ten seconds - Nominatim allows one request a second and
 * an evening needs several - and a spinner makes ten seconds feel like
 * thirty. So the wait is shown as the thing being made: the faint outline of
 * an invitation, and inside it the evening's parts rising into place one by
 * one as the planner actually reaches them. Nothing here is theatre: each
 * card appears when its phase starts and is ticked when the next one does,
 * and each venue name is the real one, the moment it is chosen.
 *
 * Motion: every card enters from below on a spring (mass 1, tension 120,
 * friction 14). On completion the flap lifts, the cards rise out, and the
 * whole thing dissolves into the plan.
 */

import { springTo, riseIn, REDUCED } from './spring.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const STEPS = [
  { k: 'place',   icon: '◎', title: 'The place',          wait: 'Finding it on the map' },
  { k: 'weather', icon: '☾', title: 'The sky that night', wait: 'Reading the forecast' },
  { k: 'venues',  icon: '✦', title: 'Where you will go',  wait: 'Choosing each stop' },
  { k: 'route',   icon: '↝', title: 'The route between',  wait: 'Walking it through' },
];

/* The planner reports phases by name; this is which card each one lights. */
const PHASE = {
  'Finding the place': 'place',
  'Checking the forecast': 'weather',
  'Looking for places near you': 'venues',
  'Finding a photograph': 'route',
};

/* Long enough for the invitation to be read, even when every answer is
 * already cached and the plan is ready in a quarter of a second. */
const AT_LEAST_MS = 1600;

export function openInvitation(where = '') {
  const root = document.createElement('div');
  root.className = 'invite';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.innerHTML = `
    <div class="inv-glow" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="inv-stage">
      <svg class="env" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y="0" width="100" height="100" rx="6" ry="4" pathLength="100"/>
      </svg>
      <svg class="env-flap-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="M2 2 L50 96 L98 2" pathLength="100"/>
      </svg>
      <div class="inv-head">
        <p class="eyebrow">An invitation${where ? ` &middot; ${esc(where.split(',')[0])}` : ''}</p>
        <h2 class="inv-title">Your evening is being written<span class="dots"><i>.</i><i>.</i><i>.</i></span></h2>
      </div>
      <ol class="inv-cards">
        ${STEPS.map(s => `
          <li class="inv-card" data-k="${s.k}" hidden>
            <span class="inv-ic" aria-hidden="true">${s.icon}</span>
            <div class="inv-txt"><b>${s.title}</b><small>${s.wait}</small>
              ${s.k === 'venues' ? '<div class="inv-found"></div>' : ''}</div>
            <span class="inv-tick" aria-hidden="true"></span>
          </li>`).join('')}
      </ol>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('inviting');

  const opened = performance.now();
  const card = k => root.querySelector(`.inv-card[data-k="${k}"]`);
  let current = null;

  // The outline draws itself, then the head rises.
  requestAnimationFrame(() => root.classList.add('on'));
  riseIn(root.querySelectorAll('.inv-head > *'), { gap: 80, distance: 18 });

  function light(k) {
    if (!k || k === current) return;
    const order = STEPS.map(s => s.k);
    // Every card before this one is finished, whether or not it was seen.
    for (const s of order.slice(0, order.indexOf(k))) {
      const c = card(s);
      if (c.hidden) { c.hidden = false; springTo(c, { y: 34, opacity: 0 }, { y: 0, opacity: 1 }); }
      c.classList.add('done');
      c.classList.remove('live');
    }
    const c = card(k);
    c.hidden = false;
    c.classList.add('live');
    springTo(c, { y: 34, opacity: 0, scale: 0.97 }, { y: 0, opacity: 1, scale: 1 });
    current = k;
  }

  return {
    /** Mirror of the planner's onPhase(label, info). */
    phase(label, info) {
      light(PHASE[label]);
      if (info?.found) {
        const box = root.querySelector('.inv-found');
        const chip = document.createElement('span');
        chip.className = 'inv-chip';
        chip.textContent = info.found;
        box.appendChild(chip);
        springTo(chip, { y: 16, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1 });
      }
    },
    /** Replace a card's waiting line with what was found. */
    note(k, text) {
      const s = card(k)?.querySelector('small');
      if (s && text) s.textContent = text;
    },
    /** Tick everything, open the flap, dissolve. */
    async done() {
      light('route');
      card('route').classList.add('done');
      card('route').classList.remove('live');
      const wait = AT_LEAST_MS - (performance.now() - opened);
      if (wait > 0 && !REDUCED) await new Promise(r => setTimeout(r, wait));
      root.classList.add('sealed');
      if (!REDUCED) {
        await Promise.all([...root.querySelectorAll('.inv-card')].map((c, i) =>
          springTo(c, { y: 0, opacity: 1 }, { y: -26, opacity: 0 }, { delay: i * 50, tension: 170, friction: 20 })));
      }
      await close();
    },
    /** Something went wrong: just go. The error is shown on the page. */
    fail: () => close(),
  };

  async function close() {
    root.classList.add('leaving');
    if (!REDUCED) await new Promise(r => setTimeout(r, 380));
    root.remove();
    document.body.classList.remove('inviting');
  }
}
