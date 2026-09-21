"""The judgment stage: turn preferences into an actual evening.

`SYSTEM` is the taste. `rules.brief()` is the constraint set. The system prompt
is cached, so it must stay byte-identical between runs - everything that varies
per request goes in the user message.

The app runs without an API key, and not as a degraded demo: `_offline_plan`
asks OpenStreetMap what is actually around the user and composes an evening
out of real, named places - drinks at a real bar, the New England Aquarium,
dinner at a real restaurant. It reads the opening hours it gets back and
orders the night around them, because an aquarium that shuts at six is a
constraint and not a detail.

What it cannot do without the model is judgement: why *these* two people
should go *there*, in that order, on that night. That is what the key buys.
"""

from __future__ import annotations

import logging
import os
from datetime import date, time, timedelta

import anthropic

from . import affiliates, geo, osm, places, research as scout, rules, weather as wx, wiki
from .models import Plan, Prefs, Stop, Usage, Weather

log = logging.getLogger(__name__)

SYSTEM = """You plan dates. Not "romantic experiences" - dates, the kind a \
well-connected local friend sketches on a napkin when you tell them who you are \
seeing and how much you can spend.

What separates a plan someone actually follows from one they skim and forget:

SEQUENCE. A date is a route with an arc, not a list of good places. Each stop \
should make the next one better: something to look at before something to talk \
about, something to talk about before something to sit down with. Energy climbs \
toward the middle and settles at the end. The walk between two stops is part of \
the date - say what they will pass.

SPECIFICITY. Name real places. The restaurant, the bar, the overlook, the corner \
of the park where the light lands. "A cosy wine bar" is not a plan, it is a \
horoscope. If you are not confident a specific venue exists and is open, name the \
street, market, or park and say what to look for when they arrive - an honest \
pointer beats a confident invention. Flag anything you suspect may have closed.

LOGISTICS, because this is what actually ruins evenings. Reservations and when \
they are released. Last entry. When the kitchen stops. How long the queue is at \
8pm on a Saturday. Which entrance. Whether the last train is a problem. Where to \
park and what it costs. One concrete tip per stop that someone who has been there \
would know and a listing site would not.

A REASON PER STOP, tied to these two people. Not what the venue is - why it is \
right for them, here, at this hour. If you cannot say why a stop is there, it is \
filler; cut it and make the others better.

Things that make a plan worse, all common, all avoidable:
- Treating the budget as a suggestion. It is the hardest constraint you have.
- Front-loading the expensive or high-commitment stop.
- Scattering four excellent places across a city that has no route through them.
- Planning for a generic couple rather than the stage of relationship stated.
- Filling every minute. Leave slack; the good part of a date is usually the part \
that ran long.
- Brochure voice. Never write nestled, hidden gem, vibrant, bustling, culinary \
journey, iconic, must-visit, or "perfect for". Write the way you would text a \
friend: direct, specific, a little opinionated, no adjective the place has not \
earned.

On uncertainty: you do not know today's opening hours, prices, or whether a place \
survived the year. Say "check" where checking matters, and put the checkable thing \
in the booking field. Confident wrong details are the one failure a user cannot \
recover from.

Costs are for two people, in the stated currency, at realistic local prices \
including tax and tip where customary. A stop that is genuinely free costs 0; do \
not pad.

Every venue you name is looked up in map data after you answer, and any that \
cannot be found is shown to the user as a place you may have invented. So name \
the ones you are actually confident exist, and fall back to a street, park or \
market when you are not - an honest pointer costs nothing, a confabulated \
restaurant costs someone their evening.

Return every field. Leave book_url, map_url, provider, rating, ratings_count, \
address, verified, looked_up, sources, warnings and generated_by blank - those are filled \
in locally after you answer."""


def _next_saturday(today: date | None = None) -> date:
    today = today or date.today()
    ahead = (5 - today.weekday()) % 7 or 7  # Monday is 0; always the *next* one
    return today + timedelta(days=ahead)


