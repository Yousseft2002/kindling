/* Taking the evening with you.
 *
 * The plan is only useful if it survives leaving the app. The core idea is
 * that you settle the evening beforehand and then put the phone away - which
 * only works if the evening is somewhere you will actually see it: the
 * calendar that already nags you, a message to the person you are going
 * with, a route already loaded in the maps app.
 *
 * All three are pure functions of the plan. No DOM, no network, no storage,
 * so they run offline, work on a saved plan, and are tested in node.
 */

import { ideaTime } from './ideas.js';

/* ---- 1. the calendar ------------------------------------------------- */

/** RFC 5545 escaping for TEXT values: backslash, semicolon, comma, newline. */
const ics = s => String(s ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

/** Fold to 75 octets, continuation lines starting with one space. Long
 *  descriptions are otherwise rejected outright by strict parsers. */
function fold(line) {
  const bytes = [...new TextEncoder().encode(line)];
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  while (start < bytes.length) {
    const take = start === 0 ? 75 : 74;
    out.push(new TextDecoder().decode(new Uint8Array(bytes.slice(start, start + take))));
    start += take;
  }
  return out.join('\r\n ');
}

const two = n => String(n).padStart(2, '0');
const mins = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };

/** A local, floating timestamp: 20261003T170000.
 *
 *  Deliberately floating - no Z, no TZID. The evening happens at 19:00 where
 *  the couple is standing, and shipping a timezone database to say so would
 *  be absurd. Floating time is what every calendar does with "7pm dinner".
 *  A date that rolls past midnight carries into the next day. */
function stamp(dateISO, minutes) {
  const base = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO || '');
  const day = base ? new Date(+base[1], +base[2] - 1, +base[3]) : new Date();
  const m = Math.max(0, minutes ?? 0);
  day.setDate(day.getDate() + Math.floor(m / 1440));
  const mm = m % 1440;
  return `${day.getFullYear()}${two(day.getMonth() + 1)}${two(day.getDate())}`
       + `T${two(Math.floor(mm / 60))}${two(mm % 60)}00`;
}

/** A tiny stable id, so re-importing the same evening updates its events
 *  rather than duplicating them. */
function uid(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The whole evening as an .ics file: one event per stop, in order. */
export function asICS(plan, prefs = {}) {
  if (plan.planMode === 'open') {
    const core = (plan.stops || []).filter(s => s.role !== 'optional');
    if (!core.length) return '';
    const first = core[0], last = core.at(-1);
    const start = mins(first.start) ?? 17 * 60;
    let end = mins(last.start) ?? start;
    if (end < start) end += 1440;
    // A loose date is one calendar hold, not a set of business appointments.
    const hold = {
      name: plan.title, start: first.start, minutes: end + (last.minutes || 60) - start,
      address: plan.area || prefs.location, cost: plan.totalCost || 0,
      why: asText(plan, prefs),
    };
    return asICS({ stops: [hold] }, prefs);
  }
  const date = prefs.date || '';
  const cur = prefs.currency || '';
  const where = String(prefs.location || '').split(',')[0];

  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    'PRODID:-//Kindling//Date planner//EN', 'METHOD:PUBLISH',
  ];

  (plan.stops || []).forEach((s, i) => {
    const from = mins(s.start);
    if (from == null) return;
    const detail = [
      s.role === 'optional' ? 'Optional — only if you feel like it.' : '',
      s.why,
      s.cost > 0 ? `About ${cur} ${Math.round(s.cost)} for two.` : 'Free.',
      s.booking, s.tip,
      s.travelNext && i < plan.stops.length - 1 ? `Then: ${s.travelNext}` : '',
    ].filter(Boolean).join(' ');

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid(`${date}|${s.name}|${s.start}`)}-${i}@kindling`,
      // DTSTAMP is when the event was written, and the spec says UTC - unlike
      // the start and end, which are floating local time on purpose.
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(date, from)}`,
      `DTEND:${stamp(date, from + (s.minutes || 60))}`,
      fold(`SUMMARY:${ics(`${s.role === 'optional' ? 'Optional: ' : ''}${s.name}`)}`),
      fold(`LOCATION:${ics(s.address || where)}`),
      fold(`DESCRIPTION:${ics(detail)}`),
    );
    if (s.website || s.bookUrl) lines.push(fold(`URL:${ics(s.website || s.bookUrl)}`));
    // One nudge, on the first stop only, an hour before. Enough to leave the
    // house; not enough to be the sort of app that buzzes all evening.
    if (i === 0) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY',
                 fold(`DESCRIPTION:${ics(`Tonight: ${s.name}`)}`),
                 'TRIGGER:-PT60M', 'END:VALARM');
    }
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  // CRLF is not a preference here; the spec requires it and Outlook enforces it.
  return lines.join('\r\n') + '\r\n';
}

