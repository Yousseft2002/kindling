# Kindling

Seven questions, one evening.

```
drinks at JJ Foley's  →  New England Aquarium  →  dinner at Kaze
```

Not a list of recommendations — a route, with start times, a cost per stop,
what to book, what to wear, and a named indoor fallback for anything outdoors.
Every stop is a real place near you, with its address, its opening hours, its
website, and a pin on a map.

**No API key. No account. No server.** The app in `docs/` is the whole product
and it runs entirely in your browser, on free public data.

---

## Run it

It is a static site, so anything that serves files will do — but ES modules
will not load from `file://`, so you do need a server of some kind:

```bash
python -m http.server 8090
```

Then open `http://127.0.0.1:8090/docs/`.

Published, it is GitHub Pages pointed at the `docs/` folder on `main`. Nothing
to build, nothing to deploy — pushing is deploying.

## Where the data comes from

| Service | For | Key |
|---|---|---|
| **OpenStreetMap** (Nominatim) | venues, categories, addresses, opening hours | none |
| **Open-Meteo** | geocoding, forecast, sunset | none |
| **Wikipedia** | a photograph and a line of context | none |
| **OpenStreetMap tiles** | the route map | none |

All four answer cross-origin browser calls, which is the only reason this can
be a static site at all — that was checked from a third-party origin before
committing to the approach, not assumed.

Nominatim asks for at most one request a second and a plan needs several
lookups, so **a plan takes about ten seconds**. `lib/net.js` is the single gate
that enforces the rate limit, and the button reports the stage it is on —
*Looking for places near you → Finding a photograph → Checking the weather* —
rather than spinning silently. Results are memoised for the session, so going
back and changing one answer does not re-fetch everything.

## What the seven answers actually change

Asking seven questions and ignoring the answers is theatre, so:

| Input | What it changes |
|---|---|
| **location** | Resolved to coordinates. Everything is searched within a radius of *that point* — a plan anchored on a point is local, one anchored on the string "London" is a guess about which part. |
| **relationship stage** | The biggest lever: how many stops, how long the evening runs, and whether the last one is optional. |
| **interests** | Picks the anchor stop. "aquarium" builds the evening around an aquarium, "jazz" around live music, "art" around a gallery. |
| **budget** | A hard cap, split across stops, then re-checked against the arithmetic. |
| **weather** | Fetched for those coordinates, or typed. Rain keeps the evening indoors instead of marching you up a hill. |
| **transportation** | Sets the search radius and the longest acceptable hop between stops. |
| **clothing style** | Flags a venue whose door policy is stricter than what you are wearing. A plan that gets you turned away is a failed plan. |

Plus what a time-ordered itinerary cannot do without: the date, the start time,
roughly how long, and a free-text note for dietary limits or anything to avoid.

### Location, specifically

Two ways in, both ending at coordinates:

- **Type it.** The field autocompletes against Open-Meteo's geocoder; picking a
  result attaches its coordinates. This is how you tell Alfama in Lisbon from
  Alfamén in Aragon, which the picker will happily offer you both of.
- **Tap the pin.** The browser hands over GPS coordinates and Nominatim turns
  them into a neighbourhood name — `38.7139, -9.1289` comes back as "Alfama,
  Lisboa".

Geolocation needs a *secure context*: `localhost` or HTTPS. GitHub Pages is
HTTPS, so on the published site the pin works on a phone. Over a plain-HTTP LAN
address it does not, and the app says so instead of failing silently.

## Things that are load-bearing

**Opening hours are a constraint, not a decoration.** The first Boston plan
this ever produced put the aquarium at 18:02–19:17 against a closing time of
18:00. Now whatever shuts first goes first, dinner stays last, and anything
that still overruns is flagged rather than hidden. `closesAt()` takes the last
clock time in an OSM `opening_hours` string, which is the closing time in every
common shape; a result before noon means it shuts after midnight, which is
treated as no limit.

**Compound locations resolve broadest-part-first.** "Williamsburg, Brooklyn"
matches nothing as a whole, and falling back to the specific part alone finds
Williamsburg *Virginia* — a confident answer 500 km from the date. So the
container is resolved first, and the specific part is only accepted within
150 km of it.

**Transit noise is filtered.** Searching "aquarium" in Boston returns the New
England Aquarium and then four subway stops named after it.

