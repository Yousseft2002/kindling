"""Turning named venues into real places.

This does two jobs, and the second one matters more than the first.

**Somewhere real to go.** Each stop gets exact coordinates, an address, what
kind of place it is, its opening hours, and a map link that opens the pin
rather than a search for the name - plus a star rating where one exists. That
is what turns a list of names into somewhere you can picture going.

**Verification.** The model is asked to name real venues and it mostly does,
but "mostly" is the problem: a confidently invented restaurant is the one
failure a user cannot recover from, because it looks exactly like a real
suggestion until they are standing outside a shuttered building. Every venue
stop is now looked up, and one that cannot be found is flagged. That makes the
hallucination visible instead of silent.

Two providers, chosen automatically:

- **OpenStreetMap** (`osm.py`) by default. No key, no account, no billing.
  Gives exact coordinates, opening hours, cuisine and a website, and - the
  important part - tells you whether the place exists at all.
- **Google Places** when `GOOGLE_MAPS_API_KEY` is set. Adds star ratings and
  review counts, which OSM has no equivalent of.

Verification works either way, which is the whole reason the OSM path exists:
the hallucination check should not be a paid feature.

Two rules from Google's terms, both load-bearing:

- **Place IDs may be stored indefinitely; other place content may not.** So the
  cache here is in-process only, short-lived, and never written to disk.
- **Displaying this data requires visible Google attribution and a link back
  to Google Maps.** The UI carries both; do not remove them.
"""

from __future__ import annotations

import logging
import os

from urllib.parse import quote_plus

from . import cache, geo, osm, wiki
from .http import post_json

log = logging.getLogger(__name__)

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

# Field masks are mandatory on this API - omitting one is an error, and asking
# for fields you do not use costs money, since billing is per requested tier.
FIELD_MASK = ",".join([
    "places.id",
    "places.displayName",
    "places.rating",
    "places.userRatingCount",
    "places.googleMapsUri",
    "places.formattedAddress",
])

# Kinds that name a business, and so *should* be findable. Only these produce
# a warning when they are not: a walk described as "the waterfront promenade"
# is not a listing, and flagging it would cry wolf on every plan.
VERIFIABLE = {"food", "drinks", "coffee", "music", "show", "activity", "shopping"}

# Kinds worth looking up for their coordinates even though a miss means
# nothing. A named viewpoint or park is a real point on a map and belongs on
# the route map - the first stop of an evening is usually one of these, and
# leaving it off makes the map start at the second pin.
LOCATABLE = VERIFIABLE | {"viewpoint", "walk"}

# Kinds worth asking Wikipedia about. An aquarium, a museum or a theatre has
# an article with a photograph; a neighbourhood wine bar does not, and asking
# only burns a request to be told so.
PHOTO_KINDS = {"activity", "show", "music", "viewpoint", "walk"}

# How far around the anchor to look, by transport mode. Wider than the
# planner's own radius: a venue slightly outside the walking radius is still
# the venue the model meant, and rejecting it would lose a real rating.
SEARCH_RADIUS_M = {
    "walking": 3000,
    "bike": 6000,
    "transit": 10000,
    "rideshare": 12000,
    "car": 18000,
}
DEFAULT_RADIUS_M = 8000

# In-process, short-lived, never persisted - see the note about Google's
# caching terms above. One hour is enough to cover a re-plan without holding
# anything.
TTL_SECONDS = 3600
_venues = cache.TTLCache(TTL_SECONDS, maxsize=512, name="places")


class Venue:
    """One real place, as Google knows it."""

    __slots__ = ("id", "name", "rating", "ratings", "maps_url", "address")

    def __init__(self, id: str, name: str, rating: float | None,
                 ratings: int, maps_url: str, address: str) -> None:
        self.id = id
        self.name = name
        self.rating = rating
        self.ratings = ratings
        self.maps_url = maps_url
        self.address = address

    def __repr__(self) -> str:  # pragma: no cover - debugging only
        return f"Venue({self.name!r}, {self.rating})"


def available() -> bool:
    return bool(os.environ.get("GOOGLE_MAPS_API_KEY"))


def find(name: str, lat: float | None = None, lon: float | None = None,
         radius_m: int = DEFAULT_RADIUS_M, near: str = "") -> Venue | None:
    """Best match for `name`, biased to the coordinates. None if not found.

    `near` is appended to the query when there are no coordinates - "Taberna
    Real, Alfama" finds far more than "Taberna Real" alone.
    """
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key or not name.strip():
        return None

    query = name.strip() if (lat is not None and lon is not None) else \
        f"{name.strip()} {near}".strip()

    cache_key = (query.lower(), round(lat, 2) if lat is not None else None,
                 round(lon, 2) if lon is not None else None)
    hit = _venues.get(cache_key)
    if hit is not None:
        return hit

    body: dict = {"textQuery": query, "pageSize": 1, "languageCode": "en"}
    if lat is not None and lon is not None:
        body["locationBias"] = {
            "circle": {"center": {"latitude": lat, "longitude": lon},
                       "radius": float(radius_m)}
        }

    data = post_json(SEARCH_URL, body, headers={
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
    })
    if not data:
        return None

    venue = _parse(data)
    if venue is not None:
        _venues.set(cache_key, venue)
    return venue


