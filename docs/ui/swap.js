/* The swap deck: trade one stop for another without planning again.
 *
 * A continuous 3D card deck. The stop you have now is first; the planner's
 * runners-up for the same slot follow. As you swipe, the card leaving the
 * centre shrinks to 0.9x, dims and turns away, while the one arriving grows
 * into focus under a heavy shadow. Native scroll-snap does the physics - it
 * already has the momentum and the feel of the phone it runs on - and each
 * card's transform is derived from its distance to the centre, every frame.
 *
 * Layout per card is the 60/40 split: the place on top, the facts that
 * decide it underneath.
 */

import { springTo, riseIn, REDUCED } from './spring.js';
import { visual, revealTiles } from './tiles.js';
import { DIET_LABEL } from './hero.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/** { stop, index, alts, onPick(venue) } - onPick is not called for "keep". */
export function openSwap({ stop, index, alts, onPick }) {
  const deck = [{ ...asCard(stop), current: true }, ...alts.map(asCard)];
  const root = document.createElement('div');
  root.className = 'swap';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', `Swap stop ${index + 1}`);
  const cw = Math.min(320, Math.round(innerWidth * 0.66));
  const ch = Math.min(Math.round(innerHeight * 0.62), 520);
  root.style.setProperty('--cw', cw + 'px');
  root.style.setProperty('--ch', ch + 'px');
  root.innerHTML = `
    <div class="swap-scrim" data-close></div>
    <div class="swap-sheet">
      <div class="swap-head">
        <p class="eyebrow">Stop ${index + 1} &middot; ${deck.length - 1} other${deck.length === 2 ? '' : 's'} nearby</p>
        <h3>Swap ${esc(stop.name)}?</h3>
      </div>
      <div class="swap-stage">
        <div class="swap-track" tabindex="0" aria-label="Alternatives - swipe or use the arrow keys">
          ${deck.map((v, i) => `
            <article class="sc${v.current ? ' is-current' : ''}" data-i="${i}" aria-label="${esc(v.name)}"><div class="sc-in">
              <div class="sc-vis">${visual(v, cw, Math.round(ch * 0.6), 16)}
                ${v.current ? '<span class="sc-badge">Now</span>' : ''}</div>
              <div class="sc-body">
                <p class="sc-kind">${esc([v.kind, v.cuisine].filter(Boolean).join(' · '))}</p>
                <h4>${esc(v.name)}</h4>
                ${v.address ? `<p class="sc-line">${esc(v.address)}</p>` : ''}
                ${v.openingHours ? `<p class="sc-line">Open ${esc(v.openingHours)}</p>` : ''}
                ${(v.diet || []).length ? `<div class="tags">${v.diet.map(d =>
                  `<span class="tag">${DIET_LABEL[d] || d}</span>`).join('')}</div>` : ''}
              </div>
            </div></article>`).join('')}
        </div>
        <button class="swap-arrow prev" type="button" aria-label="Previous">&#8249;</button>
        <button class="swap-arrow next" type="button" aria-label="Next">&#8250;</button>
      </div>
      <div class="swap-dots" aria-hidden="true">${deck.map(() => '<i></i>').join('')}</div>
      <div class="swap-nav">
        <button class="back" type="button" data-close aria-label="Close">&times;</button>
        <button class="go" type="button" id="swap_go">Keep this one</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  revealTiles(root);

  const track = root.querySelector('.swap-track');
  const cards = [...root.querySelectorAll('.sc')];
  // Snap targets must not be transformed: Chrome snaps to the transformed
  // box, and a transform that depends on the scroll position then chases
  // itself. The look goes on the inner card; the outer one only snaps.
  const faces = cards.map(c => c.firstElementChild);
  const dots = [...root.querySelectorAll('.swap-dots i')];
  const goBtn = root.querySelector('#swap_go');
  let focus = 0, raf = 0;

  /* Each card's look is a function of how far it is from the centre, in
   * card widths: 0 is in focus, 1 is the neighbour. */
  function paint() {
    raf = 0;
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = 0, bestD = Infinity;
    cards.forEach((c, i) => {
      const d = (c.offsetLeft + c.offsetWidth / 2 - mid) / (c.offsetWidth + 12);
      const a = Math.min(Math.abs(d), 1.4);
      const k = Math.min(a, 1);
      const f = faces[i];
      f.style.transform = `translateZ(${-40 * k}px) rotateY(${Math.max(-26, Math.min(26, -d * 20))}deg) `
                        + `scale(${1 - 0.1 * k})`;
      f.style.opacity = String(1 - 0.5 * k);
      f.style.setProperty('--f', (1 - k).toFixed(3));
      c.style.zIndex = String(100 - Math.round(a * 10));
      if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = i; }
    });
    if (best !== focus) { focus = best; label(); }
  }
  function label() {
    const v = deck[focus];
    goBtn.textContent = v.current ? 'Keep this one' : `Go to ${v.name}`;
    goBtn.classList.toggle('hot', !v.current);
    dots.forEach((d, i) => d.classList.toggle('on', i === focus));
    cards.forEach((c, i) => c.setAttribute('aria-current', String(i === focus)));
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  track.addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  paint(); label();

  const to = i => {
    const c = cards[Math.max(0, Math.min(cards.length - 1, i))];
    track.scrollTo({ left: c.offsetLeft - (track.clientWidth - c.offsetWidth) / 2,
                     behavior: REDUCED ? 'auto' : 'smooth' });
  };
  root.querySelector('.prev').onclick = () => to(focus - 1);
  root.querySelector('.next').onclick = () => to(focus + 1);
  cards.forEach((c, i) => c.addEventListener('click', () => { if (i !== focus) to(i); }));
  root.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); to(focus + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); to(focus - 1); }
    else if (e.key === 'Escape') { e.stopPropagation(); shut(); }
  });
  root.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => shut()));
  goBtn.onclick = async () => {
    const v = deck[focus];
    if (v.current) return shut();
    // The chosen card comes forward before the deck goes.
    if (!REDUCED) {
      faces[focus].animate([{ scale: '1' }, { scale: '1.05' }, { scale: '1.03' }],
                           { duration: 260, easing: 'ease-out', fill: 'forwards' });
      await new Promise(r => setTimeout(r, 200));
    }
    // The stop changes underneath while the deck fades, not after it.
    onPick(v.venue);
    await shut();
  };

  // In: the sheet rises, then the cards deal in from the right.
  const sheet = root.querySelector('.swap-sheet');
  root.classList.add('on');
  if (!REDUCED) {
    springTo(sheet, { y: 60, opacity: 0 }, { y: 0, opacity: 1 }, { tension: 140, friction: 17 });
    riseIn(root.querySelectorAll('.swap-head > *'), { gap: 60, distance: 14 });
    faces.slice(0, 3).forEach((c, i) => c.animate(
      [{ translate: `${60 + i * 30}px 0`, filter: 'blur(4px)' }, { translate: '0 0', filter: 'blur(0)' }],
      { duration: 520, delay: 120 + i * 70, easing: 'cubic-bezier(.2,.9,.25,1.05)', fill: 'backwards' }));
  }
  setTimeout(() => track.focus({ preventScroll: true }), 50);

  async function shut() {
    if (!root.isConnected || root.classList.contains('closing')) return;
    removeEventListener('resize', schedule);
    root.classList.remove('on');
    root.classList.add('closing');
    if (!REDUCED) {
      sheet.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(90px)' }],
                    { duration: 280, easing: 'cubic-bezier(.4,0,.8,.4)', fill: 'forwards' });
      await new Promise(r => setTimeout(r, 290));
    }
    root.remove();
  }
}

/* A stop or a venue record, as a card. */
function asCard(v) {
  return {
    venue: v, name: v.name, kind: v.venueKind || v.kind || '', cuisine: v.cuisine || '',
    address: v.address || '', openingHours: v.openingHours || '', diet: v.diet || [],
    photo: v.photo || '', lat: v.lat, lon: v.lon, current: false,
  };
}
