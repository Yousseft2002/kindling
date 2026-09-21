"""Venue lookups against OpenStreetMap, with no API key.

This is the default way the app answers "where am I actually going?", and it
needs no account, no billing and no key - which matters more than it sounds,
because the alternative was a feature nobody could use until they had set up a
Google Cloud project.

What a hit gives you: exact coordinates, what kind of place it is, its opening
hours, cuisine, website and phone. What it does not give you is a rating -
OpenStreetMap has no review system. That turned out not to be the point. The
question "where am I going" is better answered by a pin on a map, the hours,
and the fact that the place demonstrably exists than by a number out of five.

The existence check is the real prize: a name that OSM has never heard of is a
strong signal the model invented it, and that check now runs for everyone
rather than only for people with a paid key.

Overpass was tried first and rejected: it can fetch every venue near a point in
one request, which is elegant, but the public instance answered in 28 seconds
or not at all, and mirrors timed out. Nominatim is slower per venue and rate
limited to one call a second, but it answers in under a second and it is the
same service the app already depends on for reverse geocoding.
"""

from __future__ import annotations

import logging
import re

from . import cache, geo
from .http import get_json

log = logging.getLogger(__name__)

SEARCH_URL = "https://nominatim.openstreetmap.org/search"

# Half-width of the search box, in degrees, by transport mode. Roughly
# 0.01 degrees is a kilometre of latitude. Generous on purpose: a venue just
# outside the planner's own radius is still the venue the model meant, and
# rejecting it would lose a real match.
BOX_DEG = {
    "walking": 0.02,
    "bike": 0.05,
    "transit": 0.08,
    "rideshare": 0.10,
    "car": 0.15,
}
DEFAULT_BOX = 0.08

# OSM `type` values, mapped to something worth showing a human. Anything not
# listed falls through to the raw value with underscores removed.
KIND_LABEL = {
    "restaurant": "Restaurant", "bar": "Bar", "cafe": "Café", "pub": "Pub",
    "fast_food": "Casual food", "nightclub": "Club", "biergarten": "Beer garden",
    "theatre": "Theatre", "cinema": "Cinema", "arts_centre": "Arts centre",
    "museum": "Museum", "gallery": "Gallery", "attraction": "Attraction",
    "viewpoint": "Viewpoint", "park": "Park", "garden": "Garden",
    "marketplace": "Market", "books": "Bookshop", "wine": "Wine shop",
    "ice_cream": "Ice cream", "bakery": "Bakery", "deli": "Deli",
}

# Place content is cached for a day: opening hours and websites change slowly,
# and a re-plan of the same evening should not re-query every venue.
TTL_SECONDS = 24 * 3600
_venues = cache.TTLCache(TTL_SECONDS, maxsize=512, name="osm-venues")


class Match:
    """One real place, as OpenStreetMap knows it."""

    __slots__ = ("name", "lat", "lon", "kind", "cuisine",
                 "opening_hours", "website", "phone", "address")

    def __init__(self, name: str, lat: float, lon: float, kind: str = "",
                 cuisine: str = "", opening_hours: str = "", website: str = "",
                 phone: str = "", address: str = "") -> None:
        self.name = name
        self.lat = lat
        self.lon = lon
        self.kind = kind
        self.cuisine = cuisine
        self.opening_hours = opening_hours
        self.website = website
        self.phone = phone
        self.address = address

    def __repr__(self) -> str:  # pragma: no cover - debugging only
        return f"Match({self.name!r}, {self.kind!r})"


def lookup(name: str, lat: float | None, lon: float | None,
           transport: str = "walking") -> Match | None:
    """Find `name` near the given point. None when OSM has no such place.

    `bounded=1` with a viewbox is what keeps this honest: without it,
    searching "Ramiro" from Lisbon cheerfully returns a Ramiro in Brazil, and
    a plan would be "verified" against a venue on another continent.
    """
    name = (name or "").strip()
    if not name or lat is None or lon is None:
        return None

    key = (name.lower(), round(lat, 3), round(lon, 3))
    hit = _venues.get(key)
    if hit is not None:
        return hit

    box = BOX_DEG.get(transport, DEFAULT_BOX)
    geo.nominatim_wait()

    data = get_json(SEARCH_URL, {
        "q": name,
        "format": "jsonv2",
        "limit": 1,
        "addressdetails": 1,
        "extratags": 1,
        # left,top,right,bottom
        "viewbox": f"{lon - box},{lat + box},{lon + box},{lat - box}",
        "bounded": 1,
    })
    if not data:
        return None

    match = _parse(data)
    if match is not None:
        _venues.set(key, match)
    return match


