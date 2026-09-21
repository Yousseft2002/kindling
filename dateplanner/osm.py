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


def label_for(kind: str) -> str:
    if not kind:
        return ""
    return KIND_LABEL.get(kind, kind.replace("_", " ").capitalize())
