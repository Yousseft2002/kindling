/* Concepts stay independent of the researched venue, including in invitations. */
export { venueOptions } from './plan.js';

const LABELS = {
  pottery: 'Clay painting', activity: 'Art & galleries', aquarium: 'An aquarium visit',
  drinks: 'Drinks nearby', coffee: 'Coffee nearby', food: 'Dinner nearby',
  music: 'Live music', show: 'A film or show', viewpoint: 'A scenic walk',
  shopping: 'Bookshops & browsing', treat: 'Local treats', sweet: 'Ice cream',
  takeout: 'Dinner to take home', home: 'A film at home', sled: 'Sledding',
  hill: 'A sunset walk', nature: 'A nature walk', rink: 'Ice skating',
  plunge: 'A cold plunge', swim: 'A swim',
};

export function ideaLabel(stop = {}) {
  return stop.idea || LABELS[stop.slot] || LABELS[stop.kind] || 'Time together';
}

export function ideaTime(stop = {}, index = 0) {
  const clock = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '');
  if (stop.timeSensitive) {
    const time = clock(stop.sessionStart) ? stop.sessionStart : clock(stop.start) ? stop.start : '';
    return time ? `Suggested arrival ${time}` : 'Check the session time';
  }
  if (stop.role === 'optional') return 'Later, if you feel like it';
  if (index !== 0) return 'Afterward';
  if (!clock(stop.start)) return 'Start together';
  const [h, m] = stop.start.split(':').map(Number);
  const rounded = Math.round((h * 60 + m) / 30) * 30 % 1440;
  return `Around ${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

const invitationLabel = stop => ideaLabel(stop)
  .replace(/\s+nearby$/i, '').replace(/^An? /, '');

/** No venue names, clock times or invented neighbourhoods enter this sentence. */
export function invitationSummary(plan = {}, prefs = {}) {
  const stops = (plan.stops || []).filter(s => s.role !== 'optional');
  const first = stops.find(s => !['food', 'home'].includes(s.kind)) || stops[0];
  const dinner = stops.find(s => s.kind === 'food' && s !== first);
  const second = dinner || stops.find(s => s !== first);
  const titleCase = text => text.replace(/\b[a-z]/g, c => c.toUpperCase());
  const lead = first ? titleCase(invitationLabel(first)) : 'Time Together';
  const tail = second ? ` & ${invitationLabel(second).toLowerCase()}` : '';
  const area = String(plan.area || prefs.location || '').split(',')[0].trim();
  return `You, Me, ${lead}${tail}${area ? ` in ${area}` : ''}.`;
}
