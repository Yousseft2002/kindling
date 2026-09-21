# Date planner

Seven inputs in, one evening out — with real venues, a map of the route, and
a check that the places actually exist. No API key needed for any of that.

```
sunset walk  →  photography spot  →  tasting menu  →  jazz bar
```

Not a list of recommendations — a route, with start times, costs per stop, what
to book and when it gets released, what to wear, and what to do if it rains.

```bash
python run.py --location "Lisbon" --budget 140 --currency EUR \
              --interests "jazz,photography" --stage dating
python run.py --serve          # the app, on http://127.0.0.1:8765
python run.py --serve --lan    # same, reachable from your phone
```

---

## Quickstart

```bash
pip install -r requirements.txt
python test_planner.py                           # 325 offline tests, no key, no spend
python run.py -l "Brooklyn" -b 90 --dry-run      # a real plan, zero API cost
python run.py --serve                            # the app
```

## The API key

**Without a key every plan is a generic template** — "a specialist coffee bar in
a walkable part of town" rather than a named venue. Everything else (location
search, weather, timing, budget split, rules, booking links, the whole app)
works either way, which is exactly what makes this confusing: the keyless
output looks like a bad answer rather than like a missing credential.

Two ways to set it. Get a key at
[console.anthropic.com](https://console.anthropic.com/settings/keys).

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

That makes one tiny request and tells you whether the key is missing, invalid,
out of credit, or fine. It prints the key's length and its `sk-ant-` prefix so
you can spot a truncated paste, and never the key itself.

The app warns about this too: with no key on the server, the page shows a
banner *before* you plan anything, rather than letting you read four generic
stops and conclude the app is broken.

`.env` is gitignored. A real environment variable always beats the file, so
`ANTHROPIC_API_KEY=... python run.py` works as expected.

## The app

`python run.py --serve` is an installable web app, not just a page.

It asks **one question per screen** — ten of them, in the order a person
actually thinks about an evening — rather than presenting a form with fourteen
fields. Each screen is a single large question, centred, with the button pinned
under your thumb. Picking a relationship stage or a dress code both answers and
advances, so most of the flow is one tap per screen.

Notes on the build, since a few things are load-bearing:

- **The stage animates to the height of the active screen**, so the button
  glides rather than jumps. `measure()` recomputes on every transition and
  whenever content changes size (the autocomplete opening, option cards
  arriving).
- **`.wrap` has a fixed height, not a minimum.** Flex children only shrink
  inside a constrained container; with `min-height` the long option lists
  pushed the button off the bottom instead of scrolling inside the deck. The
  results page is arbitrarily long, so `body.done` relaxes it again.
- **`margin:auto` centres the stage, not `align-items:center`** — centring a
  flex child taller than its container clips the top off in every browser, and
  five option cards are taller than a phone.
- **All motion is decoration, never information.** `prefers-reduced-motion`
  collapses every transition, and the auto-advance fires immediately instead of
  after a beat. Every screen is reachable and readable with all of it off.
- Display type is Fraunces from Google Fonts, with Georgia and the system
  serif behind it. The app already needs the network for the forecast and the
  planner, so a webfont costs nothing extra — and it degrades to the fallback
  cleanly if the request fails.

**On this machine:** open `http://127.0.0.1:8765` in Chrome or Edge and use
the install button in the address bar, or the banner the app shows. It gets a
window, a dock/taskbar icon, and opens straight to your last plan.

**On your phone:** `python run.py --serve --lan` prints a `http://192.168.x.x:8765`
address to open on the same wifi.

> **The catch, stated plainly:** service workers and the browser's geolocation
> API both require a *secure context*, which means `localhost` or HTTPS. A LAN
> address over plain HTTP is neither. So on your phone the app works as a web
> page, and iOS "Add to Home Screen" still gives you a full-screen icon, but
> you will not get the Android install prompt, offline caching, or the "use my
> location" button — type the location instead. The page detects this and says
> so rather than failing silently. To get the full thing on a phone, put it
> behind HTTPS (a tunnel like `cloudflared` is the least painful route).

Offline, the app still opens and shows your last plan from `localStorage` —
which is the actual failure case, standing outside a bar with one bar of signal
trying to remember which street the next stop is on. It will not plan a *new*
date without signal, and says so.

The icons are generated, not hand-drawn: `python tools/make_icons.py`.

## The seven inputs

| Input | What it actually changes |
|---|---|
| **location** | Resolved to coordinates, which go into the prompt with a radius. This is what makes suggestions local rather than city-generic. |
| **budget** | A hard cap, split across stops by stage. Checked against the arithmetic afterwards. |
| **relationship stage** | The biggest lever. Changes stop count, total length, and whether a reservation is a compliment or a trap. |
| **clothing style** | Filters venues by door policy. A plan that gets you turned away is a failed plan. |
| **weather** | Fetched from Open-Meteo, or typed. Decides indoor/outdoor and forces a named fallback for every exposed stop. |
| **interests** | At least two stops must connect to them — specifically, not "a museum because they said art". |
| **transportation** | Sets the radius. Walking means 15 minutes between stops; transit means one line; car means parking is a real constraint. |

Plus the ones a time-ordered itinerary can't do without: the date, the start
time, roughly how long, and a free-text note for dietary limits, mobility, or
anything to avoid.

### Location, specifically

Two ways in, both ending at coordinates:

- **Type it.** The field autocompletes against Open-Meteo's geocoder as you
  type; picking a result attaches its coordinates. This is how you tell Alfama
  in Lisbon from Alfamén in Aragon, which the picker will happily offer you
  both of.
- **Tap the pin.** The browser hands over GPS coordinates, and `geo.reverse()`
  turns them into a neighbourhood name via Nominatim — `38.7139, -9.1289`
  comes back as "Alfama, Lisboa".

Coordinates matter more than the name. They go into the prompt as an explicit
anchor with a radius set by the transport mode — 1.5 km walking, 12 km by car
(`models.RADIUS_KM`) — along with an instruction to name the neighbourhood each
stop is in and to avoid the city's famous places if they are on the other side
of town. A plan anchored on a point is local; one anchored on the string
"London" is a guess about which part.

They also pin the forecast to the same point the date happens at, rather than
to whatever the geocoder thought "London" meant.

Neither service needs an API key, so a clone of this repo runs as-is. Nominatim
asks for a descriptive User-Agent and at most one request a second; `geo.py`
enforces both. Don't remove that — it is the price of a free service.

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
| `dateplanner/osm.py` | The keyless provider: OpenStreetMap venue data |
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

Every venue the planner names is looked up in real map data, and the results
page opens with a **route map**: OpenStreetMap tiles with a numbered pin on each
stop, so you can see the shape of the evening before reading a word of it.

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

Verified working, in a browser against live services: location autocomplete,
"use my location" (reverse geocoding `38.7139, -9.1289` → "Alfama, Lisboa"),
coordinates reaching the prompt with a radius, the Open-Meteo forecast, the
rule checks, the offline planner, last-plan restore after a reload, the CLI,
the HTML output, and the mobile layout. 148 tests pass.

**Unverified: the service worker and the install prompt.** The browser
available here blocks service-worker registration outright — registering *any*
path, including one that does not exist, fails identically — so offline
caching and the Android install banner have never actually run. The code is
conventional and the assets are wired correctly (`test_app_shell` checks the
manifest, the icons it declares, and the precache list), but treat the first
install as untested. Everything that does not depend on a service worker,
including offline last-plan restore, works.

**Unverified: the model stage has never made a real API call** — no credentials
existed in the environment where it was built. The request shape follows the
current SDK and is asserted against a stub (`test_model_request`), and the
response maps cleanly into `Plan`, but the first live run is still the first
live run. Expect to spend an afternoon on `planner.SYSTEM` after seeing real
output; that prompt is the product and nobody gets it right first try.
