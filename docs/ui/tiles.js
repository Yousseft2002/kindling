/* Maps and venue visuals, from OpenStreetMap tiles laid out by hand.
 *
 * A slippy map is about fifteen lines of Web Mercator, so there is no mapping
 * library here: pick the zoom that fits every point, lay the tiles that cover
 * the frame, and put a pin on each. The same few lines also give every venue
 * a picture: most bars and restaurants have no Wikipedia photograph, and a
 * night-toned map of the street it is on beats a grey box.
 */

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TILE = 256;
const projX = (lon, z) => (lon + 180) / 360 * 2 ** z * TILE;
const projY = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z * TILE;
};

/** The <img> tags covering a W x H frame whose top-left is (left, top) in
 *  world pixels at zoom z. */
function lay(left, top, W, H, z) {
  const span = 2 ** z;
  let tiles = '';
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + H) / TILE); ty++) {
      if (ty < 0 || ty >= span) continue;              // above the pole
      const wrapped = ((tx % span) + span) % span;     // across the date line
      // No loading="lazy": inside a short clipped box the browser decides
      // most tiles are off-screen and never fetches them.
      tiles += `<img src="https://tile.openstreetmap.org/${z}/${wrapped}/${ty}.png" `
             + `alt="" style="left:${tx * TILE - left}px;top:${ty * TILE - top}px">`;
    }
  }
  return tiles;
}

const CREDIT = `<div class="credit">&copy; <a href="https://www.openstreetmap.org/copyright" `
             + `target="_blank" rel="noopener">OpenStreetMap</a></div>`;

/** The whole evening on one map, a numbered pin per stop. `clear` keeps
 *  the pins out of a band at the top or bottom - where the title sits when
 *  the map is a hero. */
export function routeMap(stops, W, H, { clearTop = 0, clearBottom = 0 } = {}) {
  const pts = stops.map((s, i) => ({s, i})).filter(o => o.s.lat != null && o.s.lon != null);
  if (pts.length < 2) return '';
  const PAD = 44;
  const room = H - clearTop - clearBottom;           // where the pins may go
  let z = 17;
  for (; z > 2; z--) {
    const xs = pts.map(o => projX(o.s.lon, z)), ys = pts.map(o => projY(o.s.lat, z));
    if (Math.max(...xs) - Math.min(...xs) <= W - PAD * 2 &&
        Math.max(...ys) - Math.min(...ys) <= room - PAD * 2) break;
  }
  const xs = pts.map(o => projX(o.s.lon, z)), ys = pts.map(o => projY(o.s.lat, z));
  const left = (Math.max(...xs) + Math.min(...xs)) / 2 - W / 2;
  const top = (Math.max(...ys) + Math.min(...ys)) / 2 - (clearTop + room / 2);

  // A faint line joining the pins in order: the route, not a scatter.
  const path = pts.map(o => `${(projX(o.s.lon, z) - left).toFixed(1)},${(projY(o.s.lat, z) - top).toFixed(1)}`).join(' ');
  const line = `<svg class="route-line" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`
             + `<polyline points="${path}"/></svg>`;
  const pins = pts.map(o =>
    `<div class="mpin" title="${esc(o.s.name)}" style="left:${projX(o.s.lon, z) - left}px;`
    + `top:${projY(o.s.lat, z) - top}px">${o.i + 1}</div>`).join('');
  return `<div class="map" style="height:${H}px"><div class="tiles">${lay(left, top, W, H, z)}</div>`
       + `${line}${pins}${CREDIT}</div>`;
}

/** One place, centred, as a picture. */
export function pointMap(lat, lon, W, H, z = 16) {
  const left = projX(lon, z) - W / 2, top = projY(lat, z) - H / 2;
  return `<div class="tiles" style="width:${W}px;height:${H}px">${lay(left, top, W, H, z)}</div>`
       + `<span class="here" aria-hidden="true"></span>`;
}

/* A mood for places with neither a photograph nor a pin: a night in, or a
 * stop the map could not find. Colour does the work, not clip art. */
const MOOD = {
  home: ['#3a1c3f', '#ff477e'], food: ['#3b1622', '#ff8a5b'], drinks: ['#1e1838', '#b86bff'],
  coffee: ['#2b1d17', '#f1b784'], music: ['#161a3a', '#6e7bff'], show: ['#2d1330', '#ff477e'],
  activity: ['#172a33', '#6fd3d0'], viewpoint: ['#2c2140', '#f1e4c3'], outdoors: ['#14281f', '#8fd694'],
  shopping: ['#31201a', '#f1e4c3'],
};

/** The best picture there is for a stop: its photograph, else a map of the
 *  street it is on, else a colour field for its kind. `size` is the frame
 *  in CSS pixels, so the map covers it at the right zoom. */
export function visual(stop, W = 360, H = 220, z = 16) {
  if (stop.photo) {
    return `<div class="vis vis-photo"><img src="${esc(stop.photo)}" alt="" loading="lazy" decoding="async"></div>`;
  }
  if (stop.lat != null && stop.lon != null) {
    return `<div class="vis vis-map">${pointMap(stop.lat, stop.lon, Math.ceil(W), Math.ceil(H), z)}</div>`;
  }
  const [a, b] = MOOD[stop.kind] || MOOD.activity;
  return `<div class="vis vis-mood" style="--m1:${a};--m2:${b}"><i></i></div>`;
}

/** Fade tiles in as they arrive. A cached tile finishes before any handler
 *  is attached, so `complete` has to be checked as well as listened for -
 *  otherwise the second plan you make has an invisible map. */
export function revealTiles(root = document) {
  for (const img of root.querySelectorAll('.tiles img, .vis-photo img')) {
    if (img.complete && img.naturalWidth > 0) img.classList.add('on');
    else img.addEventListener('load', () => img.classList.add('on'), {once: true});
    img.addEventListener('error', () => img.classList.add('on', 'broken'), {once: true});
  }
}
