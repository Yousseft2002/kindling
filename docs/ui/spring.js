/* Spring physics for the Web Animations API. No library.
 *
 * A damped spring is a few lines of integration, and baking it into
 * keyframes means the browser runs it on the compositor like any other
 * animation - nothing ticks on the main thread while a plan is being built,
 * which is exactly when the main thread is busiest.
 *
 * Defaults are the "Unfolding Invitation" feel: mass 1, tension 120,
 * friction 14 - a quick rise with one soft overshoot.
 */

export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const cache = new Map();

/** Progress samples from 0 to 1 (overshooting past 1) and how long it takes
 *  to settle, in ms. */
export function spring({ mass = 1, tension = 120, friction = 14, velocity = 0 } = {}) {
  const key = `${mass}:${tension}:${friction}:${velocity}`;
  if (cache.has(key)) return cache.get(key);
  const dt = 1 / 120;
  let x = 0, v = velocity, t = 0;
  const samples = [0];
  // Integrate until it has been still for a while, capped at 3 s.
  let still = 0;
  while (t < 3 && still < 12) {
    const force = -tension * (x - 1) - friction * v;
    v += (force / mass) * dt;
    x += v * dt;
    t += dt;
    samples.push(x);
    still = (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) ? still + 1 : 0;
  }
  samples[samples.length - 1] = 1;
  const out = { samples, duration: Math.round(t * 1000) };
  cache.set(key, out);
  return out;
}

const lerp = (a, b, p) => a + (b - a) * p;

/** Animate an element between two states with a spring. A state is any of
 *  { x, y, scale, opacity, rotateX } - transforms are composed in that order.
 *  Opacity is clamped so the overshoot never flashes. Resolves when done. */
export function springTo(el, from, to, opts = {}) {
  if (!el) return Promise.resolve();
  const frame = s => {
    const k = {};
    const tf = [];
    if ('x' in s || 'y' in s) tf.push(`translate3d(${s.x || 0}px,${s.y || 0}px,0)`);
    if ('rotateX' in s) tf.push(`rotateX(${s.rotateX}deg)`);
    if ('scale' in s) tf.push(`scale(${s.scale})`);
    if (tf.length) k.transform = tf.join(' ');
    if ('opacity' in s) k.opacity = Math.max(0, Math.min(1, s.opacity));
    return k;
  };
  if (REDUCED) {
    Object.assign(el.style, frame(to));
    return Promise.resolve();
  }
  const { samples, duration } = spring(opts);
  // Every fourth sample is plenty; the browser interpolates between them.
  const frames = samples.filter((_, i) => i % 4 === 0 || i === samples.length - 1).map(p => {
    const s = {};
    for (const k of Object.keys(to)) {
      const a = from[k] ?? (k === 'scale' || k === 'opacity' ? 1 : 0);
      s[k] = lerp(a, to[k], k === 'opacity' ? Math.min(p, 1) : p);
    }
    return frame(s);
  });
  const anim = el.animate(frames, {
    duration, delay: opts.delay || 0, easing: 'linear', fill: 'both',
  });
  return anim.finished.then(() => {
    // Commit the end state so a later style change starts from it.
    Object.assign(el.style, frame(to));
    anim.cancel();
  }).catch(() => {});
}

/** Stagger a list of elements up from below, one after another. */
export function riseIn(els, { gap = 90, distance = 28, ...opts } = {}) {
  return Promise.all([...els].map((el, i) =>
    springTo(el, { y: distance, opacity: 0, scale: 0.98 }, { y: 0, opacity: 1, scale: 1 },
             { ...opts, delay: (opts.delay || 0) + i * gap })));
}
