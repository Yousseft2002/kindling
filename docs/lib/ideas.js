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

export function ideaTitle(stop = {}) {
  return invitationLabel(stop).replace(/\b[a-z]/g, c => c.toUpperCase());
}

const REASONS = {
  pottery: 'Make something together before you settle in to talk.',
  activity: 'Something to look at gives the conversation a place to start.',
  aquarium: 'Let what you find give you something to talk about over dinner.',
  coffee: 'Keep the start low-pressure and see where the conversation goes.',
  drinks: 'A relaxed start, with room to get to know each other.',
  shopping: 'Browse together and find out what catches each other’s eye.',
  viewpoint: 'Get a little air together before you settle in.',
  music: 'Let the music set the mood, then make time to talk.',
  show: 'Share something to react to before you compare notes.',
};

export function ideaPitch(plan = {}) {
  const core = (plan.stops || []).filter(s => s.role !== 'optional');
  if (!core.length) return 'No feasible opening idea came back. Choose and check a starting point before making the date.';
  const sequence = core.map(s => ideaLabel(s).toLowerCase());
  const opener = `Start with ${sequence[0]}${sequence.length > 1 ? `, then ${sequence.slice(1).join(', then ')}` : ''}.`;
  const reason = REASONS[core[0].slot] || REASONS[core[0].kind]
    || 'Leave room to enjoy being together rather than rushing through a checklist.';
  const optional = (plan.stops || []).find(s => s.role === 'optional');
  return `${opener} ${reason}${optional ? ` Keep ${ideaLabel(optional).toLowerCase()} optional — only if you are both up for more.` : ''}`;
}

export function ideaWhy(stop = {}, previous = null) {
  if (stop.kind === 'home') return stop.venueWhy || stop.why || 'A film together, with the phones put away.';
  if (stop.role === 'optional') return 'Only if you are both up for more. There is nothing left you have to do.';
  if (stop.slot === 'coffee' && previous?.slot === 'plunge') {
    return 'Warm up together somewhere close — dry clothes, a hot drink and a seat before dinner.';
  }
  const copy = {
    pottery: 'Make something together. Check what the studio actually offers before committing.',
    activity: 'Choose something to look at together and follow what catches your eye.',
    aquarium: 'Explore together, with something new around each corner to talk about.',
    food: 'Find somewhere nearby that suits both of you. Leave time to sit down and talk.',
    takeout: 'Pick up something you both fancy, then head home without rushing.',
    coffee: 'A low-pressure place to sit down and see where the conversation goes.',
    drinks: 'A little atmosphere and room to talk. Choose the place when you are ready.',
    shopping: 'Browse together and follow what catches your eye — not a shopping checklist.',
    music: 'Find something you both want to hear. Check what is actually on before making it the plan.',
    show: 'Choose something you would both enjoy, then compare notes. Check the programme before committing.',
    viewpoint: 'A little fresh air and a view together, while there is still light.',
    hill: 'A short climb and a view, while there is still light. Choose a route that fits your transport.',
    nature: 'Find somewhere green to walk and talk, while there is still light.',
    rink: 'An hour on the ice together. Check public skating times before committing.',
    sled: 'A little play in the snow, while there is still light. Check conditions before setting off.',
    plunge: 'A brief cold plunge together, never alone. Check safe access and conditions, with warm dry clothes ready.',
    swim: 'A swim together while there is still light, where others swim. Check conditions and posted closures.',
    treat: 'Find a small local treat worth sharing. Let what looks good make the choice.',
    sweet: 'Something sweet to share, with no need to make another big stop.',
  };
  return copy[stop.slot] || copy[stop.kind]
    || 'Choose a place that fits the idea and leave room to enjoy being together.';
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

const invitationLabel = stop => {
  const label = ideaLabel(stop);
  const concise = {
    'Art & galleries': 'Art',
    'A scenic walk': 'Scenic walk',
    'A sunset walk': 'Sunset',
    'Bookshops & browsing': /market/i.test(stop.venueKind || '') ? 'Market browsing' : 'Bookstore browsing',
  };
  return (concise[label] || label).replace(/\s+nearby$/i, '').replace(/^An? /, '');
};

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
