"""Photographs and a sentence of context, from Wikipedia. No key.

A list of venue names is information; a photograph of the place you are about
to walk to is an evening you can picture. This fetches both for the stops
notable enough to have an article - aquariums, museums, theatres, landmarks -
which in practice is the one stop in an evening that carries the visual weight.

Small bars and most restaurants have no article, and that is fine: they get no
photo and nothing is lost. What is *not* fine is a photo of the wrong place,
so `look()` checks the article is about *this* place before believing it.
The check is the article's own coordinates: Wikipedia publishes them, they are
language-independent, and a venue is either near the point we searched from or
it is a different venue. "Chart House" alone matches a restaurant chain's
article on another continent, and the distance says so immediately - whereas a
name check would pass it and a city-name check would wrongly reject Museu do
Aljube, whose English article says Lisbon while the user typed Lisboa.
"""

from __future__ import annotations

import logging

from . import cache, geo
from .http import get_json

log = logging.getLogger(__name__)

API = "https://en.wikipedia.org/w/api.php"

# Articles change slowly and images essentially never.
TTL_SECONDS = 7 * 24 * 3600
_pages = cache.TTLCache(TTL_SECONDS, maxsize=512, name="wikipedia")


class Shot:
    """What Wikipedia knows about a place."""

    __slots__ = ("title", "photo", "blurb", "url")

    def __init__(self, title: str, photo: str, blurb: str, url: str) -> None:
        self.title = title
        self.photo = photo
        self.blurb = blurb
        self.url = url

    def as_dict(self) -> dict:
        return {"title": self.title, "photo": self.photo,
                "blurb": self.blurb, "url": self.url}


# How far an article's own coordinates may sit from the venue before it is a
# different place. Generous, because a large site is tagged at its centre.
NEAR_KM = 5.0


def look(name: str, city: str = "",
         lat: float | None = None, lon: float | None = None) -> Shot | None:
    """Find `name` near the given point. None when there is no confident
    match - which is the common case and not a failure."""
    name = (name or "").strip()
    if len(name) < 3:
        return None

    city_word = (city or "").split(",")[0].strip()
    key = (name.lower(), city_word.lower(),
           round(lat, 2) if lat is not None else None,
           round(lon, 2) if lon is not None else None)
    hit = _pages.get(key)
    if hit is not None:
        return hit if hit != "miss" else None

    # With coordinates in hand the search does not need a place hint, and a
    # bad one actively hurts: "New England Aquarium Faneuil Hall" returns the
    # article for Faneuil Hall, which the guard then correctly rejects - so a
    # perfectly findable photo is lost to a word that was only ever meant to
    # disambiguate. The city is only appended when there is nothing else to
    # verify against.
    query = name if (lat is not None and lon is not None) else f"{name} {city_word}".strip()

    data = get_json(API, {
        "action": "query",
        "format": "json",
        "formatversion": 2,
        "generator": "search",
        "gsrsearch": query,
        "gsrlimit": 1,
        "prop": "pageimages|extracts|info|coordinates",
        "inprop": "url",
        "piprop": "thumbnail",
        "pithumbsize": 800,
        "exintro": 1,
        "explaintext": 1,
        "exsentences": 2,
        "redirects": 1,
    })

    shot = _parse(data, name, city_word, lat, lon)
    # Remember misses too, or every plan re-asks about the same small bar.
    _pages.set(key, shot or "miss")
    return shot


def _parse(data: dict | None, name: str, city: str,
           lat: float | None = None, lon: float | None = None) -> Shot | None:
    """Split out so the matching guard can be tested without a network."""
    pages = ((data or {}).get("query") or {}).get("pages") or []
    if not pages:
        return None
    p = pages[0]

    title = p.get("title", "")
    blurb = (p.get("extract") or "").strip()
    photo = ((p.get("thumbnail") or {}).get("source")) or ""

    # The guard. Wikipedia's search always returns *something*, so an
    # unverified hit is how you end up showing a photo of a restaurant on
    # another continent. The name must be recognisable in the title, and the
    # article must be about somewhere near here.
    words = [w for w in name.lower().split() if len(w) > 3]
    named = any(w in title.lower() for w in words) if words else False
    if not named:
        log.info("wiki: %r does not look like an article for %r", title, name)
        return None

    coords = (p.get("coordinates") or [{}])[0]
    if coords.get("lat") is not None and lat is not None and lon is not None:
        gap = geo.distance_km(float(coords["lat"]), float(coords["lon"]), lat, lon)
        if gap > NEAR_KM:
            log.info("wiki: %r is %.0f km away - different place", title, gap)
            return None
    elif city and city.lower() not in (blurb.lower() + " " + title.lower()):
        # No coordinates to check against; fall back to the city name.
        log.info("wiki: %r has no coordinates and does not mention %r", title, city)
        return None

    if not photo and not blurb:
        return None

    return Shot(title=title, photo=photo, blurb=blurb,
                url=p.get("fullurl") or f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}")
