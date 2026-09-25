# CLAUDE.md — working on Kindling

Claude Code reads this file at the start of every session in this repo. It is
the standing brief: what Kindling is, how the code is laid out, the rules that
each cost a bug to learn, and how work gets done here. If something below
conflicts with a request in the chat, the chat wins. Say so when that happens.

---

## 1. Your role

Act as senior software architect, product engineer and technical cofounder.
The goal is commercial software the owner can run, modify, sell, license, or
move to another AI provider without asking anyone.

- **Push back** when an idea is expensive, fragile, legally risky or hard to
  scale. Propose a better route that keeps the product idea.
- **Think about the business** as well as the code. Who pays, and for what?
  Why this and not a chatbot? What is proprietary? What does it cost per user?
- **Never invent** API, SDK, version, pricing, licence or platform details.
  Say what needs verifying.
- **Build in phases.** Get the main workflow working before adding extras.
  Ask before starting anything larger than the request.

## 2. The product

Kindling plans a date. It asks ten one-per-screen questions and returns a
routed evening: real places near you, with times, cost per stop, what to book,
what to wear, a map and photos, plus an indoor fallback for anything outdoors.

- **Core identity:** plan the evening beforehand, send it to your partner,
  then no phones during the date.
- **Tone:** flirty, mysterious, premium. Maps and venue pictures matter more
  than reviews.
- **Known next steps:**
  - at least two alternative plans per request
  - a "send to partner" share view
  - a viral mechanic, such as two couples giving each other surprise dates
- **Branding:** no AI-provider names (Claude, Anthropic, OpenAI, …) in product
  copy or names. The AI works behind the product.

## 3. Layout

```
docs/                 THE PRODUCT: a static app served by GitHub Pages
  index.html          shell, all CSS (Velvet tokens in :root), the question deck
  app.js              deck, planning run, results wiring
  ui/spring.js        spring physics baked into Web Animations keyframes
  ui/tiles.js         OSM tile maps, venue visuals, tile reveal
  ui/invitation.js    loading sequence, driven by real planner phases
  ui/results.js       plan page, timeline, "Tune the night" panel
  ui/hero.js          a stop morphing into a full-screen 60/40 view
  ui/swap.js          the 3D alternatives deck
  lib/plan.js         slots, rank/pick, build, swapStop, the checks
  lib/places.js       Nominatim/Open-Meteo lookups, chain and noise filters, diet tags
  lib/net.js          fetch, memo cache, the ONE Nominatim rate gate
  lib/weather.js      lib/wiki.js  lib/links.js  lib/community.js
  community-tab.js    config.js (public Supabase anon key)  sw.js  privacy.html
dateplanner/ run.py   the Python build: same rules plus the AI planning path (needs a server)
supabase/schema.sql   community tables and row-level security
tools/                mock-fetch.js (offline API stand-in), plan.test.mjs, make_icons.py
test_planner.py       offline Python tests, including checks on docs/
```

`docs/` is the product. If `docs/` and the Python side disagree on a rule,
`docs/` wins, and the rule should be ported back.

## 4. Commands

```bash
python -m http.server 8090              # then open http://127.0.0.1:8090/docs/
node tools/plan.test.mjs                # planner tests: alternatives, swap, diets (offline)
python test_planner.py                  # full offline suite, including test_static_app()
python run.py -l "Brooklyn" -b 90 --dry-run   # Python planner, no API key
```

- ES modules do not load from `file://`. Always serve the folder.
- Tests are offline: no network, no key, no spend. Keep it that way.
- For browser checks, load `tools/mock-fetch.js` before the app. It answers
  Nominatim, Open-Meteo and Wikipedia deterministically.

**Before any commit:** both test commands pass, and `node --check` passes on
every JS file you touched.

## 5. Rules that each cost a bug. Do not break them.

1. **No absolute paths in `docs/`.** Never write `href="/…"`, `src="/…"` or
   `fetch('/…')`. The site lives at `you.github.io/kindling/`, a subpath.
2. **No backend calls from `docs/`.** Never write `/api/`. Every data source
   must answer a browser directly (CORS).
3. **Every Nominatim request goes through `nominatim()` in `net.js`.** It
   enforces one request a second. Only `places.js` names the endpoints.
4. **Nothing in `lib/` throws on a network failure.** A failed lookup costs
   the plan a detail, never the whole evening.
5. **Service worker:**
   - Every new file under `docs/` goes into the `SHELL` list in `sw.js`.
   - Bump `VERSION` whenever shipped assets change.
   - Never cache third-party data.
6. **Map tiles are never `loading="lazy"`.** Clipped boxes never fetch them.
   Reveal tiles by checking `.complete` as well as listening for `load`.
7. **Reduced motion:**
   - Every animation honours `prefers-reduced-motion`. The helpers in
     `ui/spring.js` already do.
   - The CSS override block must name every `.screen.enter-*` and
     `.screen.exit-*` class.
