"""The editorial rules. This file is the product.

Two jobs, deliberately in one place so they cannot drift apart:

1. `brief()` renders the rules into the planner prompt.
2. `check()` re-tests the returned plan against the same rules and attaches
   warnings.

The model is good at taste and bad at arithmetic. So taste lives in the prompt
and arithmetic lives in `check()` - budget sums, clock continuity, walking
radius. When a rule fires, the plan is still shown; the warning is surfaced to
the user rather than triggering a silent retry, because a plan that is 8% over
budget is usually still the plan you want.

To tune this app, edit the constants here and the prompt in `planner.py`.
Everything else is plumbing.
"""

from __future__ import annotations

from .models import MAX_HOP_MINUTES, STYLE_RANK, VENUE_RANK, Plan, Prefs, Weather

# How far over the stated budget a plan may land before we complain. People
# say "$150" and mean "about $150"; flagging $152 trains them to ignore us.
BUDGET_TOLERANCE = 0.10

# Per-stage shape rules. These are the single highest-leverage thing in the
# app: stage changes the structure of an evening far more than interests do.
# `max_stops` and `max_hours` are enforced; the prose is prompt input.
STAGE_RULES = {
    "first_date": {
        "max_stops": 3,
        "max_hours": 3.0,
        "prose": (
            "Keep it short and escapable. Public, well-lit, easy to leave without drama, "
            "and easy to extend if it is going well - the last stop should be optional, not booked. "
            "No tasting menus, no three-hour commitments, no cinema or theatre where you cannot talk. "
            "Start with something that gives you something to look at and react to, so silences have "
            "somewhere to go. Avoid anything that requires them to be good at something in front of you."
        ),
    },
    "getting_to_know": {
        "max_stops": 4,
        "max_hours": 4.0,
        "prose": (
            "One shared activity that generates conversation, then somewhere to sit and use it. "
            "A reservation is now a compliment rather than a trap, but keep the total under four hours. "
            "Show one piece of the city they would not have found alone - specificity is the signal here."
        ),
    },
    "dating": {
        "max_stops": 5,
        "max_hours": 6.0,
        "prose": (
            "Comfort is established, so spend the novelty budget on the middle of the evening. "
            "A real reservation, a neighbourhood they do not default to, a proper arc rather than "
            "a repeat of the usual Friday."
        ),
    },
    "long_term": {
        "max_stops": 5,
        "max_hours": 6.0,
        "prose": (
            "The enemy is routine, not expense. Break at least one habit: a different neighbourhood, "
            "a different order of operations, an activity neither of them has done. Do not plan the "
            "evening they could have planned themselves. No stop should be somewhere they go monthly."
        ),
    },
    "special_occasion": {
        "max_stops": 5,
        "max_hours": 6.0,
        "prose": (
            "Build to one peak moment and protect it - everything before it is setup, everything after "
            "is decompression. Put the money on the peak and go cheap either side. Name the exact thing "
            "that makes it feel marked: the table, the view, the timing, the thing that gets said."
        ),
    },
}

# A Google rating below this is worth mentioning - not vetoing. Plenty of
# excellent places are badly rated by people who wanted something else, so the
# user decides; we only make sure they saw the number.
LOW_RATING = 3.8
# ...and only once enough people have voted for the average to mean anything.
MIN_RATINGS_TO_TRUST = 25

# Kinds that are outdoors by default. Used to sanity-check the model's own
# `indoor` flag, which it sometimes sets optimistically.
OUTDOOR_KINDS = {"walk", "viewpoint"}

# Phrases that mean the model failed to name a real place. A plan full of
# these is a horoscope, not an itinerary.
VAGUE = [
    "a nice ", "a local ", "a good ", "nearby ", "some ", "a cozy ", "a cosy ",
    "a trendy ", "a popular ", "any ", "a restaurant", "a bar", "a cafe", "a café",
    "local restaurant", "local bar", "your favourite", "your favorite",
]


def stage_rules(stage: str) -> dict:
    return STAGE_RULES.get(stage, STAGE_RULES["getting_to_know"])


def _mins(hhmm: str) -> int | None:
    try:
        h, m = (int(x) for x in hhmm.strip().split(":"))
    except (ValueError, AttributeError):
        return None
    return h * 60 + m