**A photograph is only believed when the article is about this place.**
Verified against the article's own coordinates, which is language-independent
and decisive. A name check alone passes "Chart House" against a chain on
another continent; a city-name check wrongly rejects Museu do Aljube, whose
English article says Lisbon while the user typed Lisboa. Appending the place
name to the search query has the same failure — it returned the Faneuil Hall
article for a restaurant *inside* Faneuil Hall. With coordinates in hand, don't.

**Every path is relative.** A GitHub Pages project site lives at
`you.github.io/kindling/`, so an absolute `/icons/…`, or a service worker
caching `'/'`, points at the domain root and breaks. `sw.js` resolves
everything against `new URL('./', self.location)`.

**Map tiles cannot use `loading="lazy"`.** Inside a short clipped box the
browser decides most of them are off-screen and never fetches them. And a
cached tile finishes loading before any handler can attach, so `revealTiles()`
checks `complete` as well as listening — otherwise the *second* plan you make
has an invisible map.

## The app itself

One question per screen, ten of them, in the order a person actually thinks
about an evening, rather than a form with fourteen fields. Picking a stage or a
dress code both answers and advances, so most of the flow is one tap.

- **The stage animates to the height of the active screen**, so the button
  glides rather than jumps. `measure()` recomputes on every transition and
  whenever content changes size.
- **Motion carries direction.** Forward rises from below, back drops from
  above, and the outgoing screen leaves the way you are travelling. Going back
  skips the stagger — you have read the question already and you want to change
  your answer.
- **One clock.** Screens, their contents and the stage height all land inside
  .34s. They used to take .42s, .74s and .5s, so the button arrived after the
  sentence it belonged to.
- **All motion is decoration, never information.** `prefers-reduced-motion`
  collapses every transition and the auto-advance fires immediately. The
  override must name every direction class: `.screen.enter-up` is a two-class
  selector and out-specifies a bare `.screen{transform:none}`, so a rename
  silently gives motion back to people who asked for none. A test pins this.
- **Touch has no hover**, so everything interactive has an `:active` state.
  Without one, a tap reads as lag even when nothing is slow.
- **`.wrap` has a fixed height, not a minimum.** Flex children only shrink
  inside a constrained container; with `min-height` the long option lists
  pushed the button off the bottom. The results page is arbitrarily long, so
  `body.done` relaxes it again.
- **`margin:auto` centres the stage, not `align-items:center`** — centring a
  flex child taller than its container clips the top off in every browser, and
  five option cards are taller than a phone.
- Display type is Fraunces from Google Fonts, with Georgia behind it. It
  degrades cleanly if the request fails.

Installable, and offline it opens to your last plan from `localStorage` — the
actual failure case is standing outside a bar with one bar of signal trying to
remember which street the next stop is on. It will not plan a *new* date
without signal, and says so. The icons are generated, not hand-drawn:
`python tools/make_icons.py`.

## Layout

```
docs/                 the app — this is what GitHub Pages serves
  index.html          shell, styles, the deck
  app.js              screens, transitions, results, the map
  lib/net.js          fetch, session cache, the Nominatim rate gate
  lib/places.js       geocoding, category search, venue lookup, noise filter
  lib/weather.js      forecast, golden hour, typed overrides
  lib/wiki.js         photograph and blurb, with the coordinate guard
  lib/plan.js         slots, composition, the rules
  lib/links.js        booking and map links
  sw.js               offline shell
```

---

# The Python version

`dateplanner/` and `run.py` are the original build, and they do everything
`docs/` does **plus** the part that cannot ship to Pages: Claude writes the
itinerary. A web-search scouting pass for what is actually on that night, a
planning call, then a repair pass. That needs an API key, and a key in a public
page is a key anyone can spend, so it needs a server.

```bash
pip install -r requirements.txt
python run.py --serve                            # the AI version, locally
python run.py -l "Brooklyn" -b 90 --dry-run      # a real plan, zero API cost
python test_planner.py                           # 407 offline tests, no key, no spend
```

Two implementations of the same rules is a real cost, and worth saying out
loud: `docs/` is the product, the Python side is where the AI path lives until
it has somewhere to run. If they drift, `docs/` wins.

## The API key

**Without a key every plan is a generic template** — "a specialist coffee bar
in a walkable part of town" rather than a named venue. Everything else works
either way, which is exactly what makes this confusing: the keyless output
looks like a bad answer rather than a missing credential. (The static app
solves this differently — it composes from real OSM venues, so there is no
degraded mode to explain.)

Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).