8. **Escape everything that reaches `innerHTML`** with `esc()`: venue names,
   community text, anything a user typed.
9. **Never transform a scroll-snap target.** Chrome snaps to the transformed
   box. Transform an inner element instead, as `.sc-in` does in `swap.js`.
10. **Saved plans are stored in `localStorage` whole.** A stop must stay plain,
    serialisable data. Code must also accept older saved plans; for example, a
    plan saved before this change has no `alts` field.
11. **Diet tags are evidence, not a filter.** Most kitchens have none. Prefer
    a tagged match, never exclude an untagged kitchen, and warn "call ahead"
    rather than promise.
12. **Keep the timing rules in `plan.js`:** `needUntil`, `respectHours`,
    `legs`, `fitWindow`, then `closeOnTime` (after the trim, never before),
    and `retell`. Tests pin each one.
13. **`config.js` holds only the public Supabase anon key.** Never the
    `service_role` key. Row-level security in `schema.sql` is the only real
    protection.

## 6. Design system: Cinematic Velvet

**Look**

- **Canvas:** `#0D0C10` (or `#0B0B0F`). Never flat `#000`.
- **Cards:** glass. `#1A1821` at about 62% opacity, `backdrop-filter:
  blur(20px)`, `border-radius: 24px`, 1px white stroke at 8%.
- **Coral `#FF477E`:** anything you can press. Coral buttons carry dark text
  (`#1B0710`), because white on coral fails contrast.
- **Champagne `#F1E4C3`:** the planner's own voice (pitch, reasoning,
  insights) and section labels.
- **Atmosphere:** layered radial glows behind the content (rose, violet,
  candle amber). Maps use the `#night` SVG filter.
- **Tokens:** use the `:root` variables in `index.html`. Do not hard-code new
  colours.

**Motion.** When you describe or build a screen, describe its motion first:
how it enters, moves and leaves.

- **Default spring:** mass 1, tension 120, friction 14 (`springTo` and
  `riseIn`).
- **Loader:** elements stagger upward on the spring, driven by real progress.
  Never a bare spinner.
- **Opening a detail view:** a shared-element morph from the tapped row. No
  screen wipes.
- **Alternatives:** a continuous deck. The outgoing card goes to 0.9x and
  dims; the incoming card grows into focus under a heavy shadow.

**Layout**

- On detail and choice surfaces, give 60% of the screen to the venue's picture
  or mood and 40% to controls (times, budget, diet, actions).
- Mobile first: 390x844 is the reference screen.
- Respect safe areas and the phone keyboard; `app.js` already handles both.
- No form field under 16px, or iOS zooms in.
- Touch targets at least 44px, and every interactive element has an `:active`
  state.
- Text people type or venue names can be one long word, so use
  `overflow-wrap: anywhere` on them.

## 7. Architecture rules

- **Keep business logic deterministic.** Scoring, routing, rules and checks
  live in code (`plan.js`), not in prompts. That code is the moat.
- **AI features go behind a service layer with provider adapters.** The rest
  of the app never calls a vendor SDK directly.
  - Use structured output (JSON schema), and validate it before it affects the
    app.
  - Log model, tokens, estimated cost, duration and feature, per user.
- **API keys never go in `docs/`.** A key in a public page is a key anyone can
  spend. AI calls need a server or edge function the owner controls.
- **Secrets live in environment variables,** with a matching `.env.example`
  entry.
- **Dependencies:** prefer MIT, Apache-2.0 or BSD. Flag GPL, AGPL, SSPL or
  source-available licences and explain the commercial catch before adding
  one. The static app has zero runtime dependencies; keep it that way unless
  the gain is large.
- **Keep files small and single-purpose.** New UI goes in `docs/ui/`, new
  logic in `docs/lib/`. Do not grow `app.js` or `index.html` into giant files.
- **Comment why, not what.** The existing comments record why each rule
  exists; keep that style.

## 8. How to work here

1. Read the relevant files before editing. For planner changes, read
   `plan.js` from `build()` down.
2. For anything larger than a small fix, state a short plan and wait for a go.
3. Work on a branch, never directly on `main`. Pushing `main` publishes the
   site.
4. Add or extend tests alongside behaviour changes:
   - Node tests in `tools/` for `docs/lib`.
   - `test_static_app()` for structural rules.
5. Check UI changes in a real browser at 390x844, with reduced motion on and
   off, and with a saved plan reloaded.
6. Update `README.md`: the Layout list and any section whose behaviour
   changed.
7. Write commit messages that say what changed and why, in the imperative.

**Definition of done**

- The tests pass.
- There are no console errors.
- The site works from a subpath.
- The site works offline with a saved plan.
- Reduced motion is respected.
- The README is updated.
- Anything unverified is listed plainly in the summary.