def resolve(prefs: Prefs) -> tuple[Prefs, Weather]:
    """Fill in the defaults that need computing, and get a forecast.

    An explicitly supplied `prefs.weather` always wins - the user typing
    "it will be raining" beats a forecast for a city we may have geocoded to
    the wrong continent.
    """
    if prefs.on is None:
        prefs.on = _next_saturday()
    if prefs.start_time is None:
        prefs.start_time = time(17, 0)

    # Resolve the location to a point. Worth the call even when a forecast is
    # not needed: coordinates in the prompt are what make the suggestions local
    # rather than generic, and they settle which of the thirty Springfields is
    # meant. A failed lookup is survivable - the name alone still plans a date.
    if not prefs.has_coords:
        place = geo.first(prefs.location)
        if place is not None:
            prefs.lat, prefs.lon = place.lat, place.lon
            if place.detail and place.detail.lower() not in prefs.location.lower():
                # "Alfama" typed, "Alfama, Lisboa, Portugal" understood.
                prefs.location = f"{place.label}, {place.detail}"
        else:
            log.warning("planner: could not place %r - planning on the name alone", prefs.location)

    if prefs.weather is not None:
        w = prefs.weather
        if w.source == "unknown":
            w.source = "manual"
        return prefs, w

    w = wx.forecast(prefs.location, prefs.on, prefs.lat, prefs.lon)
    prefs.weather = w
    return prefs, w


def _user_message(prefs: Prefs, w: Weather, notes: str = "") -> str:
    gh = wx.golden_hour(w)
    when = prefs.on.strftime("%A %d %B %Y") if prefs.on else "Saturday"
    start = prefs.start_time.strftime("%H:%M") if prefs.start_time else "17:00"

    lines = [
        f"Plan a date in {prefs.where()}.",
        "",
        f"When: {when}, starting around {start}, running about {prefs.hours:g} hours.",
        f"Forecast: {w.brief()}" + ("" if w.is_known else " (no forecast available - plan for it either way)"),
    ]
    if gh:
        lines.append(
            f"Golden hour runs {gh[0].strftime('%H:%M')}-{gh[1].strftime('%H:%M')}. "
            f"Any viewpoint or outdoor stop belongs inside that window, not after it."
        )
    if prefs.has_coords:
        # The whole point of collecting coordinates. Without this the model
        # answers for the city and you get the famous places on the far side
        # of it; with it you get the street you are standing on.
        lines.append(
            f"Anchor every stop within {prefs.radius_km:g} km of those coordinates and name the "
            f"neighbourhood each one is in. Suggest places that are genuinely in that area - its "
            f"own streets, venues and landmarks - not the city's best-known ones somewhere else."
        )

    if notes:
        # The scout's findings go above the constraints: they are what make the
        # plan current rather than remembered, and the model should treat them
        # as better evidence than anything it recalls.
        lines += [
            "",
            "A local scout searched the web for you just now and found this. Prefer these "
            "places over anywhere you remember, and do not contradict what they found about "
            "hours or closures - if the notes say something is shut or unverifiable, believe "
            "them. You may still add a stop they missed if you are confident it exists.",
            "",
            notes,
        ]

    lines += [
        "",
        "Constraints, in priority order:",
        rules.brief(prefs, w),
        "",
        "Build the evening. Three to five stops.",
    ]
    return "\n".join(lines)


def _client() -> anthropic.Anthropic | None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    return anthropic.Anthropic()


