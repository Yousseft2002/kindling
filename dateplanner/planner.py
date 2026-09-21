"""The judgment stage: turn preferences into an actual evening.

`SYSTEM` is the taste. `rules.brief()` is the constraint set. The system prompt
is cached, so it must stay byte-identical between runs - everything that varies
per request goes in the user message.

The app runs without an API key: `_offline_plan` produces a real, structurally
valid itinerary from templates. It names neighbourhoods and venue types instead
of venues, because inventing restaurant names offline would be worse than
useless. That path exists so the UI, the rules, the links and the tests can all
be exercised for free.
"""

from __future__ import annotations

import logging
import os
from datetime import date, time, timedelta

import anthropic

from . import affiliates, geo, places, research as scout, rules, weather as wx
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


def _offline_plan(prefs: Prefs, w: Weather) -> Plan:
    sr = rules.stage_rules(prefs.relationship_stage)
    split = SPLIT.get(prefs.relationship_stage, SPLIT["getting_to_know"])
    interest = prefs.interests[0] if prefs.interests else ""
    near = f" near the {interest} district" if interest else " in a walkable part of town"
    legs = LEGS.get(prefs.relationship_stage, LEGS["default"])
    wet = w.is_wet

    # Anchor the opener to golden hour when we know it, so the outdoor stop
    # lands in the light rather than after it.
    gh = wx.golden_hour(w)
    start_m = (prefs.start_time.hour * 60 + prefs.start_time.minute) if prefs.start_time else 17 * 60
    if gh and not wet:
        # Put the walk *inside* the light rather than leading up to it: start a
        # quarter hour before golden hour so the leg lands on sunset.
        start_m = max(start_m, gh[0].hour * 60 + gh[0].minute - 15)

    stops: list[Stop] = []
    t = start_m

    if wet:
        stops.append(Stop(
            name=f"A covered market or arcade in central {prefs.location}",
            kind="shopping", start=_hhmm(t), minutes=legs["opener"],
            cost=round(prefs.budget * split["opener"] * 0.4, 2),
            why="Rain is likely, so the opener is under cover but still has things to react to.",
            travel_next="Short walk to the coffee stop.", travel_minutes=10,
            dress_code="casual", indoor=True,
            fallback="Any bookshop or record shop on the same street.",
            tip="Arrive before the stalls start packing up - most wind down early.",
        ))
    else:
        stops.append(Stop(
            name=f"Sunset walk along the best-known waterfront or park edge in {prefs.location}",
            kind="viewpoint", start=_hhmm(t), minutes=legs["opener"], cost=0.0,
            why="Free, outdoors, and gives you something to look at while the conversation warms up.",
            travel_next="Walk on to the coffee or drinks stop.", travel_minutes=10,
            dress_code="casual", indoor=False,
            fallback="The nearest museum lobby or covered arcade if it turns.",
            tip=(f"Aim to be in position by {gh[0].strftime('%H:%M')} for the light."
                 if gh else "Aim to arrive about an hour before sunset."),
        ))
    t += stops[-1].minutes + stops[-1].travel_minutes

    stops.append(Stop(
        name=f"A specialist coffee bar or natural wine bar{near}",
        kind="drinks" if prefs.relationship_stage != "first_date" else "coffee",
        start=_hhmm(t), minutes=legs["second"],
        cost=round(prefs.budget * split["opener"], 2),
        why=(f"Somewhere to sit down while it is still early, chosen near {interest} so the walk there is not wasted."
             if interest else
             "Somewhere to sit down while it is still early, close enough to dinner to walk it."),
        travel_next="Walk to dinner.", travel_minutes=12,
        booking="Walk-in. If there is a queue, put your name down and wait outside.",
        dress_code="casual", indoor=True,
        fallback="", tip="Sit at the bar rather than a table - easier to talk, easier to leave.",
    ))
    t += stops[-1].minutes + stops[-1].travel_minutes

    stops.append(Stop(
        name=f"Dinner at a mid-sized neighbourhood restaurant in {prefs.location}",
        kind="food", start=_hhmm(t), minutes=legs["main"],
        cost=round(prefs.budget * split["main"], 2),
        why="The anchor of the evening, and the only stop worth booking in advance.",
        travel_next="" if prefs.relationship_stage == "first_date" else "Walk to the last stop.",
        travel_minutes=0 if prefs.relationship_stage == "first_date" else 12,
        booking=f"Book about a week ahead for {prefs.on.strftime('%A') if prefs.on else 'Saturday'} night.",
        dress_code=prefs.clothing_style if prefs.clothing_style in ("smart_casual", "dressy", "formal") else "casual",
        indoor=True, fallback="",
        tip=f"Ask for the {'earlier' if prefs.relationship_stage == 'first_date' else 'later'} sitting - "
            f"{'you keep the option to end cleanly' if prefs.relationship_stage == 'first_date' else 'the room fills up and gets better'}.",
    ))
    t += stops[-1].minutes + stops[-1].travel_minutes

    # First dates end after dinner. Anything else gets a third act.
    if prefs.relationship_stage != "first_date" and len(stops) < sr["max_stops"]:
        stops.append(Stop(
            name=f"A late bar with live music in {prefs.location}",
            kind="music", start=_hhmm(t), minutes=70,
            cost=round(prefs.budget * split["closer"], 2),
            why="Optional by design - suggest it only if the evening is still going.",
            travel_next="", travel_minutes=0,
            booking="Check whether there is a cover charge or a set time.",
            dress_code="casual", indoor=True, fallback="",
            tip="Check the last train before you order the second round.",
        ))

    _fit_window(stops, min(sr["max_hours"], prefs.hours))

    total = sum(s.cost for s in stops)
    return Plan(
        title=f"An evening in {prefs.location}",
        pitch=(f"{'Out of the rain' if wet else 'Sunset'}, somewhere to sit, dinner"
               f"{', and music after' if len(stops) > 3 else ''} - "
               f"about {prefs.currency} {total:.0f} for two."),
        stops=stops,
        total_cost=round(total, 2),
        transport_note=(
            f"Planned for {prefs.transportation}: every hop is kept under "
            f"{prefs.hop_limit} minutes, so pick the stops within one neighbourhood."
            + (" Check parking before you commit to the dinner stop." if prefs.transportation == "car" else "")
        ),
        weather_call=(
            f"Forecast is {w.brief()}. "
            + ("Rain moved the opener indoors; re-check the morning of and swap back if it clears."
               if wet else
               "The opener is outdoors - re-check the forecast that morning and use the fallback if it turns.")
        ),
        wear=(
            f"{prefs.clothing_style.replace('_', ' ').title()}, with shoes you can walk "
            f"{'twenty minutes' if prefs.transportation in ('walking', 'transit') else 'a few blocks'} in"
            + (", and a jacket that handles rain." if wet else
               ", and a layer for when the sun goes down." if w.is_cold else ".")
        ),
        backup="Dinner is the load-bearing stop. If it falls through, move the booking earlier "
               "and stretch the drinks stop rather than hunting for a replacement on the night.",
        generated_by="offline",
    )