def _parse(data: dict) -> Venue | None:
    """Split out so the response mapping can be tested without a network."""
    hits = data.get("places") or []
    if not hits:
        return None
    p = hits[0]
    rating = p.get("rating")
    return Venue(
        id=p.get("id", ""),
        name=(p.get("displayName") or {}).get("text", ""),
        rating=float(rating) if rating is not None else None,
        ratings=int(p.get("userRatingCount") or 0),
        maps_url=p.get("googleMapsUri", ""),
        address=p.get("formattedAddress", ""),
    )


def provider() -> str:
    """Which venue source is in play. Google when a key is configured,
    OpenStreetMap otherwise - and OSM is not a degraded mode, it is the
    default that works for everyone."""
    return "google" if available() else "osm"


def _maps_pin(lat: float, lon: float, name: str) -> str:
    """A Google Maps link that opens the pin, not a search.

    Coordinates plus the name: the coordinates put the pin in the right place
    and the name is what the user sees in the Maps UI once it opens.
    """
    return ("https://www.google.com/maps/search/?api=1&query="
            + quote_plus(f"{lat:.6f},{lon:.6f}") + "&query_place=" + quote_plus(name))


def enrich(plan, prefs) -> int:
    """Look up every venue stop and attach what we can learn about it.
    Mutates the plan; returns how many stops were matched.

    Never raises and never removes a stop: an unfound venue keeps its name and
    gets `verified = False`, which `rules.check` turns into a warning. Deciding
    the model was wrong is the user's call, not this function's.
    """
    # The offline planner names venue *types* - "a specialist coffee bar in a
    # walkable part of town" - and says so. Looking those up would fail every
    # time and bury the user in warnings about places that were never claimed
    # to be real. Same exemption the vague-name check in `rules` already makes.
    if getattr(plan, "generated_by", "model") == "offline":
        return 0

    use_google = available()
    radius = SEARCH_RADIUS_M.get(prefs.transportation, DEFAULT_RADIUS_M)
    found = 0
    tried = 0

    for stop in plan.stops:
        if stop.kind not in LOCATABLE:
            continue
        tried += 1
        # Only a stop that *should* exist as a listing is marked as searched;
        # `looked_up` is what turns a miss into a warning, and a viewpoint
        # missing from OSM says nothing about whether it is real.
        stop.looked_up = stop.kind in VERIFIABLE

        if use_google:
            hit = find(stop.name, prefs.lat, prefs.lon, radius, near=prefs.location)
            if hit is None:
                log.info("places: google has no match for %r", stop.name)
                continue
            stop.source = "google"
            stop.rating = hit.rating
            stop.ratings_count = hit.ratings
            stop.address = hit.address
            if hit.maps_url:
                stop.map_url = hit.maps_url
        else:
            hit = osm.lookup(stop.name, prefs.lat, prefs.lon, prefs.transportation)
            if hit is None:
                log.info("places: osm has no match for %r", stop.name)
                continue
            stop.source = "osm"
            stop.lat, stop.lon = hit.lat, hit.lon
            stop.address = hit.address
            stop.venue_kind = hit.kind
            stop.cuisine = hit.cuisine
            stop.opening_hours = hit.opening_hours
            stop.website = hit.website
            # Coordinates beat a name search: this opens the pin.
            stop.map_url = _maps_pin(hit.lat, hit.lon, stop.name)
            if prefs.lat is not None and prefs.lon is not None:
                stop.distance_m = int(round(
                    geo.distance_km(hit.lat, hit.lon, prefs.lat, prefs.lon) * 1000))

        stop.verified = True
        found += 1

        # A photograph, for the stops that have one. Restaurants and small
        # bars do not, and that is fine - this is about the one stop in the
        # evening that carries the visual weight.
        if stop.kind in PHOTO_KINDS:
            shot = wiki.look(stop.name, prefs.location, stop.lat or prefs.lat,
                             stop.lon or prefs.lon)
            if shot:
                stop.photo, stop.blurb = shot.photo, shot.blurb
                stop.photo_credit = shot.url

    if tried:
        log.info("places: matched %d of %d venue stops via %s", found, tried, provider())
    return found
