"""A small TTL cache for the lookups that happen before the model runs.

Why this exists: planning is not a one-shot act. The app explicitly invites
tweaking one input and planning again - a different budget, a later start, a
different stage - and each of those re-plans was re-geocoding the same city and
re-fetching the same forecast, about 900 ms of network for answers that had not
changed.

Two TTLs, because the two kinds of answer age very differently:

- Coordinates for a place name do not change. A day is arbitrary but safely
  shorter than "never".
- A forecast does change, and a date planner that acts on a stale one is
  exactly the failure this project keeps trying to avoid. Half an hour is
  short enough that an outdoor stop is never planned against yesterday's sky.

Deliberately not a decorator: `geo.reverse` has to consult the cache *before*
it sleeps for the Nominatim rate limit, and a decorator wrapping the whole
function would either sleep on every cache hit or move the throttle somewhere
it does not belong.

Failures are never cached. A transient network blip that got remembered for a
day would be a much worse bug than the blip itself.
"""

from __future__ import annotations

import threading
import time
from typing import Any

# Coordinates for a name; effectively static.
PLACE_TTL = 24 * 3600
# Forecasts; short enough that no plan is built on a stale sky.
FORECAST_TTL = 30 * 60


class TTLCache:
    """Thread-safe, bounded, time-expiring key/value store.

    Bounded because this runs in a long-lived server process and an unbounded
    dict keyed on user input is a slow memory leak wearing a hat.
    """

    def __init__(self, ttl: float, maxsize: int = 512, name: str = "") -> None:
        self.ttl = ttl
        self.maxsize = maxsize
        self.name = name
        self.hits = 0
        self.misses = 0
        self._store: dict[Any, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: Any) -> Any | None:
        now = time.monotonic()
        with self._lock:
            hit = self._store.get(key)
            if hit is None:
                self.misses += 1
                return None
            expires, value = hit
            if expires <= now:
                del self._store[key]
                self.misses += 1
                return None
            self.hits += 1
            return value

    def set(self, key: Any, value: Any) -> None:
        # Never remember a failure: callers pass None or an empty result when
        # the network was unreachable, and a cached outage lasts far longer
        # than a real one.
        if not value:
            return
        now = time.monotonic()
        with self._lock:
            if len(self._store) >= self.maxsize:
                self._evict(now)
            self._store[key] = (now + self.ttl, value)

    def _evict(self, now: float) -> None:
        """Drop expired entries; if that frees nothing, drop the entry closest
        to expiry. Caller holds the lock."""
        dead = [k for k, (exp, _) in self._store.items() if exp <= now]
        for k in dead:
            del self._store[k]
        if not dead and self._store:
            oldest = min(self._store, key=lambda k: self._store[k][0])
            del self._store[oldest]

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
        self.hits = self.misses = 0

    def stats(self) -> dict:
        total = self.hits + self.misses
        return {
            "name": self.name,
            "entries": len(self._store),
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": round(self.hits / total, 3) if total else 0.0,
        }


places = TTLCache(PLACE_TTL, name="places")
forecasts = TTLCache(FORECAST_TTL, name="forecasts")


def clear_all() -> None:
    places.clear()
    forecasts.clear()


def all_stats() -> list[dict]:
    return [places.stats(), forecasts.stats()]
