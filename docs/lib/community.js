/* The community: evenings people have actually been on, shared by the people
 * who went, and what the planner learns from them.
 *
 * Supabase, over plain fetch. There is no client library on purpose: the app
 * has no build step and no third-party script, and the three things needed -
 * sign in by email, read and write rows, refresh a session - are a handful of
 * documented endpoints. Everything that keeps the data honest lives in
 * supabase/schema.sql as row-level security, because anything enforced here
 * can be skipped by anyone with the page's own key.
 *
 * Nothing here is needed to plan an evening. With no project configured the
 * tab never appears, and with no signal the planner simply plans without the
 * locals' picks.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

export const enabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const BASE = String(SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = SUPABASE_ANON_KEY;

const SESSION = 'kindling.session';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

/* The guide rule, mirrored from the guide_scores view so the page can explain
 * it. The database is what actually decides. */
export const GUIDE_POSTS = 3;
export const GUIDE_LOVES = 10;

/* --- session ------------------------------------------------------------ */

let session = store.get(SESSION);
const listeners = new Set();
let mine;                                   // this person's profile, once loaded

export const user = () => session?.user || null;
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function setSession(s) {
  session = s;
  mine = undefined;
  store.set(SESSION, s);
  listeners.forEach(fn => { try { fn(s); } catch {} });
}

function adopt(s) {
  setSession({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: Number(s.expires_at) || Math.floor(Date.now() / 1000) + (Number(s.expires_in) || 3600),
    user: { id: s.user.id, email: s.user.email },
  });
}

/* Access tokens last an hour. Refresh a minute early, and only sign someone out
 * when the server says the refresh token is dead - not because they walked
 * into a tunnel. */
let refreshing = null;
async function accessToken() {
  if (!session) return null;
  if ((session.expires_at || 0) * 1000 - 60_000 > Date.now()) return session.access_token;
  refreshing ||= fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  }).then(async r => {
    if (r.ok) adopt(await r.json());
    else if (r.status >= 400 && r.status < 500) setSession(null);
  }).catch(() => {}).finally(() => { refreshing = null; });
  await refreshing;
  return session?.access_token || null;
}

/* --- requests ----------------------------------------------------------- */

/** Turn what Supabase says into something a person can read. */
function friendly(data, status) {
  const code = String(data?.code ?? '');                      // Postgres error codes
  const auth = String(data?.error_code ?? '');                // sign-in error codes
  const said = data?.message || data?.msg || data?.error_description || data?.error || '';
  // A wrong or stale sign-in code comes back as a 403, so this has to be
  // asked before the generic 401/403 below, or it reads as "sign in again".
  if (auth === 'otp_expired' || /token has expired|invalid.*(otp|token|code)/i.test(said)) {
    return 'That code or link has expired or is wrong. Ask for a new one.';
  }
  if (status === 429 || auth === 'over_email_send_rate_limit' || /rate limit/i.test(said)) {
    return 'Too many tries. Wait a minute and try again.';
  }
  if (code === '23505' && /profiles/.test(said + (data?.details || ''))) return 'That name is taken. Try another.';
  if (code === '23505') return 'Already done.';
  if (code === 'P0001') return said;                          // our own words, from schema.sql
  if (code === '23514') return 'Something in that post is too long or missing.';
  if (code === '42501' || status === 401 || status === 403) return 'Sign in again to do that.';
  return said || `Something went wrong (${status}).`;
}

async function call(path, { method = 'GET', body, headers = {}, signedIn = true } = {}) {
  if (!enabled) throw new Error('The community is not set up yet.');
  const token = signedIn ? await accessToken() : null;
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${token || KEY}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(navigator.onLine === false ? 'You are offline.' : 'Could not reach the community.');
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const err = new Error(friendly(data, r.status));
    err.status = r.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

/* --- signing in --------------------------------------------------------- */

/** Email a sign-in link, which also carries a code for anyone who would
 *  rather type it than leave the app they are in. */
export async function sendLink(email) {
  const back = location.origin + location.pathname;
  await call(`/auth/v1/otp?redirect_to=${encodeURIComponent(back)}`, {
    method: 'POST', signedIn: false, body: { email: email.trim(), create_user: true },
  });
}

export async function verifyCode(email, code) {
  adopt(await call('/auth/v1/verify', {
    method: 'POST', signedIn: false,
    body: { type: 'email', email: email.trim(), token: code.replace(/\s+/g, '') },
  }));
}

/** The emailed link comes back here with the session in the URL fragment.
 *  Take it, and wipe it from the address bar so it is not shared by accident. */
export async function takeRedirect() {
  if (!enabled || !location.hash) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('access_token') && !h.has('error') && !h.has('error_description')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (!h.has('access_token')) {
    return { error: friendly({ error_code: h.get('error_code'), error_description: h.get('error_description') }, 400) };
  }
  try {
    const u = await fetch(`${BASE}/auth/v1/user`, {
      headers: { apikey: KEY, Authorization: `Bearer ${h.get('access_token')}` },
    }).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    adopt({
      access_token: h.get('access_token'), refresh_token: h.get('refresh_token'),
      expires_at: h.get('expires_at'), expires_in: h.get('expires_in'), user: u,
    });
    return { ok: true };
  } catch {
    return { error: 'That sign-in link did not work. Ask for a new one.' };
  }
}

export async function signOut() {
  try { await call('/auth/v1/logout', { method: 'POST' }); } catch {}
  setSession(null);
}

/* --- profiles ----------------------------------------------------------- */

export async function profile() {
  const u = user();
  if (!u) return null;
  if (mine !== undefined) return mine;
  const rows = await call(`/rest/v1/profiles?id=eq.${u.id}&select=*`);
  mine = rows?.[0] || null;
  return mine;
}

export async function saveProfile(displayName, homeCity = '') {
  const rows = await call('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: { id: user().id, display_name: displayName.trim(), home_city: homeCity.trim() || null },
  });
  mine = rows?.[0] || null;
  listeners.forEach(fn => { try { fn(session); } catch {} });
  return mine;
}

