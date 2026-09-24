/* Booking and map links.
 *
 * A finished itinerary is the highest-intent moment in the whole dining-and-
 * activity funnel: someone has just decided they are going out on Saturday
 * and is looking at a named venue. So every stop carries a link out.
 *
 * Two rules kept honest, same as the Python version:
 *
 *  - **No invented partner tags.** With no tag configured the link is a clean
 *    search URL with no tracking parameters. A fabricated tag does not earn
 *    money - it breaks the link and, on some networks, closes the account.
 *  - **A real place link beats a search.** When the venue lookup returned
 *    coordinates, the map link opens the pin rather than a search for a name
 *    that may match three places.
 */

const PROVIDER_BY_KIND = {
  food: 'opentable', drinks: 'opentable', activity: 'viator',
  show: 'getyourguide', music: 'dice',
  coffee: 'search', viewpoint: 'search', shopping: 'search', walk: 'search',
};

const LABEL = {
  opentable: 'Reserve on OpenTable',
  viator: 'Book on Viator',
  getyourguide: 'Book on GetYourGuide',
  dice: 'Tickets on DICE',
  search: 'Find it',
};

/* Fill these in only once a programme has actually approved you. Empty is
 * the correct, working default. */
export const PARTNERS = { opentable: '', viator: '', getyourguide: '', dice: '' };

const maps = q => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);

function bookUrl(provider, stop, place) {
  const term = `${stop.name} ${place}`;
  const tag = (PARTNERS[provider] || '').trim();
  const q = new URLSearchParams();
  switch (provider) {
    case 'opentable':
      q.set('term', term); if (tag) q.set('ref', tag);
      return 'https://www.opentable.com/s?' + q;
    case 'viator':
      q.set('text', term); if (tag) { q.set('pid', tag); q.set('mcid', '42383'); }
      return 'https://www.viator.com/searchResults/all?' + q;
    case 'getyourguide':
      q.set('q', term); if (tag) q.set('partner_id', tag);
      return 'https://www.getyourguide.com/s/?' + q;
    case 'dice':
      q.set('q', stop.name); if (tag) q.set('utm_source', tag);
      return 'https://dice.fm/search?' + q;
    default:
      return maps(term);
  }
}

export function attachLinks(plan, place) {
  for (const stop of plan.stops) {
    let provider = PROVIDER_BY_KIND[stop.kind] || 'search';
    // A free stop is not worth a booking link; send them to the map.
    if (stop.cost <= 0 && provider !== 'search') provider = 'search';

    stop.provider = provider;
    stop.bookLabel = LABEL[provider];
    stop.bookUrl = bookUrl(provider, stop, place);
    stop.mapUrl = (stop.lat != null && stop.lon != null)
      ? maps(`${stop.lat.toFixed(6)},${stop.lon.toFixed(6)}`)
      : maps(`${stop.name} ${place}`);
  }
  return plan;
}
