/* The one escaper.
 *
 * Seven modules each carried a byte-identical copy of this. That is fine
 * until it isn't: escaping is the rule that keeps a venue name like
 * "Ben & Jerry's <Scoop>" - or anything a person typed into the community
 * feed - from becoming markup, and a rule enforced in seven places is a rule
 * with seven chances to be wrong. One copy, imported, tested once.
 *
 * Time helpers deliberately do not live here. `plan.js`, `weather.js` and
 * `results.js` each have their own `mins`/`hhmm` and they are not the same
 * function: one wraps past midnight, one does not, one parses strictly.
 * Merging them would quietly change the timing rules the tests pin.
 */

const MARKUP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Make a value safe to drop into innerHTML. */
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => MARKUP[c]);