```bash
# 1. A .env file next to run.py — takes effect immediately
cp .env.example .env        # then edit it and paste your key

# 2. Or set it permanently
setx ANTHROPIC_API_KEY "sk-ant-..."
# then open a NEW terminal — setx does not touch the one you are in
```

Then confirm it actually works:

```bash
python run.py --check-key
```

That makes one tiny request and says whether the key is missing, invalid, out
of credit, or fine. It prints the key's length and its `sk-ant-` prefix so you
can spot a truncated paste, and never the key itself.

`.env` is gitignored and holds a placeholder, not a key - nothing in this
repo has ever contained a real one. A real environment variable always beats
the file.

> Everything below describes the Python build. Much of it applies to both
> sides — `docs/` is a port of the same rules, the same venue logic and the
> same hard-won facts — but the file names, the endpoints and the model path
> are the Python one.

## Architecture

```
prefs ─▶ geo ─▶ weather ─▶ scout ─▶ rules.brief ─▶ Claude ─▶ places ─▶ rules.check ─▶ repair ─▶ render
      (lat/lon) (forecast)  (web    (constraints)  (taste)   (real     (arithmetic)   (fix what
                            search)                          venues)                   broke)
```

| File | Role |
|---|---|
| `dateplanner/rules.py` | **The product.** Stage rules, budget tolerance, every check. |
| `dateplanner/planner.py` | The system prompt (the other half of the product) + the offline planner |
| `dateplanner/models.py` | `Prefs` in, `Plan` out. Doubles as the structured-output schema |
| `dateplanner/geo.py` | Place search, reverse geocoding, the coordinates everything hangs off |
| `dateplanner/places.py` | Venue lookups: picks OSM or Google, attaches details, flags invented places |
| `dateplanner/osm.py` | The keyless provider: OpenStreetMap venue search and data |
| `dateplanner/wiki.py` | Photographs and a line of context, from Wikipedia |
| `dateplanner/research.py` | The scouting pass: web search for what is actually on |
| `dateplanner/weather.py` | Forecast for those coordinates, golden hour, typed overrides |
| `dateplanner/affiliates.py` | Booking links and the commission model |
| `dateplanner/render.py` | Terminal text + a self-contained HTML page |
| `dateplanner/server.py` | The app: static shell, four endpoints, standard library only |
| `dateplanner/web/` | The installable app — page, manifest, service worker, icons |
| `tools/make_icons.py` | Regenerates the icons from code, so no opaque binaries |
| `config.toml` | Model, defaults, partner tags |

### Endpoints

| Route | Does |
|---|---|
| `GET /api/options` | The vocabularies, so the form's dropdowns have one source of truth |
| `GET /api/places?q=` | Location autocomplete |
| `GET /api/where?lat=&lon=` | Coordinates → neighbourhood name |
| `POST /api/plan` | Starts a plan, returns `202` with a job id |
| `GET /api/plan?job=` | Polls it: phase, elapsed, and the plan when it's done |

### Why planning is a background job

A full plan is a web search, two model calls and a rate-limited venue lookup
per stop — comfortably over a minute. Holding a request open that long risks a
timeout somewhere between the server and the browser, and, worse, shows the
user a spinner with nothing behind it. A spinner and a crash look identical.

So `POST /api/plan` starts the work on its own thread and returns a job id; the
page polls about once a second and shows the phase on the button: *Finding the
place → Searching for what's on → Building the route → Checking the places are
real → Fixing what didn't fit*. The phases come from `planner.PHASES` and are
reported by the planner itself, so they are what is actually happening rather
than a timed animation.

A dropped poll doesn't abandon the plan — the work continues on the server and
the page keeps asking. After four minutes it gives up with a real message.
Finished jobs are swept after fifteen minutes and wedged ones after five, since
the job table is keyed on user input in a long-lived process.

### The division of labour that makes this work

**The model has taste and cannot do arithmetic.** So taste lives in the prompt
and arithmetic lives in `rules.check()`: budget sums, clock continuity, walking
radius, sunset timing, door policy. A returned plan is re-tested against the
same rules it was given and the failures are shown to the user rather than
silently retried — a plan 8% over budget is usually still the plan you want.

`rules.py` holds both halves so they cannot drift apart: `brief()` renders the
rules into the prompt, `check()` re-tests them. Change a number once and both
move.

### The scouting pass

Before planning anything, a **researcher call searches the web** for what is
actually on: which places are open now and their current hours, what is
happening that specific night, which venues are currently well regarded rather
than historically famous, and anything that would ruin the evening — a closure,
a festival shutting the square, a venue that moved.