# USD per million tokens, from the Anthropic pricing table. Cache writes bill
# at about 1.25x the input rate and cache reads at about 0.1x, which is the
# whole reason the system prompt is a cached block.
PRICING = {
    "claude-opus-5": (5.00, 25.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-4-5": (1.00, 5.00),
}
CACHE_WRITE_MULTIPLIER = 1.25
CACHE_READ_MULTIPLIER = 0.10


def _usage_of(response, model: str) -> Usage:
    """Token counts and an estimated cost for one response."""
    u = response.usage
    read = getattr(u, "cache_read_input_tokens", 0) or 0
    write = getattr(u, "cache_creation_input_tokens", 0) or 0
    plain = u.input_tokens or 0
    out = u.output_tokens or 0

    in_rate, out_rate = PRICING.get(model, PRICING["claude-opus-5"])
    cost = (
        plain * in_rate
        + write * in_rate * CACHE_WRITE_MULTIPLIER
        + read * in_rate * CACHE_READ_MULTIPLIER
        + out * out_rate
    ) / 1_000_000

    return Usage(calls=1, input_tokens=plain, output_tokens=out,
                 cache_read_tokens=read, cache_write_tokens=write,
                 cost_usd=round(cost, 6))


PHASES = {
    "locating": "Finding the place",
    "forecast": "Checking the forecast",
    "scouting": "Searching for what's on",
    "planning": "Building the route",
    "verifying": "Checking the places are real",
    "repairing": "Fixing what didn't fit",
    "done": "Done",
}


def plan(prefs: Prefs, cfg: dict | None = None, progress=None) -> Plan:
    """Preferences in, finished itinerary out. Never raises: a failed model
    call falls back to the offline planner so the user always gets something.

    `progress(phase)` is called as each phase starts. A full plan can take a
    minute and a half - a web search, two model calls and a rate-limited venue
    lookup per stop - and a spinner with nothing behind it is indistinguishable
    from a hang. The phases are named in PHASES.
    """
    cfg = cfg or {}
    llm = cfg.get("llm", {})
    say = progress or (lambda phase: None)

    say("locating")
    prefs, w = resolve(prefs)

    p: Plan | None = None
    usage = Usage()
    client = _client() if llm.get("enabled", True) else None

    notes = ""
    sources: list = []
    if client is None:
        log.warning("planner: no ANTHROPIC_API_KEY (or llm disabled) - using the offline planner")
    else:
        # Scout first, plan second. A failed scouting pass is survivable: the
        # plan is then built from training data, which is where it started.
        if llm.get("web_search", True):
            say("scouting")
            found = scout.gather(client, prefs, w, llm, usage)
            if found is not None:
                notes, sources = found.notes, found.sources
            else:
                log.warning("planner: scouting pass failed - planning without it")
        say("planning")
        p = _model_plan(client, prefs, w, llm, usage, notes=notes)

    if p is None:
        p = _offline_plan(prefs, w)

    # Resolve the named venues against map data before the rules run, so
    # "this place does not seem to exist" is one of the things a repair pass
    # gets told about and can fix.
    verify = cfg.get("places", {}).get("enabled", True)
    if verify:
        say("verifying")
        places.enrich(p, prefs)

    warnings = rules.check(p, prefs, w)

    # One correction pass. The model is good at taste and bad at arithmetic,
    # so rather than presenting someone with a plan 40% over budget and a note
    # saying so, hand the arithmetic back and let it re-plan around it.
    if client is not None and p.generated_by == "model" and warnings and llm.get("repair", True):
        say("repairing")
        p, warnings = _repair_loop(client, prefs, w, llm, p, warnings, usage, verify, notes)

    affiliates.attach(p, prefs.location, cfg)
    p.warnings = warnings
    p.sources = [s.as_dict() for s in sources]
    p._usage = usage
    if usage.calls:
        log.info("planner: %s", usage.brief())
    say("done")
    return p


def _repair_loop(client, prefs: Prefs, w: Weather, llm: dict, p: Plan,
                 warnings: list[str], usage: Usage, verify: bool = True,
                 notes: str = "") -> tuple[Plan, list[str]]:
    """Send the rule violations back until they stop improving.

    A repair is only accepted when it leaves strictly fewer problems, so this
    can never hand back something worse than the first draft - which matters,
    because asking a model to fix four things is a good way to get a fifth.
    """
    for _ in range(max(0, int(llm.get("max_repairs", 1)))):
        fixed = _model_plan(client, prefs, w, llm, usage, repair_of=(p, warnings), notes=notes)
        if fixed is None:
            break
        # The corrected plan has to be checked the same way as the draft, or
        # the two warning counts are not comparable and a repair could be
        # accepted purely because it skipped a check.
        if verify:
            places.enrich(fixed, prefs)
        fixed_warnings = rules.check(fixed, prefs, w)
        if len(fixed_warnings) >= len(warnings):
            log.info("planner: repair did not improve on %d problem(s), keeping the draft",
                     len(warnings))
            break
        log.info("planner: repair fixed %d of %d problem(s)",
                 len(warnings) - len(fixed_warnings), len(warnings))
        fixed.repaired = True
        p, warnings = fixed, fixed_warnings
        if not warnings:
            break
    return p, warnings


def _model_plan(client, prefs: Prefs, w: Weather, llm: dict, usage: Usage,
                repair_of: tuple[Plan, list[str]] | None = None,
                notes: str = "") -> Plan | None:
    model = llm.get("model", "claude-opus-5")
    content = (_user_message(prefs, w, notes) if repair_of is None
               else _repair_message(prefs, w, *repair_of, notes=notes))
    try:
        response = client.messages.parse(
            model=model,
            max_tokens=int(llm.get("max_tokens", 16000)),
            system=[{
                "type": "text",
                "text": SYSTEM,
                "cache_control": {"type": "ephemeral"},
            }],
            output_config={"effort": llm.get("effort", "high")},
            messages=[{"role": "user", "content": content}],
            output_format=Plan,
        )
    except anthropic.APIStatusError as e:
        log.error("planner: HTTP %s from the API: %s", e.status_code, e.message)
        return None
    except anthropic.APIConnectionError as e:
        log.error("planner: could not reach the API: %s", e)
        return None

    if response.stop_reason == "refusal":
        log.error("planner: the model declined this request")
        return None
    if response.stop_reason == "max_tokens":
        # The plan is truncated and will be missing stops. Better to fall back
        # than to hand someone half an evening.
        log.error("planner: hit max_tokens (%s) - raise llm.max_tokens in config.toml",
                  llm.get("max_tokens", 16000))
        return None

    usage.add(_usage_of(response, model))

    p = response.parsed_output
    if p is None:
        log.error("planner: no parsed output")
        return None

    p.generated_by = "model"
    return p


def _repair_message(prefs: Prefs, w: Weather, draft: Plan, problems: list[str],
                    notes: str = "") -> str:
    """The correction request.

    The original brief is repeated in full because the model has no memory of
    it, and the system prompt is left untouched so the cached prefix still
    hits - a repair costs an input the size of one brief, not two.
    """
    stops = "\n".join(
        f"  {i}. {s.start} ({s.minutes} min, {prefs.currency} {s.cost:.0f}) {s.name}"
        f"{' -> ' + str(s.travel_minutes) + ' min to next' if s.travel_minutes else ''}"
        for i, s in enumerate(draft.stops, 1)
    )
    faults = "\n".join(f"  - {p}" for p in problems)
    return (
        f"{_user_message(prefs, w)}\n\n"
        f"---\n\n"
        f"You already drafted this:\n\n"
        f"{draft.title}\n{stops}\n"
        f"Total: {prefs.currency} {draft.total_cost:.0f}\n\n"
        f"It breaks the constraints in these specific ways:\n\n{faults}\n\n"
        f"Fix exactly these problems and return the whole plan again. Keep everything that "
        f"was already working - the stops that are fine should stay, with the same names. "
        f"Change the fewest things that make the problems go away, and do not introduce new "
        f"ones: re-check the budget arithmetic and the clock yourself before answering."
    )


# ---------------------------------------------------------------------------
# Offline planner
#
# Templates, not intelligence. It gets the arc, the clock, the budget split and
# the weather contingency right, and is honest that it does not know the city.
# ---------------------------------------------------------------------------

# Budget split by stage. Sums to less than 1.0 on purpose - the remainder is
# slack for the round of drinks nobody plans for.
SPLIT = {
    "first_date":       {"opener": 0.15, "main": 0.45, "closer": 0.25},
    "getting_to_know":  {"opener": 0.15, "main": 0.50, "closer": 0.25},
    "dating":           {"opener": 0.15, "main": 0.50, "closer": 0.25},
    "long_term":        {"opener": 0.20, "main": 0.50, "closer": 0.20},
    "special_occasion": {"opener": 0.10, "main": 0.65, "closer": 0.15},
}


# Leg lengths, minutes. First dates are shorter at every stop rather than
# being built long and then cut - trimming a 95-minute dinner to fit a 2.5-hour
# window produces a plan nobody would follow.
LEGS = {
    "first_date": {"opener": 35, "second": 45, "main": 70},
    "default":    {"opener": 45, "second": 50, "main": 95},
}


def _hhmm(minutes: int) -> str:
    return f"{(minutes // 60) % 24:02d}:{minutes % 60:02d}"


def _fit_window(stops: list[Stop], max_hours: float, min_stops: int = 2) -> None:
    """Trim the itinerary until it fits the time it was given. Mutates.

    The offline planner assembles the full arc first and shortens afterwards,
    because which stop to cut depends on how long the others ended up. The
    last stop goes first: it is the optional one by construction, and cutting
    the closer is always better than rushing dinner.
    """
    def span_minutes() -> int:
        head, tail = stops[0], stops[-1]
        h, m = (int(x) for x in head.start.split(":"))
        th, tm = (int(x) for x in tail.start.split(":"))
        return (th * 60 + tm + tail.minutes) - (h * 60 + m)

    limit = int(max_hours * 60)
    while len(stops) > min_stops and span_minutes() > limit:
        stops.pop()
        stops[-1].travel_next = ""
        stops[-1].travel_minutes = 0

    # Still over at the minimum number of stops: take it out of the two longest,
    # never below 30 minutes - a 20-minute dinner is not a plan.
    for stop in sorted(stops, key=lambda s: -s.minutes)[:2]:
        over = span_minutes() - limit
        if over <= 0:
            break
        stop.minutes = max(30, stop.minutes - over)
        _restart(stops)


def _restart(stops: list[Stop]) -> None:
    """Re-flow start times after a duration changes, so the clock stays
    continuous. `rules.check` will complain otherwise, and rightly."""
    h, m = (int(x) for x in stops[0].start.split(":"))
    t = h * 60 + m
    for stop in stops:
        stop.start = _hhmm(t)
        t += stop.minutes + stop.travel_minutes


def _slots_for(prefs: Prefs, w: Weather) -> list[str]:
    """Which kinds of stop this particular evening should be made of.

    This is where the answers stop being decoration. Someone who said
    "aquarium" and someone who said "jazz" should not get the same shape of
    night, and on a first date in the rain neither of them should be marched
    up a hill to a viewpoint.
    """
    said = " ".join(prefs.interests).lower()

    def wants(*words):
        return any(x in said for x in words)

    # The middle of the evening: the thing you actually go *to*. Read the
    # interests first, because that is the answer with the most signal in it.
    if wants("aquarium", "fish", "animal", "zoo"):
        anchor = "aquarium"
    elif wants("music", "jazz", "gig", "band", "live"):
        anchor = "music"
    elif wants("film", "cinema", "movie", "theatre", "theater", "comedy"):
        anchor = "show"
    elif wants("art", "museum", "history", "gallery", "exhibition"):
        anchor = "activity"
    elif wants("book", "vintage", "record", "market", "shopping"):
        anchor = "shopping"
    elif w.is_wet or w.is_cold:
        anchor = "activity"          # indoors, because outside is miserable
    else:
        anchor = "viewpoint"

    # Drinks first is the classic opener: it is cheap, it is short, and it
    # gives you something to do with your hands while you work out whether
    # you like each other.
    opener = "coffee" if prefs.relationship_stage == "first_date" and prefs.start_time \
        and prefs.start_time.hour < 17 else "drinks"

    if prefs.relationship_stage == "first_date":
        return [opener, anchor, "food"]

    slots = [opener, anchor, "food"]
    if prefs.relationship_stage in ("dating", "long_term", "special_occasion"):
        slots.append("music")
    return slots


def _pick(candidates: list, used: set) -> object | None:
    """Nearest unused candidate, preferring ones with published hours.

    Published opening hours are a decent proxy for a place someone actually
    maintains, and they let the plan say when the kitchen shuts.
    """
    fresh = [c for c in candidates if c.name.lower() not in used]
    if not fresh:
        return None
    fresh.sort(key=lambda c: (0 if c.opening_hours else 1))
    return fresh[0]


# What to say about each kind of stop. Written to sound like a person who has
# been there, because the alternative - "a specialist coffee bar in a walkable
# part of town" - is what this planner used to say, and it reads like a form
# letter.
BLURB = {
    "drinks": [
        "Start here. One drink, somewhere with a bit of noise, while you work out what kind of night this is.",
        "A drink first: cheap, short, and it gives you something to do with your hands.",
    ],
    "coffee": [
        "Coffee first - low stakes, easy to leave, and you can always upgrade to a drink after.",
        "Somewhere to sit down before anything is decided.",
    ],
    "aquarium": [
        "The good part of the evening. Nobody runs out of things to say in front of a tank of fish.",
        "This is the stop that does the work: something to look at, and something to react to.",
    ],
    "activity": [
        "The part you will actually talk about afterwards. Wander, disagree about something, move on.",
        "Enough to look at that the conversation writes itself.",
    ],
    "music": [
        "If the night is still going, this is where it goes. Optional by design.",
        "Something to end on that is not another drink in another room.",
    ],
    "show": [
        "The anchor of the evening - check what is actually on before you commit.",
        "Book this one. Turning up hopeful is how you end up eating crisps for dinner.",
    ],
    "viewpoint": [
        "Free, outdoors, and the light does the work for you.",
        "Start above the noise. It costs nothing and it sets the whole evening up.",
    ],
    "shopping": [
        "Twenty minutes of poking about. You learn more about someone here than over dinner.",
        "Cheap, warm, and full of things to have an opinion about.",
    ],
    "food": [
        "Dinner, and the only stop worth booking ahead.",
        "The anchor. Everything before this was warm-up.",
    ],
}

# Minutes and share of budget per slot. Dinner gets the money and the time;
# everything else is there to make dinner better.
SHAPE = {
    "drinks":    (50, 0.16),
    "coffee":    (40, 0.08),
    "aquarium":  (75, 0.22),
    "activity":  (70, 0.18),
    "show":      (110, 0.30),
    "music":     (70, 0.20),
    "viewpoint": (40, 0.00),
    "shopping":  (35, 0.05),
    "food":      (95, 0.50),
}

# Which Stop.kind each slot maps to - the kind drives the booking partner and
# the verification rules, so it has to be one of models.STOP_KINDS.
AS_KIND = {"aquarium": "activity", "coffee": "coffee", "drinks": "drinks",
           "activity": "activity", "music": "music", "show": "show",
           "viewpoint": "viewpoint", "shopping": "shopping", "food": "food"}


def _respect_hours(stops: list[Stop]) -> None:
    """Put whatever closes first, first. Mutates.

    Museums and aquariums shut at six while bars and restaurants run late, so
    the obvious arc - drink, attraction, dinner - marches you to the aquarium
    exactly as the doors close. The first Boston plan this produced did
    precisely that: New England Aquarium, 18:02 to 19:17, closing time 18:00.

    The hours are already in hand from the lookup, so use them. Dinner stays
    last whatever it says, because nobody wants an evening reordered into
    eating at six and a museum at nine.
    """
    if len(stops) < 2:
        return

    def shuts(s: Stop) -> int:
        # No published closing time means no constraint: sorts last, and keeps
        # its order relative to the other unconstrained stops.
        return osm.closes_at(s.opening_hours) or 24 * 60

    if all(shuts(s) == 24 * 60 for s in stops):
        return

    tail = [s for s in stops if s.kind == "food"]
    head = [s for s in stops if s.kind != "food"]
    head.sort(key=shuts)

    reordered = head + tail
    if [s.name for s in reordered] != [s.name for s in stops]:
        log.info("planner: reordered around closing times -> %s",
                 ", ".join(s.name for s in reordered))
        # Keep the evening's own start time. `_restart` re-flows from
        # `stops[0].start`, so without this the new first stop inherits
        # whatever slot it used to occupy - which put the aquarium at 17:32
        # instead of 16:30 and left it overrunning the closing time anyway.
        opening = stops[0].start
        stops[:] = reordered
        stops[0].start = opening
        for s in stops[:-1]:
            s.travel_minutes = s.travel_minutes or 12
            s.travel_next = s.travel_next or "A few minutes on foot."
        stops[-1].travel_next = ""
        stops[-1].travel_minutes = 0
        _restart(stops)


def _offline_plan(prefs: Prefs, w: Weather) -> Plan:
    """Build an evening out of real, named places near the user - with no API
    key of any kind.

    This used to emit templates: "a specialist coffee bar or natural wine bar
    in a walkable part of town". True, useless, and it read like a computer,
    because it was one talking about a place it had never heard of. Now it
    asks OpenStreetMap what is actually around the coordinates and builds the
    night out of that, which for Boston means drinks at a real bar, the New
    England Aquarium, and dinner at a real restaurant.

    It still falls back to the old shape when there is nothing nearby or no
    coordinates - an honest placeholder beats an invented venue.
    """
    sr = rules.stage_rules(prefs.relationship_stage)
    slots = _slots_for(prefs, w)
    gh = wx.golden_hour(w)

    start_m = (prefs.start_time.hour * 60 + prefs.start_time.minute) if prefs.start_time else 17 * 60
    if "viewpoint" in slots and gh and not w.is_wet:
        # Put the outdoor stop in the light rather than after it.
        light = gh[0].hour * 60 + gh[0].minute - (len(slots) - slots.index("viewpoint") - 1) * 70
        start_m = max(start_m, min(start_m + 90, light))

    stops: list[Stop] = []
    used: set[str] = set()
    t = start_m
    budget_left = prefs.budget

    for i, slot in enumerate(slots):
        minutes, share = SHAPE.get(slot, (60, 0.2))
        cost = round(min(budget_left, prefs.budget * share), 2)
        hits = osm.nearby(slot, prefs.lat, prefs.lon, prefs.transportation, limit=6)
        venue = _pick(hits, used)
        last = i == len(slots) - 1

        if venue is None:
            # Nothing real nearby for this slot. Say what to look for instead
            # of inventing a name.
            stops.append(_placeholder(slot, prefs, t, minutes, cost, last))
        else:
            used.add(venue.name.lower())
            stops.append(_real_stop(slot, venue, prefs, w, t, minutes, cost, last))

        budget_left = max(0.0, budget_left - cost)
        t += minutes + (0 if last else 12)

    _respect_hours(stops)
    _fit_window(stops, min(sr["max_hours"], prefs.hours))

    # A photograph for whichever stop has one. `places.enrich` does this for
    # model plans but skips offline ones entirely, so it happens here - and
    # only after the trim, so nothing is fetched for a stop that got cut.
    for s in stops:
        if s.verified and s.kind in places.PHOTO_KINDS:
            shot = wiki.look(s.name, prefs.location, s.lat, s.lon)
            if shot:
                s.photo, s.blurb, s.photo_credit = shot.photo, shot.blurb, shot.url

    total = sum(s.cost for s in stops)
    named = [s.name for s in stops if s.verified or s.address]
    headline = named[1] if len(named) > 1 else (named[0] if named else prefs.location)

    return Plan(
        title=_title(prefs, slots, stops),
        pitch=_pitch(prefs, stops, total),
        stops=stops,
        total_cost=round(total, 2),
        transport_note=_transport_note(prefs, stops),
        weather_call=_weather_note(w, stops),
        wear=_wear(prefs, w),
        backup=f"{headline} is the one to check before you leave - opening hours move, and "
               f"everything else on this list is walkable enough to swap at short notice.",
        generated_by="offline",
    )


def _real_stop(slot: str, v, prefs: Prefs, w: Weather, t: int,
               minutes: int, cost: float, last: bool) -> Stop:
    """One stop, built from a place that actually exists."""
    kind = AS_KIND.get(slot, "activity")
    why = BLURB.get(slot, BLURB["activity"])[hash(v.name) % 2]

    # Say something true and specific about *this* place. Only the cuisine -
    # the kind already has its own badge on the card, and repeating it in the
    # prose reads like a database dump: "...tank of fish. (aquarium)".
    if v.cuisine:
        why = f"{why} Expect {v.cuisine.split(',')[0].strip()}."

    outdoors = kind in ("viewpoint", "walk")
    return Stop(
        name=v.name,
        kind=kind,
        start=_hhmm(t),
        minutes=minutes,
        cost=cost,
        why=why,
        travel_next="" if last else "A few minutes on foot.",
        travel_minutes=0 if last else 12,
        booking=("Worth booking - it is the busiest stop of the night."
                 if kind == "food" else
                 "Check the hours before you set off." if v.opening_hours else ""),
        dress_code=prefs.clothing_style if kind == "food" else "casual",
        indoor=not outdoors,
        fallback="" if not outdoors else "Anywhere with a roof on the same street.",
        tip=(f"Open {v.opening_hours}." if v.opening_hours else
             f"About {v.walk_time_from(prefs.lat, prefs.lon)} from where you started."
             if hasattr(v, "walk_time_from") else ""),
        # Pre-filled from the lookup, so `places.enrich` has nothing to do and
        # the stop is verified before the rules ever see it.
        looked_up=True, verified=True, source="osm",
        lat=v.lat, lon=v.lon, address=v.address, venue_kind=v.kind,
        cuisine=v.cuisine, opening_hours=v.opening_hours, website=v.website,
        distance_m=int(round(geo.distance_km(v.lat, v.lon, prefs.lat, prefs.lon) * 1000))
        if prefs.lat is not None else 0,
    )


def _placeholder(slot: str, prefs: Prefs, t: int, minutes: int,
                 cost: float, last: bool) -> Stop:
    """Nothing real found for this slot - describe what to look for."""
    what = {"drinks": "a bar", "coffee": "a coffee place", "food": "somewhere to eat",
            "music": "somewhere with live music", "show": "a cinema or theatre",
            "activity": "a museum or gallery", "aquarium": "an aquarium",
            "viewpoint": "high ground or a park", "shopping": "a market"}.get(slot, "somewhere")
    kind = AS_KIND.get(slot, "activity")
    outdoors = kind in ("viewpoint", "walk")
    return Stop(
        name=f"{what.capitalize()} near {prefs.location.split(',')[0]}",
        kind=kind, start=_hhmm(t), minutes=minutes, cost=cost,
        why=f"Nothing matching {what} came back on the map for this spot - "
            f"worth a look on the way, but do not build the night around it.",
        travel_next="" if last else "Short walk.", travel_minutes=0 if last else 12,
        dress_code="casual", indoor=not outdoors,
        fallback="" if not outdoors else "Anywhere indoors nearby.",
        tip="", booking="",
    )


def _title(prefs: Prefs, slots: list[str], stops: list[Stop]) -> str:
    where = prefs.location.split(",")[0]
    anchor = next((s for s in stops if s.kind in ("activity", "music", "show")), None)
    if anchor and anchor.verified:
        return f"{anchor.name}, and either side of it"
    return f"An evening around {where}"


def _pitch(prefs: Prefs, stops: list[Stop], total: float) -> str:
    names = [s.name for s in stops if s.verified]
    if len(names) >= 2:
        return (f"{names[0]}, then {names[1]}"
                + (f", then {names[2]}" if len(names) > 2 else "")
                + f" - about {prefs.currency} {total:.0f} for two.")
    return (f"A night around {prefs.location.split(',')[0]} for about "
            f"{prefs.currency} {total:.0f}, for two.")


def _transport_note(prefs: Prefs, stops: list[Stop]) -> str:
    far = max((s.distance_m for s in stops), default=0)
    how = {"walking": "All on foot", "bike": "All bikeable", "transit": "All on one or two lines",
           "car": "Driveable, but park once and walk", "rideshare": "Two short rides at most"}
    lead = how.get(prefs.transportation, "All close together")
    if far:
        return f"{lead} - the furthest stop is about {far / 1000:.1f} km from where you started."
    return f"{lead}."


def _weather_note(w: Weather, stops: list[Stop]) -> str:
    outdoor = [s.name for s in stops if not s.indoor]
    if not outdoor:
        return f"Forecast is {w.brief()}. Everything here is indoors, so the sky is not your problem."
    return (f"Forecast is {w.brief()}. {outdoor[0]} is the outdoor stop - "
            f"check again the morning of and move it inside if it turns.")


def _wear(prefs: Prefs, w: Weather) -> str:
    base = prefs.clothing_style.replace("_", " ")
    shoes = ("shoes you can walk twenty minutes in"
             if prefs.transportation in ("walking", "transit") else "something comfortable")
    weather = (" and a jacket that can get rained on" if w.is_wet else
               " and a layer for when the sun goes" if w.is_cold else "")
    return f"{base.capitalize()}, with {shoes}{weather}."
