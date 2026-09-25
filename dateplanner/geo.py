"""Turning "where" into something the planner can actually use.

Three jobs:

- `search()`   free text -> candidate places, for the autocomplete in the form.
- `reverse()`  phone coordinates -> a neighbourhood name, for "use my location".
- both hand back coordinates, which matter more than the name: a plan anchored
  on lat/lon with a radius is location-specific, and one anchored on the string
  "London" is a guess about which London.

Two providers, both keyless so anyone can clone this and run it:

- Open-Meteo geocoding for forward search. Same service as the forecast, so
  the coordinates the planner uses and the coordinates the weather comes from
  are guaranteed to agree.
- Nominatim (OpenStreetMap) for reverse, because Open-Meteo has no reverse
  endpoint. Nominatim's usage policy asks for a descriptive User-Agent and no
  more than one request a second; `http.py` sets the former and `_THROTTLE`
  enforces the latter. Do not remove either - that policy is the price of a
  free keyless service, and ignoring it gets the whole project's IP blocked.
"""

from __future__ import annotations

import logging
import math
import threading
import time as _time
import unicodedata

from . import cache
from .http import get_json

log = logging.getLogger(__name__)

SEARCH_URL = "https://geocoding-api.open-meteo.com/v1/search"
REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"

# Nominatim: one request per second, absolute maximum, per their usage policy.
# The limit is per service, not per endpoint, so `osm.py` shares this gate -
# venue lookups and reverse geocoding both queue behind it.
_THROTTLE = 1.1
_last_nominatim = 0.0
_lock = threading.Lock()


def nominatim_wait() -> None:
    """Block until it is polite to call Nominatim again. Shared by every
    caller in the project; do not add a second one."""
    global _last_nominatim
    with _lock:
        gap = _time.monotonic() - _last_nominatim
        if gap < _THROTTLE:
            _time.sleep(_THROTTLE - gap)
        _last_nominatim = _time.monotonic()

# Reverse-geocode detail level. 14 lands on suburb/neighbourhood, which is the
# unit a date is planned in - 10 gives you the whole city and 18 gives you the
# building you are standing in, and neither helps pick a bar.
REVERSE_ZOOM = 14


class Place:
    """A resolved location. Deliberately not a pydantic model - it crosses no
    API boundary, it just carries three things the planner needs."""

    __slots__ = ("label", "lat", "lon", "detail")

    def __init__(self, label: str, lat: float, lon: float, detail: str = "") -> None:
        self.label = label
        self.lat = lat
        self.lon = lon
        self.detail = detail  # country, region - shown in the picker, not used in prompts

    def as_dict(self) -> dict:
        return {"label": self.label, "lat": self.lat, "lon": self.lon, "detail": self.detail}

    def __repr__(self) -> str:  # pragma: no cover - debugging only
        return f"Place({self.label!r}, {self.lat}, {self.lon})"


def search(query: str, count: int = 6) -> list[Place]:
    """Free text -> ranked candidate places. Empty list if nothing matches."""
    query = (query or "").strip()
    if len(query) < 2:
        return []

    # Every keystroke in the autocomplete lands here, and re-planning the same
    # city re-asks the same question. Coordinates for a name do not change.
    key = (query.lower(), count)
    hit = cache.places.get(key)
    if hit is not None:
        return list(hit)

    data = get_json(SEARCH_URL, {"name": query, "count": count, "language": "en", "format": "json"})
    if not data or not data.get("results"):
        return []

    out = []
    for r in data["results"]:
        detail = ", ".join(x for x in (r.get("admin1"), r.get("country")) if x)
        out.append(Place(
            label=r.get("name") or query,
            lat=float(r["latitude"]),
            lon=float(r["longitude"]),
            detail=detail,
        ))
    # The geocoder matches loosely: "Boston" also returns Brilliant, Alabama
    # and Moline, Kansas, which reads as a broken search. Keep the names that
    # start with what was typed - accents aside, so "Sao Paulo" keeps São
    # Paulo - unless that leaves nothing, when a loose match is the only help
    # on offer for a typo.
    typed = _fold(query.split(",")[0])
    close = [p for p in out if _fold(p.label).startswith(typed)]
    out = close or out
    cache.places.set(key, out)
    return list(out)


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s or "")
                   if not unicodedata.combining(c)).lower().strip()