/* --- evenings ----------------------------------------------------------- */

/** A box about `km` either side of a point, as PostgREST filters. A city's
 *  posts are pinned to the city's centre, so 30 km takes in the city and not
 *  the next one. */
function near(lat, lon, km = 30) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const f = n => n.toFixed(4);
  return `lat=gte.${f(lat - dLat)}&lat=lte.${f(lat + dLat)}`
       + `&lon=gte.${f(lon - dLon)}&lon=lte.${f(lon + dLon)}`;
}

export function feed(lat, lon, { sort = 'loved', limit = 30 } = {}) {
  const order = sort === 'new' ? 'created_at.desc' : 'love_count.desc,created_at.desc';
  return call(`/rest/v1/feed?select=*&${near(lat, lon)}&order=${order}&limit=${limit}`);
}

export function leaders(lat, lon, limit = 8) {
  return call(`/rest/v1/city_leaders?select=author_id,display_name,city,posts,loves,is_guide`
            + `&${near(lat, lon)}&order=loves.desc,posts.desc&limit=${limit}`);
}

export async function share(evening) {
  const rows = await call('/rest/v1/itineraries', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: evening,
  });
  return rows?.[0] || null;
}

export const remove = id => call(`/rest/v1/itineraries?id=eq.${id}`, { method: 'DELETE' });

export async function love(id, on) {
  if (!on) {
    return call(`/rest/v1/reactions?itinerary_id=eq.${id}&user_id=eq.${user().id}`, { method: 'DELETE' });
  }
  try {
    await call('/rest/v1/reactions', {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: { itinerary_id: id },
    });
  } catch (e) {
    if (e.code !== '23505') throw e;          // loved it already, from another tab
  }
}

export async function loved(ids) {
  const u = user();
  if (!u || !ids.length) return new Set();
  const rows = await call(`/rest/v1/reactions?select=itinerary_id&user_id=eq.${u.id}`
                        + `&itinerary_id=in.(${ids.join(',')})`);
  return new Set((rows || []).map(r => r.itinerary_id));
}

export async function report(id, reason = '') {
  try {
    await call('/rest/v1/reports', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: { itinerary_id: id, reason: reason.slice(0, 280) },
    });
  } catch (e) {
    if (e.code !== '23505') throw e;          // already reported it
  }
}

/* --- what the planner learns -------------------------------------------- */

/** What locals recommend around a point: every place named in a shared
 *  evening nearby, with how many evenings named it and how loved they were.
 *  The planner ranks these first, and can route to one the map search never
 *  returned. Never throws and never holds a plan up for long - the locals'
 *  picks improve an evening, they are not required for one. */
export async function localPicks(lat, lon) {
  const none = { picks: [], posts: [] };
  if (!enabled || lat == null || lon == null) return none;
  try {
    const posts = await Promise.race([
      feed(lat, lon, { limit: 50 }),
      new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000)),
    ]);
    const byName = new Map();
    for (const p of posts || []) {
      for (const s of p.stops || []) {
        const name = String(s.name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const e = byName.get(key) || { name, kind: s.kind, lat: null, lon: null,
                                       posts: 0, loves: 0, notes: [] };
        e.posts += 1;
        e.loves += p.love_count || 0;
        if (e.lat == null && typeof s.lat === 'number') { e.lat = s.lat; e.lon = s.lon; }
        if (s.note) e.notes.push({ note: s.note, author: p.author_name, guide: p.author_is_guide });
        byName.set(key, e);
      }
    }
    return { picks: [...byName.values()], posts: posts || [] };
  } catch {
    return none;
  }
}