# Category keywords per slot in an evening, in the order they are tried. The
# first that returns anything wins, so the fallbacks matter: not every
# neighbourhood has an aquarium, but almost all of them have a park.
SLOTS = {
    "drinks": ["bar", "pub", "wine bar"],
    "food": ["restaurant", "bistro"],
    "coffee": ["cafe", "coffee shop"],
    "music": ["live music venue", "jazz club"],
    "show": ["theatre", "cinema"],
    "activity": ["museum", "gallery"],
    "aquarium": ["aquarium", "zoo"],
    "viewpoint": ["viewpoint", "park"],
    "shopping": ["market", "bookshop"],
}

# Searching "aquarium" in Boston returns the New England Aquarium and then
# four subway stops named after it. Anything in these OSM categories is
# infrastructure, not somewhere to take a date.
NOISE_CATEGORIES = {"railway", "highway", "public_transport", "barrier", "waterway"}
NOISE_TYPES = {
    "station", "platform", "stop", "stop_position", "bus_stop", "halt",
    "subway_entrance", "tram_stop", "parking", "parking_entrance", "toilets",
    "bicycle_parking", "taxi", "fuel", "atm", "bench", "waste_basket",
}


def nearby(slot: str, lat: float | None, lon: float | None,
           transport: str = "walking", limit: int = 8) -> list[Match]:
    """Real places near a point, for one slot in the evening.

    This is what lets the app say "drinks at The Alley Bar, then the New
    England Aquarium, then dinner at Trillium" with no API key at all, rather
    than "a specialist coffee bar in a walkable part of town" - which is the
    most an honest template planner with no data can offer.
    """
    if lat is None or lon is None:
        return []

    key = ("near", slot, round(lat, 3), round(lon, 3), transport)
    hit = _venues.get(key)
    if hit is not None:
        return list(hit)

    box = BOX_DEG.get(transport, DEFAULT_BOX)
    out: list[Match] = []

    for word in SLOTS.get(slot, [slot])[:2]:      # two tries, then give up
        geo.nominatim_wait()
        data = get_json(SEARCH_URL, {
            "q": word,
            "format": "jsonv2",
            "limit": limit * 2,                   # room to drop the noise
            "addressdetails": 1,
            "extratags": 1,
            "viewbox": f"{lon - box},{lat + box},{lon + box},{lat - box}",
            "bounded": 1,
        })
        if not data:
            continue
        out = [m for m in (_parse([r]) for r in data if _usable(r)) if m][:limit]
        if out:
            break

    if out:
        _venues.set(key, out)
    log.info("osm: %d candidates for %r near %.3f,%.3f", len(out), slot, lat, lon)
    return list(out)


def _usable(r: dict) -> bool:
    """Drop transit stops, car parks and anything else that is not a venue."""
    if not (r.get("name") or "").strip():
        return False
    if r.get("category") in NOISE_CATEGORIES or r.get("class") in NOISE_CATEGORIES:
        return False
    return r.get("type") not in NOISE_TYPES


def _parse(results: list) -> Match | None:
    """Split out so the mapping can be tested against a captured payload."""
    if not results:
        return None
    r = results[0]
    try:
        lat, lon = float(r["lat"]), float(r["lon"])
    except (KeyError, TypeError, ValueError):
        return None

    extra = r.get("extratags") or {}
    addr = r.get("address") or {}

    # Nominatim's own `name` is the venue; `display_name` is the whole
    # comma-separated chain down to the country, which is too long to show.
    label = r.get("name") or (r.get("display_name", "").split(",")[0])

    street = " ".join(x for x in (addr.get("house_number"), addr.get("road")) if x)
    town = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("suburb") or ""
    address = ", ".join(x for x in (street, town) if x)

    return Match(
        name=label,
        lat=lat, lon=lon,
        kind=label_for(r.get("type", "")),
        cuisine=(extra.get("cuisine") or "").replace("_", " ").replace(";", ", "),
        opening_hours=extra.get("opening_hours") or "",
        website=extra.get("website") or extra.get("contact:website") or "",
        phone=extra.get("phone") or extra.get("contact:phone") or "",
        address=address,
    )


def closes_at(hours: str) -> int | None:
    """Best-effort closing time, in minutes past midnight. None if unreadable.

    OSM opening_hours is a small language and this is not a parser for it -
    it takes the last clock time in the string, which is the closing time in
    every common shape:

        "Mo-Fr 09:00-18:00; Sa,Su 09:00-18:00"   -> 18:00
        "Tu 17:00-02:00, We-Mo 12:00-02:00"      -> 02:00, i.e. open late

    A result before noon means the place shuts after midnight, which is not a
    constraint any evening is going to hit, so it is reported as no limit.
    """
    if not hours:
        return None
    found = re.findall(r"\b([0-2]?\d):([0-5]\d)\b", hours)
    if not found:
        return None
    h, m = found[-1]
    mins = int(h) * 60 + int(m)
    return None if mins < 12 * 60 else mins


def label_for(kind: str) -> str:
    if not kind:
        return ""
    return KIND_LABEL.get(kind, kind.replace("_", " ").capitalize())