# How far a named neighbourhood may sit from the place the user said it was
# in before we stop believing it is the same one. Generous, because city
# centroids are imprecise, but nowhere near the 500 km between Williamsburg
# in Brooklyn and Williamsburg in Virginia.
NEAR_KM = 150.0


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance. Pure maths, so the selection logic below can be
    tested without a network."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def first(query: str) -> Place | None:
    """The single best match for a typed location, or None.

    Used when someone typed a location and never touched the autocomplete -
    which includes every CLI run.

    The hard case is the way people actually write an address:
    "Williamsburg, Brooklyn". Open-Meteo matches on a single place name, so the
    whole string finds nothing, and falling back to the most specific component
    finds Williamsburg, *Virginia* - a confident answer 500 km from the date.
    Silently wrong coordinates are the worst outcome available here, so the
    components are resolved in the other order: the broadest one first, to
    establish where we are, and the specific one is only accepted if it is
    actually near it. Failing that, the container wins - being in the right
    city beats being in an identically named town in the wrong state.
    """
    q = (query or "").strip()

    hits = search(q, count=1)
    if hits:
        return hits[0]

    parts = [p.strip() for p in q.split(",") if p.strip()]
    if len(parts) < 2:
        return None

    # Broadest component first: "Brooklyn" out of "Williamsburg, Brooklyn".
    anchor = None
    for part in reversed(parts[1:]):
        got = search(part, count=1)
        if got:
            anchor = got[0]
            break

    specific = search(parts[0], count=8)
    if anchor is None:
        # Nothing to check against; the specific name is all we have.
        return specific[0] if specific else None

    for cand in specific:
        gap = distance_km(cand.lat, cand.lon, anchor.lat, anchor.lon)
        if gap <= NEAR_KM:
            log.info("geo: %r resolved to %r, %.0f km from %r", q, cand.label, gap, anchor.label)
            return cand

    log.info("geo: no %r near %r - using %r itself", parts[0], anchor.label, anchor.label)
    return anchor


def reverse(lat: float, lon: float) -> Place | None:
    """Coordinates -> the neighbourhood someone would name if you asked them
    where they are. None if the lookup fails."""
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        log.warning("geo: coordinates out of range: %s, %s", lat, lon)
        return None

    # Rounded to about 100 m: a phone sitting still reports slightly different
    # coordinates each time, and those should not each cost a fresh lookup
    # plus a rate-limit sleep. This check comes before the throttle for that
    # reason - a cache hit must not pay a second of sleep it does not need.
    key = (round(lat, 3), round(lon, 3))
    hit = cache.places.get(key)
    if hit is not None:
        return Place(hit.label, lat, lon, hit.detail)

    nominatim_wait()

    data = get_json(REVERSE_URL, {
        "lat": lat, "lon": lon, "zoom": REVERSE_ZOOM,
        "format": "jsonv2", "addressdetails": 1,
    })
    if not data or "address" not in data:
        return None

    place = Place(label=_label(data), lat=lat, lon=lon, detail=data["address"].get("country", ""))
    cache.places.set(key, place)
    return place


def _label(payload: dict) -> str:
    """Build "Alfama, Lisboa" from a Nominatim response.

    Split out so it can be tested against captured payloads without a network.
    Nominatim's address keys vary by country, which is why this walks a list of
    candidates rather than reading two fixed fields.
    """
    a = payload.get("address", {})
    local = next((a[k] for k in (
        "neighbourhood", "suburb", "quarter", "city_district", "borough",
        "village", "town", "hamlet",
    ) if a.get(k)), "")
    city = next((a[k] for k in ("city", "town", "municipality", "county", "state") if a.get(k)), "")

    if local and city and local != city:
        return f"{local}, {city}"
    return local or city or payload.get("name") or "your current location"