Those notes go into the planning prompt above the constraints, with an
instruction to prefer them over anything the model remembers. Without it the
planner recommends what was good whenever it was trained, with no idea the
restaurant shut in March.

**Why two calls and not one.** Web search always enables citations, and
citations are documented as incompatible with structured outputs. Attaching the
search tool to the structured planning call would be a gamble with no upside.
Split, the planning call keeps its byte-stable cached system prompt and its
guaranteed-parseable response, while the research call is free to be messy and
tool-using. A failed scouting pass degrades to planning from training data —
exactly where it started.

The sources are collected and shown under the plan, which the web search terms
require when search output is displayed, and which answers "how do you know
that" anyway.

Costs one extra call plus **$0.01 per search** (`max_searches = 6` by default),
counted separately in the cost line. `web_search = false` turns it off.

### The repair pass

When `check()` finds real problems, the plan is not simply handed over with a
warning attached — the specific violations go back to the model once, with the
draft, and it re-plans around them. Telling someone their evening is 40% over
budget is worse than fixing it.

The guarantee that makes this safe: **a repair is only kept if it leaves
strictly fewer problems.** Asking a model to fix four things is a good way to
get a fifth, so the corrected plan is re-checked and discarded if it did not
actually improve. A repair can never hand back something worse than the first
draft. Costs one extra call, only on the plans that need it; `repair = false`
in `config.toml` turns it off.

The system prompt is untouched on the second call, so the cached prefix still
hits — a repair costs roughly one brief, not two.

### Speed and cost

| | |
|---|---|
| Pre-model lookups, cold | ~900 ms (geocode + forecast) |
| Pre-model lookups, cached | ~0 ms |
| Cost per plan | printed by `--revenue`, alongside the commission estimate |