def brief(prefs: Prefs, weather: Weather) -> str:
    """The constraints block handed to the model. Plain numbered rules, because
    prose constraints get averaged away and numbered ones get followed."""
    sr = stage_rules(prefs.relationship_stage)
    hop = MAX_HOP_MINUTES.get(prefs.transportation, 20)
    lines = [
        f"1. BUDGET. {prefs.currency} {prefs.budget:.0f} total for two people, everything included - "
        f"food, drinks, tickets, and travel. Cost every stop realistically at local prices. "
        f"Coming in 10-20% under is a good plan; going over is a failed one. If the budget cannot "
        f"buy the obvious version of this evening, say so in the pitch and build the honest version.",
        f"2. STAGE. {prefs.relationship_stage}: {sr['prose']} "
        f"Hard limits: at most {sr['max_stops']} stops, at most {sr['max_hours']} hours.",
        f"3. GEOGRAPHY. Transport is {prefs.transportation}. No hop between consecutive stops may exceed "
        f"{hop} minutes door to door. The whole evening should read as one route, not a list of "
        f"good places scattered across the city. Order the stops so the route does not double back.",
        f"4. DRESS. They will be dressed {prefs.clothing_style}. Every stop must admit someone dressed "
        f"that way. Do not include a venue whose door policy is stricter than the outfit.",
        f"5. WEATHER. {weather.brief()}. "
        + (
            "Rain is likely: outdoor stops must be short, covered, or replaced, and every outdoor stop "
            "needs a named indoor fallback within the same radius."
            if weather.is_wet else
            "Any outdoor stop still needs a named indoor fallback in case the forecast turns."
        ),
        "6. SPECIFICITY. Name real, existing venues and places - the actual restaurant, the actual bar, "
        "the actual overlook. Never 'a nice wine bar'. If you are not confident a place exists, name the "
        "street or the market or the park instead, and say what to look for when they get there. "
        "Mark anything you are unsure is still open as worth checking.",
        "7. ARC. The evening must escalate: low-commitment and outdoors early, higher-commitment and "
        "indoors late. Never put the most expensive stop first. Do not schedule two of the same kind "
        "back to back. Leave the last stop optional unless it is booked.",
    ]
    if prefs.interests:
        lines.append(
            f"8. INTERESTS. {', '.join(prefs.interests)}. At least two stops must connect to these, "
            f"and connect specifically - not a museum because they said 'art', but the exhibition "
            f"currently worth seeing. Do not force every stop to serve an interest."
        )
    if prefs.party_note:
        lines.append(
            f"9. CONSTRAINTS FROM THE USER, which override anything above except budget: {prefs.party_note}"
        )
    return "\n".join(lines)


