"""Booking links, and the revenue model attached to them.

The business case for this app is that a finished itinerary is the highest-intent
moment in the entire dining-and-activity funnel: someone has just decided they
are going out on Saturday and has a named venue in front of them. Every stop
therefore ships with a booking link, and every link carries a partner tag.

Two rules kept honest here:

- **No invented partner IDs.** If `config.toml` has no tag for a provider, the
  link degrades to that provider's plain search URL with no tracking parameters.
  A fabricated tag does not earn money, it just breaks the link and, on some
  networks, gets the account closed.
- **Commission is estimated, never asserted.** `revenue_estimate()` exists so
  the unit economics are visible while tuning the planner (`run.py --revenue`),
  not so a number can be put in a pitch deck.

Rates in PROVIDERS are the published public rates at the time of writing and
will drift. They live in one dict so they are cheap to re-check.
"""

from __future__ import annotations

from urllib.parse import quote_plus, urlencode

from .models import Plan, Stop

# provider -> how it pays and where it sends people.
#   rate:     fraction of the stop's spend returned as commission
#   per_head: flat amount per person, used by reservation networks that pay
#             per seated cover instead of a percentage
PROVIDERS = {
    "opentable":     {"label": "Reserve on OpenTable",   "rate": 0.0,  "per_head": 1.00},
    "viator":        {"label": "Book on Viator",         "rate": 0.08, "per_head": 0.0},
    "getyourguide":  {"label": "Book on GetYourGuide",   "rate": 0.08, "per_head": 0.0},
    "dice":          {"label": "Tickets on DICE",        "rate": 0.10, "per_head": 0.0},
    "search":        {"label": "Find it",                "rate": 0.0,  "per_head": 0.0},
}

# Which provider gets each kind of stop. Reservation networks for tables,
# tour networks for anything ticketed, ticketing for live music, and a plain
# map search for the free stuff - a sunset walk has no one to bill.
PROVIDER_BY_KIND = {
    "food": "opentable",
    "drinks": "opentable",
    "activity": "viator",
    "show": "getyourguide",
    "music": "dice",
    "coffee": "search",
    "walk": "search",
    "viewpoint": "search",
    "shopping": "search",
}

MAPS = "https://www.google.com/maps/search/?api=1&query="


def _maps_url(stop: Stop, location: str) -> str:
    # Append the city: venue names are ambiguous and a map pin in the wrong
    # country is worse than no link.
    return MAPS + quote_plus(f"{stop.name} {location}")


def _provider_url(provider: str, stop: Stop, location: str, tags: dict) -> str:
    """Search URL on the booking partner, tagged if we have a tag for them."""
    tag = (tags.get(provider) or "").strip()
    term = f"{stop.name} {location}"

    if provider == "opentable":
        q = {"term": term}
        if tag:
            q["ref"] = tag
        return "https://www.opentable.com/s?" + urlencode(q)

    if provider == "viator":
        q = {"text": term}
        if tag:
            q["pid"] = tag
            q["mcid"] = "42383"  # Viator's affiliate-link media channel id
        return "https://www.viator.com/searchResults/all?" + urlencode(q)

    if provider == "getyourguide":
        q = {"q": term}
        if tag:
            q["partner_id"] = tag
        return "https://www.getyourguide.com/s/?" + urlencode(q)

    if provider == "dice":
        q = {"q": stop.name}
        if tag:
            q["utm_source"] = tag
        return "https://dice.fm/search?" + urlencode(q)

    return _maps_url(stop, location)


def attach(plan: Plan, location: str, cfg: dict | None = None) -> Plan:
    """Fill in `book_url`, `map_url` and `provider` on every stop. Mutates and
    returns the plan."""
    tags = (cfg or {}).get("partners", {}) or {}
    for stop in plan.stops:
        provider = PROVIDER_BY_KIND.get(stop.kind, "search")
        # A free stop is not worth a booking link; send them to the map.
        if stop.cost <= 0 and provider != "search":
            provider = "search"
        stop.provider = provider
        # A real place link from the Places lookup beats a search for the name,
        # so never overwrite one that is already there.
        if not stop.map_url:
            stop.map_url = _maps_url(stop, location)
        stop.book_url = _provider_url(provider, stop, location, tags)
    return plan


def label(stop: Stop) -> str:
    return PROVIDERS.get(stop.provider, PROVIDERS["search"])["label"]


def revenue_estimate(plan: Plan) -> dict:
    """Projected commission for one completed plan, per stop and in total.

    Deliberately pessimistic in one respect: it assumes every booking link is
    followed and converts. Real attach rates on this kind of product run at a
    few percent, so treat the total as the ceiling for one plan, and multiply
    by your actual conversion rate before believing anything.
    """
    lines = []
    total = 0.0
    for stop in plan.stops:
        p = PROVIDERS.get(stop.provider, PROVIDERS["search"])
        amount = stop.cost * p["rate"] + p["per_head"] * 2
        total += amount
        lines.append({
            "stop": stop.name,
            "provider": stop.provider,
            "spend": round(stop.cost, 2),
            "commission": round(amount, 2),
        })
    return {
        "lines": lines,
        "total": round(total, 2),
        "booked_spend": round(sum(s.cost for s in plan.stops), 2),
    }