/** A filename someone can find again in their downloads folder. */
export function icsName(prefs = {}) {
  const where = String(prefs.location || 'evening').split(',')[0]
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'evening';
  return `kindling-${where}-${prefs.date || 'plan'}.ics`;
}

/* ---- 2. the message -------------------------------------------------- */

/** The evening as plain text, for pasting into a message.
 *
 *  No markdown: it is going into WhatsApp or iMessage, where asterisks are
 *  just asterisks. Times first, because that is what gets argued about. */
export function asText(plan, prefs = {}) {
  const cur = prefs.currency || '';
  const where = String(prefs.location || '').split(',')[0];
  const when = prefs.date
    ? new Date(prefs.date + 'T12:00').toLocaleDateString(undefined,
        { weekday: 'long', day: 'numeric', month: 'long' })
    : '';

  const out = [[when, where].filter(Boolean).join(' - ')];
  const total = (plan.stops || []).reduce((a, s) => a + (s.cost || 0), 0);
  if (total > 0) out.push(`About ${cur} ${Math.round(total)} for two.`);
  out.push('');

  if (plan.planMode === 'open') out.push(plan.title, plan.pitch || '', '');
  for (const [i, s] of (plan.stops || []).entries()) {
    if (plan.planMode === 'open') {
      out.push(`${s.role === 'optional' ? 'Optional: ' : ''}${s.specific ? s.name : s.idea || s.kind} — ${ideaTime(s, i)}`);
      if (s.specific && s.address) out.push(`        ${s.address}`);
      if (s.closingTime) out.push(`        Closes at ${s.closingTime}; check before heading out.`);
      if (s.daylightUntil) out.push(`        Keep the outdoor part before sunset, around ${s.daylightUntil}.`);
      continue;
    }
    out.push(`${s.role === 'optional' ? 'Optional: ' : ''}${s.start}  ${s.name}`);
    const bits = [s.address, s.cost > 0 ? `${cur} ${Math.round(s.cost)}` : 'free']
      .filter(Boolean).join(' - ');
    if (bits) out.push(`        ${bits}`);
    if (s.mapUrl) out.push(`        ${s.mapUrl}`);
  }

  if (plan.wear) out.push('', `Wear: ${plan.wear}`);
  // Warnings travel with the plan. A plan that hides its own caveats in the
  // app and sends a clean copy to the other person is worse than no copy.
  for (const w of plan.warnings || []) out.push('', `Note: ${w}`);
  return out.join('\n');
}

export function areaUrl(plan, prefs = {}) {
  return 'https://www.google.com/maps/search/?api=1&query='
    + encodeURIComponent(plan.area || String(prefs.location || '').split(',')[0]);
}

/* ---- 3. the route ---------------------------------------------------- */

const TRAVEL = { walking: 'walking', transit: 'transit', cycling: 'bicycling',
                 car: 'driving', driving: 'driving' };

/** One Google Maps link that walks the whole evening, in order.
 *
 *  Stops with no coordinates are left out rather than guessed at: routing
 *  through "somewhere with live music near Boston" sends you to whatever
 *  the geocoder feels like. Returns '' when fewer than two stops can be
 *  placed, because a route needs somewhere to go.
 */
export function routeUrl(stops = [], transport = 'walking') {
  const placed = stops.filter(s => typeof s.lat === 'number' && typeof s.lon === 'number');
  if (placed.length < 2) return '';
  const at = s => `${s.lat.toFixed(6)},${s.lon.toFixed(6)}`;

  const q = new URLSearchParams({
    api: '1',
    origin: at(placed[0]),
    destination: at(placed[placed.length - 1]),
    travelmode: TRAVEL[transport] || 'walking',
  });
  // Google takes at most 9 waypoints between the ends; an evening never has
  // that many, but clamp rather than produce a URL that silently fails.
  const middle = placed.slice(1, -1).slice(0, 9);
  if (middle.length) q.set('waypoints', middle.map(at).join('|'));
  return 'https://www.google.com/maps/dir/?' + q;
}
