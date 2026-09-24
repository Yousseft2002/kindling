/* Shared plumbing for the public APIs Kindling runs on.
 *
 * Everything here used to live in the Python server. It runs in the browser
 * now, which is what lets the whole app sit on GitHub Pages with no backend -
 * every service it depends on allows direct cross-origin calls.
 *
 * Two rules travelled with it:
 *
 *  - Nominatim asks for at most one request a second, per service rather than
 *    per endpoint. `nominatim()` is the single gate; do not add a second one.
 *    Ignoring that policy is how a free service stops being free.
 *  - Nothing here throws. A failed lookup should cost the plan a detail, not
 *    the whole evening, so every helper returns null and the caller carries on.
 */

const CACHE = new Map();

/** Time-expiring memo. Failures are never cached: a remembered outage lasts
 *  far longer than a real one. */
export function memo(key, ttlMs, make) {
  const hit = CACHE.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const value = make();
  // Store the promise so parallel callers share one request, but drop it
  // again if it resolves to nothing.
  Promise.resolve(value)
    .then(v => { if (!v || (Array.isArray(v) && !v.length)) CACHE.delete(key); })
    .catch(() => CACHE.delete(key));

  CACHE.set(key, { until: Date.now() + ttlMs, value });
  return value;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** GET JSON, or null. Never throws. */
export async function getJSON(url, params) {
  const q = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) q.searchParams.set(k, v);
  }
  try {
    const r = await fetch(q, { headers: { Accept: 'application/json' } });
    if (!r.ok) {
      console.warn('GET', q.pathname, '->', r.status);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn('GET', q.pathname, 'failed:', e.message);
    return null;
  }
}

/* --- Nominatim's rate limit ------------------------------------------
 * One request a second, shared across venue search, category search and
 * reverse geocoding. Calls queue rather than being dropped, because a plan
 * needs all of them and losing one silently is worse than waiting.
 */
let chain = Promise.resolve();
const GAP_MS = 1100;

export function nominatim(url, params) {
  const run = chain.then(async () => {
    const out = await getJSON(url, params);
    await new Promise(r => setTimeout(r, GAP_MS));
    return out;
  });
  // Keep the chain alive even if one call rejects.
  chain = run.catch(() => {});
  return run;
}

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dp = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2
          + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
