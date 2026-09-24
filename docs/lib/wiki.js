/* Photographs and a line of context, from Wikipedia. No key.
 *
 * A list of venue names is information; a photograph of the place you are
 * about to walk to is an evening you can picture. Aquariums, museums,
 * theatres and landmarks have articles; small bars and most restaurants do
 * not, and that is fine - they get no photo and nothing is lost.
 *
 * What is *not* fine is a photo of the wrong place, so a hit is only believed
 * when the article is about somewhere near here. The check is the article's
 * own coordinates: language-independent, and decisive. A name check alone
 * passes "Chart House" against a chain on another continent, and a city-name
 * check wrongly rejects Museu do Aljube, whose English article says Lisbon
 * while the user typed Lisboa.
 *
 * `origin=*` is required - without it the browser has no CORS headers to read
 * and the request fails even though the server answered.
 */

import { getJSON, memo, distanceKm, DAY } from './net.js';

const API = 'https://en.wikipedia.org/w/api.php';
const NEAR_KM = 5;        // generous: a large site is tagged at its centre

export function look(name, lat, lon) {
  const n = String(name || '').trim();
  if (n.length < 3) return Promise.resolve(null);

  const key = `wiki:${n.toLowerCase()}:${lat?.toFixed?.(2)}:${lon?.toFixed?.(2)}`;
  return memo(key, 7 * DAY, async () => {
    const d = await getJSON(API, {
      action: 'query', format: 'json', formatversion: 2,
      generator: 'search', gsrsearch: n, gsrlimit: 1,
      prop: 'pageimages|extracts|info|coordinates',
      inprop: 'url', piprop: 'thumbnail', pithumbsize: 800,
      exintro: 1, explaintext: 1, exsentences: 2, redirects: 1,
      origin: '*',
    });
    return verify(d, n, lat, lon);
  });
}

/** Split out so the guard can be exercised against a captured payload. */
export function verify(data, name, lat, lon) {
  const page = (data?.query?.pages || [])[0];
  if (!page) return null;

  const title = page.title || '';
  const blurb = (page.extract || '').trim();
  const photo = page.thumbnail?.source || '';

  // Wikipedia's search always returns *something*, so an unverified hit is
  // how you end up showing a photo of a restaurant on another continent.
  const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const named = words.some(w => title.toLowerCase().includes(w));
  if (!named) return null;

  const c = (page.coordinates || [])[0];
  if (c && lat != null && lon != null) {
    if (distanceKm(+c.lat, +c.lon, lat, lon) > NEAR_KM) return null;
  }

  if (!photo && !blurb) return null;
  return {
    title, photo, blurb,
    url: page.fullurl || `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`,
  };
}