def check(plan: Plan, prefs: Prefs, weather: Weather) -> list[str]:
    """Re-test the returned plan against the rules. Returns human-readable
    warnings; never mutates and never raises."""
    out: list[str] = []
    sr = stage_rules(prefs.relationship_stage)
    hop_limit = MAX_HOP_MINUTES.get(prefs.transportation, 20)

    if not plan.stops:
        return ["The plan came back with no stops."]

    # --- money ---------------------------------------------------------
    stop_total = sum(s.cost for s in plan.stops)
    if stop_total > prefs.budget * (1 + BUDGET_TOLERANCE):
        over = stop_total - prefs.budget
        out.append(
            f"Over budget: stops add up to {prefs.currency} {stop_total:.0f} against a "
            f"{prefs.currency} {prefs.budget:.0f} budget ({prefs.currency} {over:.0f} over)."
        )
    # The model reports its own total; if it disagrees with the arithmetic,
    # trust the arithmetic and say so.
    if abs(plan.total_cost - stop_total) > max(5.0, stop_total * 0.05):
        out.append(
            f"Stated total ({prefs.currency} {plan.total_cost:.0f}) does not match the stops "
            f"({prefs.currency} {stop_total:.0f}). Trust the stops."
        )

    # --- shape ---------------------------------------------------------
    if len(plan.stops) > sr["max_stops"]:
        out.append(
            f"{len(plan.stops)} stops is long for a {prefs.relationship_stage.replace('_', ' ')} "
            f"({sr['max_stops']} is the cap). Consider dropping one."
        )

    # --- clock ---------------------------------------------------------
    first = _mins(plan.stops[0].start)
    last_end = None
    for i, s in enumerate(plan.stops):
        start = _mins(s.start)
        if start is None:
            out.append(f"'{s.name}' has an unreadable start time ({s.start!r}).")
            continue
        if last_end is not None and start < last_end:
            out.append(
                f"'{s.name}' starts at {s.start}, before the previous stop and its travel finish "
                f"({last_end // 60:02d}:{last_end % 60:02d})."
            )
        travel = s.travel_minutes if i < len(plan.stops) - 1 else 0
        if travel > hop_limit:
            out.append(
                f"{travel} min from '{s.name}' to the next stop is a long hop by "
                f"{prefs.transportation} (limit {hop_limit} min)."
            )
        last_end = start + s.minutes + travel

    if first is not None and last_end is not None:
        span = (last_end - first) / 60
        if span > sr["max_hours"] + 0.25:
            out.append(
                f"The evening runs {span:.1f} hours; {sr['max_hours']} is the ceiling for a "
                f"{prefs.relationship_stage.replace('_', ' ')}."
            )
        if span > prefs.hours + 0.5:
            out.append(f"You asked for about {prefs.hours:g} hours; this plan runs {span:.1f}.")

    # --- door policy ---------------------------------------------------
    style = STYLE_RANK.get(prefs.clothing_style, 2)
    for s in plan.stops:
        need = VENUE_RANK.get(s.dress_code, 1)
        if need > style:
            out.append(
                f"'{s.name}' expects {s.dress_code.replace('_', ' ')} and you said "
                f"{prefs.clothing_style.replace('_', ' ')}. Check the door policy."
            )

    # --- weather -------------------------------------------------------
    for s in plan.stops:
        outdoor = (not s.indoor) or s.kind in OUTDOOR_KINDS
        if outdoor and not s.fallback.strip():
            out.append(f"'{s.name}' is outdoors with no named indoor fallback.")
        if outdoor and weather.is_wet and s.minutes > 45:
            out.append(
                f"'{s.name}' is {s.minutes} min outdoors with {weather.precip_chance}% "
                f"chance of rain."
            )

    # --- sunset --------------------------------------------------------
    # A viewpoint stop after dark is the single most common way this kind of
    # plan quietly fails, and it is cheap to catch.
    if weather.sunset is not None:
        sunset_m = weather.sunset.hour * 60 + weather.sunset.minute
        for s in plan.stops:
            if s.kind != "viewpoint":
                continue
            start = _mins(s.start)
            if start is None:
                continue
            if start > sunset_m:
                out.append(
                    f"'{s.name}' starts at {s.start}, after sunset "
                    f"({weather.sunset.strftime('%H:%M')}). Move it earlier."
                )
            elif start + s.minutes < sunset_m - 75:
                out.append(
                    f"'{s.name}' ends well before sunset ({weather.sunset.strftime('%H:%M')}); "
                    f"you will miss the light."
                )

    # --- does the place exist ------------------------------------------
    # Only meaningful when a Places lookup actually ran: `looked_up` is what
    # separates "searched for and not found" - a real sign the venue may be
    # invented - from "never searched", which says nothing.
    for s in plan.stops:
        if s.looked_up and not s.verified:
            # Deliberately not naming the provider: the lookup runs against
            # OpenStreetMap or Google depending on configuration, and the user
            # does not care which one has never heard of the place.
            out.append(
                f"'{s.name}' could not be found in map data. It may have closed, or may "
                f"not exist - check before you build the evening around it."
            )
        elif s.verified and s.rating is not None and s.ratings_count >= MIN_RATINGS_TO_TRUST \
                and s.rating < LOW_RATING:
            out.append(
                f"'{s.name}' is rated {s.rating:.1f} on Google across "
                f"{s.ratings_count:,} reviews."
            )

    # --- specificity ---------------------------------------------------
    # Skipped offline: that planner names venue *types* by design and knows it,
    # so flagging every stop would bury the warnings that matter.
    if plan.generated_by != "offline":
        for s in plan.stops:
            low = s.name.lower()
            if any(low.startswith(v) or f" {v}" in low for v in VAGUE):
                out.append(f"'{s.name}' is not a real place - the planner hedged. Re-run or replace it.")

    return out