Re-planning is the common case — the UI invites tweaking one input and going
again — and each re-plan used to re-geocode the same city and re-fetch the same
forecast. `cache.py` holds place lookups for a day (coordinates don't move) and
forecasts for half an hour (short enough that no outdoor stop is planned
against a stale sky). Failures are never cached; a remembered outage lasts far
longer than a real one.

`--revenue` prints what a plan could earn *and* what it cost to generate,
because the first number means nothing without the second.

## Tuning it

Everything worth changing is in two places:

- `rules.STAGE_RULES` — stop counts, total hours, and the prose describing what
  each relationship stage needs. This has more effect on output quality than
  anything else in the repo.
- `planner.SYSTEM` — the voice and the standard. Expect to iterate on it.

`rules.BUDGET_TOLERANCE`, `models.MAX_HOP_MINUTES` and `planner.SPLIT` are the
next most useful knobs.

## Real places — no key required

**Without any API key at all**, the planner asks OpenStreetMap what is actually
around you and builds the evening from what comes back. In Boston that is:

```
16:30  New England Aquarium     Aquarium · 488 m away · Mo-Su 09:00-18:00
17:57  JJ Foleys Bar & Grille   Bar · 523 m away
19:29  Kaze                     Restaurant · japanese · Tu 17:00-02:00
```

Real names, real addresses, real hours, real websites. It used to say "a
specialist coffee bar or natural wine bar in a walkable part of town" — true,
useless, and it read like a computer because it was one describing a place it
had never heard of.

**The answers change the plan.** Say "aquarium" and the evening is built around
one; "jazz" gets live music; "art" gets a museum; rain keeps it indoors instead
of marching two people up a hill.

**Opening hours are a constraint, not a decoration.** The first Boston plan this
produced put the aquarium at 18:02–19:17 against a closing time of 18:00.
Whatever shuts first now goes first, dinner stays last, and anything that still
overruns gets flagged.

**Photographs**, from Wikipedia, for the stop notable enough to have an article
— which is usually the one carrying the evening's visual weight. The match is
verified against the article's own coordinates, not its name: "Chart House"
alone matches a chain on another continent.

The results page opens with a **route map**: OpenStreetMap tiles with a numbered
pin on each stop, so you can see the shape of the evening before reading a word
of it.

Each stop then carries what you actually want before deciding to walk
somewhere:

```
Restaurant · seafood · 916 m away
Address: 104 Avenida Almirante Reis, Lisboa
Hours:   Tu-Su 12:00-00:30
Site:    cervejariaramiro.com
[ Book ]  [ Open in Google Maps ]
```

The map link opens the **pin**, not a search for the name — because it carries
the venue's actual coordinates.

**This needs no API key.** The default provider is OpenStreetMap via Nominatim:
no account, no billing, works on a fresh clone.

### Optional: Google ratings

Set `GOOGLE_MAPS_API_KEY` (enable **Places API (New)** in a Google Cloud
project) and stops additionally show a star rating and review count, which
OpenStreetMap has no equivalent of. Everything else works identically without
it.

### The part that matters more than any of it

The lookup is also a **hallucination check**. The model is asked to name real
venues and mostly does, but "mostly" is the problem: an invented restaurant
looks exactly like a real suggestion right up until someone is standing outside
a building that was never there. Any venue stop that cannot be found on Google
Maps is now flagged in the plan, and — because the lookup runs *before*
`rules.check` — an unfindable venue is one of the problems the repair pass gets
told about and can replace.

Only business-like stops are checked (`places.VERIFIABLE`). A sunset walk has
no Google listing and never should, so flagging those would cry wolf on every
plan. A rating below 3.8 with at least 25 reviews is surfaced as a note, not a
veto: plenty of excellent places are badly rated by people who wanted something
else, so the user decides — we only make sure they saw the number.

### Things learned building this

**Overpass was the obvious choice and it did not work.** One request can fetch
every venue near a point, which beats one request per stop — but the public
instance answered in 28 seconds or returned 504, and two mirrors timed out
entirely. Nominatim is rate limited to one call a second and needs a request
per venue, but it answers in under a second and the app already depends on it.
Three stops cost about 3 seconds, behind a model call that takes longer.

**A placeholder User-Agent broke things silently.** `DateNight/0.1
(+https://example.com)` got HTTP 406 from Overpass's front end before the query
was parsed. Nominatim's policy asks for a UA that identifies the app; the
parenthetical fake URL was doing the opposite. It is plain text now.

**`bounded=1` with a viewbox is not optional.** Without it, searching "Ramiro"
from Lisbon happily returns a Ramiro in Brazil, and the plan would be
"verified" against a venue on another continent.

**Nominatim's rate limit is per service, not per endpoint.** Venue lookups and
reverse geocoding share one gate in `geo.nominatim_wait()`. Don't add a second.

### Terms, where they apply

- **OpenStreetMap:** tiles and data require attribution. The map carries
  "© OpenStreetMap"; don't remove it. Keep tile use light — this draws a
  handful per plan.
- **Google (only if you set a key):** billed per request, ~3–4 per plan. Place
  IDs may be stored indefinitely, other place content may not, so that cache is
  in-process, one hour, never written to disk. Displaying their ratings
  requires visible "Google Maps" attribution and a route back to Maps; the
  footer carries it and the Map button links to the place.

## Money

A finished itinerary is the highest-intent moment in the whole
dining-and-activity funnel: someone has just decided they are going out on
Saturday and is looking at a named venue. Every stop ships with a booking link,
routed by stop kind — reservations to OpenTable, anything ticketed to
Viator/GetYourGuide, live music to DICE, free stops to a map.

```bash
python run.py -l "Lisbon" -b 140 --revenue
```

```
Affiliate estimate (ceiling - assumes every link converts)
  A specialist coffee bar or natural wine bar    opentable     EUR 2.00
  Dinner at a mid-sized neighbourhood restaura   opentable     EUR 2.00
  A late bar with live music in Lisbon           dice          EUR 3.50
                                                 total         EUR 7.50
```

Two rules kept honest in `affiliates.py`:

- **No invented partner tags.** An empty tag in `config.toml` produces a clean
  search link with no tracking parameters. A fabricated one does not earn
  money — it breaks the link and can get the account closed.
- **Commission is estimated, never asserted.** `--revenue` assumes every link
  is followed and converts, which is the ceiling, not the forecast. Real attach
  rates on this kind of product are a few percent. Multiply before believing.

Published rates drift; they live in one dict (`affiliates.PROVIDERS`) so they
are cheap to re-check.

## Things already learned the hard way

**Open the app at `http://127.0.0.1:8765`, not by opening `index.html`.** The
page is half the app; the planner, geocoder and forecast all live in the Python
server. Opening the file directly — or looking at an editor's preview of it,
which renders as a `data:` URL — gives you a page that looks completely normal
and fails on the first click. The page now detects any non-`http(s)` origin and
says so, because "Failed to fetch" names none of it. Same for a tab left open
after the server stopped: the error names the port it tried.

**Thinking tokens count against `max_tokens`.** Opus 5 has thinking on by
default, so the original 8000 risked truncating a five-stop itinerary
mid-sentence. It is 16000 now, and a `max_tokens` stop reason is treated as a
failure that falls back to the offline planner — half an evening is worse than
an honest template.

**`cache_read_input_tokens` is the canary.** If it stays zero across repeated
plans, something is varying in the system prompt and every request is paying
full price for it. `--revenue` prints it.

**Open-Meteo needs no key**, which is why it is here — anyone can clone this and
run it. It does forward geocoding and the forecast; it has no reverse endpoint,
which is why "use my location" goes to Nominatim instead. The free forecast
horizon is 16 days; past that the app says "unknown" rather than inventing a
summary.

**Reverse-geocode at zoom 14.** Zoom 10 gives you the whole city and zoom 18
gives you the building you are standing in. Neither helps pick a bar; 14 lands
on the suburb/neighbourhood, which is the unit a date is planned in.

**A secure context is not optional for the app features.** Service workers and
`navigator.geolocation` both need `localhost` or HTTPS. Over a LAN address on
plain HTTP they simply do not run. The page checks `window.isSecureContext` and
tells the user which of the two they are in, because the silent version of this
failure costs an hour of debugging.

**Sunset is the field that earns its keep.** "Sunset walk" is only an
instruction if you know when sunset is. `weather.golden_hour()` is passed to the
model as an explicit window, and `rules.check()` flags a viewpoint stop that
starts after dark — the most common way this kind of plan quietly fails.

**A typed weather override needs keyword parsing.** Someone who types "steady
rain" means the plan should move indoors, but a typed summary carries no
precipitation number, so without `weather.parse_override()` nothing downstream
would ever notice.

**`truststore.inject_into_ssl()` must run before importing `requests`.** On a
machine with TLS-inspecting antivirus, every outbound call fails certificate
verification otherwise. Handled at the top of `dateplanner/http.py` — keep that
import order.

**Windows consoles default to cp1252** and an itinerary is full of things it
cannot encode: the arrow between stops, and every accented venue name in Europe.
`run.py` reconfigures stdout to UTF-8 before printing anything.

**The offline planner builds long and trims afterwards**, because which stop to
cut depends on how the others landed. It cuts the last stop first — that one is
optional by construction, and cutting the closer always beats rushing dinner.

## Conventions

- Four dependencies. `anthropic`, `pydantic`, `requests`, `truststore`. The web
  UI is standard library on purpose: one page and one route do not justify a
  framework.
- Everything works with `--dry-run` and no API key.
- A failed forecast degrades the plan; it never kills the request. `get_json()`
  returns `None` rather than raising.
- A failed model call falls back to the offline planner rather than erroring.
- Tests are offline: no network, no key, no spend. Keep it that way — every test
  supplies its own weather.
- Comment *why*, not *what*.

## Status

**The static app has been driven end to end in a browser**, served from a
subpath to imitate `you.github.io/kindling/`. Ten screens, Boston, walking,
about eleven seconds: three stops anchored on the New England Aquarium, a real
bar, live music, four map tiles, a verified photograph, no warnings, no errors
in the console. Location autocomplete, "use my location" (`38.7139, -9.1289` →
"Alfama, Lisboa"), the forecast, the rule checks, last-plan restore after a
reload and the mobile layout all work against the live services.

Before the port, each of the five cross-origin calls was tested from a
third-party origin rather than assumed: Nominatim search and reverse,
Open-Meteo geocoding and forecast, and Wikipedia with `origin=*`. All five
answer a browser directly.

**Unverified: the service worker and the install prompt.** The browser
available here blocks service-worker registration outright — registering *any*
path, including one that does not exist, fails identically — so offline
caching and the Android install banner have never actually run. The code is
conventional and the assets are wired correctly, but treat the first install as
untested. Everything that does not depend on a service worker, including
offline last-plan restore, works.

**Unverified: the model stage has never made a real API call** — no credentials
existed in the environment where it was built, which is also why it is the
Python side and not the published app. The request shape follows the current
SDK and is asserted against a stub (`test_model_request`), and the response
maps cleanly into `Plan`, but the first live run is still the first live run.
Expect to spend an afternoon on `planner.SYSTEM` after seeing real output; that
prompt is the product and nobody gets it right first try. The scouting pass and
the optional Google-ratings path are untested for the same reason.

407 Python tests pass, offline, with no key and no spend.

---

## Licence

MIT - see [LICENSE](LICENSE). The copyright line says "Youssef"; replace it
with the name you want on it before anyone else reads the repo.
