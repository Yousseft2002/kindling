/* Forecast for the evening, from Open-Meteo. No key.
 *
 * Sunset is the field that earns its keep. "Sunset walk" is only an
 * instruction if you know when sunset is, and a plan that puts the outdoor
 * stop forty minutes after dark is worthless.
 */

import { getJSON, memo, HOUR } from './net.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';

/* Numeric WMO codes collapsed to phrases a planner can act on. The exact
 * meteorology matters less than whether the evening is dry and whether an
 * outdoor stop survives. */
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

const HORIZON_DAYS = 16;   // the free forecast runs this far out

export function blank(summary = 'unknown') {
  return { summary, highC: null, lowC: null, precip: null, windKph: null,
           sunset: null, source: 'unknown' };
}

export const isWet = w => (w?.precip ?? 0) >= 40;
export const isCold = w => w?.lowC != null && w.lowC < 8;
export const isKnown = w => w && w.source !== 'unknown';

export function brief(w) {
  if (!w) return 'unknown';
  const bits = [w.summary];
  if (w.highC != null) bits.push(`${Math.round(w.highC)}C high`);
  if (w.lowC != null) bits.push(`${Math.round(w.lowC)}C low`);
  if (w.precip != null) bits.push(`${w.precip}% precip`);
  if (w.windKph) bits.push(`wind ${Math.round(w.windKph)}kph`);
  if (w.sunset) bits.push(`sunset ${hhmm(w.sunset)}`);
  return bits.filter(Boolean).join(', ');
}

const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The hour before sunset - where an outdoor stop belongs. Minutes past
 *  midnight, or null when sunset is unknown. */
export function goldenHour(w) {
  if (!w?.sunset) return null;
  return { start: Math.max(0, w.sunset - 60), end: w.sunset };
}

/** Typed overrides need teeth. Someone who writes "steady rain" means the
 *  plan should move indoors, but a typed summary carries no precipitation
 *  number, so without these keywords nothing downstream would notice. */
const WET = ['rain', 'wet', 'shower', 'storm', 'drizzle', 'snow', 'sleet', 'hail', 'pour'];
const COLD = ['cold', 'freez', 'frost', 'snow', 'sleet', 'chilly', 'bitter'];
const HOT = ['hot', 'heat', 'scorch', 'sweltering', 'humid'];
const DRY = ['clear', 'sunny', 'fine', 'dry', 'cloudless'];

export function parseOverride(text) {
  const low = ` ${String(text || '').toLowerCase()} `;
  const w = blank(String(text || '').trim() || 'unknown');
  w.source = 'manual';
  if (WET.some(k => low.includes(k))) w.precip = 80;
  else if (DRY.some(k => low.includes(k))) w.precip = 10;
  if (COLD.some(k => low.includes(k))) { w.lowC = 1; w.highC = 6; }
  else if (HOT.some(k => low.includes(k))) { w.lowC = 24; w.highC = 33; }
  return w;
}

/** Forecast for `iso` (YYYY-MM-DD) at a point. Always returns a weather
 *  object, so callers never branch on null. */
export function forecast(lat, lon, iso) {
  if (lat == null || lon == null) return Promise.resolve(blank());

  const days = Math.round((new Date(iso + 'T12:00') - new Date()) / 86400000);
  if (days < 0 || days > HORIZON_DAYS) {
    return Promise.resolve(blank('unknown (outside forecast range)'));
  }

  return memo(`wx:${lat.toFixed(2)}:${lon.toFixed(2)}:${iso}`, HOUR / 2, async () => {
    const d = await getJSON(FORECAST, {
      latitude: lat, longitude: lon, timezone: 'auto',
      start_date: iso, end_date: iso,
      daily: ['weather_code', 'temperature_2m_max', 'temperature_2m_min',
              'precipitation_probability_max', 'wind_speed_10m_max', 'sunset'].join(','),
    });
    const day = d?.daily;
    if (!day) return blank();

    const first = k => (day[k] || [])[0] ?? null;
    const code = first('weather_code');
    const rawSunset = first('sunset');
    let sunset = null;
    if (rawSunset) {
      // Open-Meteo returns local ISO like "2026-09-26T19:42".
      const t = String(rawSunset).split('T')[1];
      if (t) sunset = (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
    }
    const precip = first('precipitation_probability_max');
    return {
      summary: code == null ? 'unknown' : (WMO[code] || 'unsettled'),
      highC: first('temperature_2m_max'),
      lowC: first('temperature_2m_min'),
      precip: precip == null ? null : Math.round(precip),
      windKph: first('wind_speed_10m_max'),
      sunset,
      source: 'open-meteo',
    };
  });
}
