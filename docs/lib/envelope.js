/* The sealed envelope: an evening packed into a link.
 *
 * There is no server in this app, so the plan travels in the URL fragment
 * (#e=...). A fragment is never sent to any server - not ours, not GitHub's -
 * so the evening stays between the two people holding the link.
 *
 * Everything decoded here came out of a URL somebody typed or forwarded, so
 * it is untrusted. Nothing is copied across as-is: each field is rebuilt from
 * a whitelist, coerced to its type, length-capped, and links are recomputed
 * rather than carried (a carried URL is where "javascript:" would ride in).
 *
 * Token: `<version>.<z|r>.<base64url>` - z is deflate-raw, r is the plain
 * JSON for browsers with no CompressionStream. Nothing here touches the DOM
 * and nothing throws on a network failure, because it never uses one.
 */

import { attachLinks } from './links.js';

export const MAX_NOTE = 140;
const VERSION = 1;
const MAX_TOKEN = 24000;       // characters of link we will even look at
const MAX_JSON = 120000;       // bytes a token may inflate to

/* ---- field cleaners: raw value in, safe value out ------------------------ */
const str = n => v => typeof v === 'string' ? v.slice(0, n) : '';
const num = (lo, hi) => v => Number.isFinite(+v) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, +v)) : 0;
const coord = lim => v => Number.isFinite(+v) && v !== null && v !== '' && Math.abs(+v) <= lim ? +v : null;
const bool = v => v === true || v === 1;
const time = v => typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v : '';
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
// http(s) only, and nothing that could break out of an attribute or a CSS url().
const url = v => typeof v === 'string' && v.length <= 600 && /^https?:\/\/[^\s"'()<>\\]+$/i.test(v) ? v : '';
const list = (n, each) => v => Array.isArray(v) ? v.slice(0, n).map(each).filter(Boolean) : [];
const choice = values => v => values.includes(v) ? v : '';

const VENUE = {
  name: str(120), lat: coord(90), lon: coord(180), kind: str(60), cuisine: str(80),
  openingHours: str(200), website: url, address: str(200), diet: list(6, str(24)),
  photo: url, blurb: str(320), photoCredit: url,
};

const STOP = {
  slot: str(24), name: str(120), kind: str(24), start: time, minutes: num(0, 1440),
  why: str(420), travelNext: str(160), travelMinutes: num(0, 1440), booking: str(200),
  dressCode: str(40), indoor: bool, fallback: str(200), tip: str(260), lookedUp: bool, verified: bool,
  lat: coord(90), lon: coord(180), address: str(200), venueKind: str(60), cuisine: str(80),
  openingHours: str(200), website: url, diet: list(6, str(24)), distanceM: num(0, 1e7),
  photo: url, blurb: str(320), photoCredit: url,
  idea: str(80), role: choice(['core', 'next', 'optional']), specific: bool, timeSensitive: bool,
  sessionStart: time, closingTime: time, daylightUntil: time,
  alts: list(3, v => v?.name ? clean(VENUE, v) : null),
};
const PLAN = {
  title: str(140), pitch: str(420), adventure: str(40), timing: str(220), wear: str(320),
  transportNote: str(320), weatherCall: str(320), backup: str(320),
  warnings: list(8, str(320)),
  planMode: choice(['open', 'specific']), area: str(140),
};
const PREFS = {
  location: str(140), date, lat: coord(90), lon: coord(180), localOnly: bool,
  transport: choice(['walking', 'bike', 'transit', 'car', 'rideshare']),
};

function clean(schema, raw) {
  const out = {};
  const from = raw && typeof raw === 'object' ? raw : {};
  for (const k of Object.keys(schema)) out[k] = schema[k](from[k]);
  return out;
}

/** Only what is worth sending: empty and default values are dropped, and
 *  decode() puts them back. Reads whatever shape a saved plan has - a plan
 *  from before `alts` existed packs the same as one from today. */
function pack(schema, raw) {
  const out = {};
  const cleaned = clean(schema, raw);
  for (const [k, v] of Object.entries(cleaned)) {
    if (v === '' || v === null || v === 0 || v === false || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

/* ---- bytes <-> base64url -------------------------------------------------- */
const b64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = t => {
  const bin = atob(t.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON) { reader.cancel(); throw new Error('too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* ---- public --------------------------------------------------------------- */

/** Seal `{ plan, prefs, weather }` into a token. `note` is the line the sender
 *  wrote; `surprise` keeps the sealed envelope from teasing what is inside. */
export async function seal(d, { note = '', surprise = false } = {}) {
  const plan = d?.plan;
  if (!plan || !Array.isArray(plan.stops) || !plan.stops.length) throw new Error('nothing to seal');
  const p = pack(PLAN, plan);
  const cur = String(d.prefs?.currency || '').trim();
  // A gift does not come with a receipt. Prices are not in the schemas above;
  // the pitch and the warnings are prose that quotes them, so they are cut here.
  if (p.pitch) p.pitch = p.pitch.replace(/\s+-\s+about\s+\S+\s+[\d.,]+\s+for two\./i, '.')
                                .replace(/\s+for about\s+\S+\s+[\d.,]+,\s+for two\./i, '.')
                                .replace(/\s*[—-]\s*about\s+\S+\s+[\d.,]+\s+for two\./i, '.');
  if (p.warnings) p.warnings = p.warnings.filter(w => !/budget/i.test(w) && !(cur && w.includes(cur)));
  if (!p.warnings?.length) delete p.warnings;
  const body = {
    v: VERSION,
    n: str(MAX_NOTE)(String(note).trim()),
    s: surprise ? 1 : 0,
    p,
    st: plan.stops.slice(0, 12).map(s => pack(STOP, s)),
    pf: pack(PREFS, d.prefs),
    w: str(80)(d.weather?.summary),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (typeof CompressionStream === 'function') {
    return `${VERSION}.z.${b64(await pipe(bytes, new CompressionStream('deflate-raw')))}`;
  }
  return `${VERSION}.r.${b64(bytes)}`;
}

/** The token inside a location.hash, or null if it is not an envelope. */
export function tokenFrom(hash) {
  const m = /^#e=(\d+\.[zr]\.[A-Za-z0-9_-]+)$/.exec(hash || '');
  return m && m[1].length <= MAX_TOKEN ? m[1] : null;
}

export const linkFor = (token, base) => `${base}#e=${token}`;

/** Open a token: `{ note, surprise, data }`, where `data` is shaped like a
 *  saved plan so the results page can draw it. Throws on anything that is not
 *  a well-formed envelope - callers show one plain sentence for every case. */
export async function unseal(token) {
  const m = /^(\d+)\.([zr])\.([A-Za-z0-9_-]+)$/.exec(token || '');
  if (!m || token.length > MAX_TOKEN || +m[1] !== VERSION) throw new Error('not an envelope');
  let bytes = unb64(m[3]);
  if (m[2] === 'z') {
    if (typeof DecompressionStream !== 'function') throw new Error('cannot inflate');
    bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  }
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  if (!raw || raw.v !== VERSION || !Array.isArray(raw.st) || !raw.st.length) throw new Error('empty envelope');

  const plan = { ...clean(PLAN, raw.p), stops: raw.st.slice(0, 12).map(s => clean(STOP, s)), insights: [] };
  if (plan.stops.some(s => !s.name)) throw new Error('unnamed stop');
  const prefs = clean(PREFS, raw.pf);
  attachLinks(plan, prefs.location.split(',')[0]);
  const summary = str(80)(raw.w);
  return {
    note: str(MAX_NOTE)(raw.n),
    surprise: raw.s === 1,
    data: {
      plan, prefs, shared: true, saved: Date.now(),
      weather: summary ? { summary, source: 'shared' } : { source: 'unknown' },
    },
  };
}
