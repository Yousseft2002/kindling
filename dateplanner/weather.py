"""Weather lookup via Open-Meteo.

Open-Meteo is used because it needs no API key and no attribution contract,
which keeps the app runnable by anyone who clones it. Geocoding lives in
`geo.py`; if the caller already has coordinates - from the autocomplete, or
from the phone's GPS - the lookup is skipped and the forecast is fetched for
exactly where the date is happening.

Sunset is the field that actually earns its keep. "Sunset walk" is only a real
instruction if you know when sunset is, and a plan that puts the viewpoint stop
forty minutes after dark is worthless.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time

from . import cache, geo
from .http import get_json
from .models import Weather

log = logging.getLogger(__name__)

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# Open-Meteo returns numeric WMO codes. These are collapsed to phrases a
# planner can reason about - the exact meteorology matters less than whether
# the evening is dry, and whether an outdoor stop survives.
WMO = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "rain showers", 81: "rain showers", 82: "violent rain showers",
    85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
}

# Open-Meteo's free forecast runs 16 days out. Past that there is nothing to
# fetch and we say so rather than inventing a summary.
HORIZON_DAYS = 16


def forecast(location: str, on: date,
             lat: float | None = None, lon: float | None = None) -> Weather:
    """Forecast for `on` at `location`. Always returns a Weather; an unknown
    one when the lookup fails, so callers never branch on None.

    Pass `lat`/`lon` when they are already known - it saves a call and, more
    importantly, guarantees the forecast is for the same point the itinerary
    is built around.
    """
    days_out = (on - date.today()).days
    if days_out < 0 or days_out > HORIZON_DAYS:
        log.info("weather: %s is outside the %d-day forecast horizon", on, HORIZON_DAYS)
        return Weather(summary="unknown (outside forecast range)")

    if lat is None or lon is None:
        place = geo.first(location)
        if place is None:
            log.warning("weather: could not place %r", location)
            return Weather()
        lat, lon = place.lat, place.lon

    # Rounded to roughly a kilometre: daily forecasts are far coarser than
    # that, so two stops in the same neighbourhood must not cost two calls.
    # A copy is handed out because Weather is mutable and callers own theirs.
    key = (round(lat, 2), round(lon, 2), on.isoformat())
    hit = cache.forecasts.get(key)
    if hit is not None:
        return hit.model_copy()

    data = get_json(FORECAST_URL, {
        "latitude": lat,
        "longitude": lon,
        "daily": ",".join([
            "weather_code",
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_probability_max",
            "wind_speed_10m_max",
            "sunset",
        ]),
        "timezone": "auto",
        "start_date": on.isoformat(),
        "end_date": on.isoformat(),
    })
    if not data or "daily" not in data:
        return Weather()

    w = _parse_daily(data["daily"])
    cache.forecasts.set(key, w)
    return w.model_copy()


def _parse_daily(daily: dict) -> Weather:
    """Split out from `forecast` so it can be tested without a network."""

    def first(key):
        vals = daily.get(key) or []
        return vals[0] if vals else None

    code = first("weather_code")
    sunset_raw = first("sunset")
    sunset = None
    if sunset_raw:
        try:
            # Open-Meteo returns local ISO like "2026-09-19T19:42".
            sunset = datetime.fromisoformat(sunset_raw).time()
        except ValueError:
            sunset = None

    precip = first("precipitation_probability_max")
    return Weather(
        summary=WMO.get(code, "unsettled") if code is not None else "unknown",
        high_c=first("temperature_2m_max"),
        low_c=first("temperature_2m_min"),
        precip_chance=int(precip) if precip is not None else None,
        wind_kph=first("wind_speed_10m_max"),
        sunset=sunset,
        source="open-meteo",
    )


# Free-text overrides. Someone who types "steady rain" means the plan should
# move indoors, but a typed summary carries no precipitation number, so nothing
# downstream would notice. These keywords give the override the same teeth the
# forecast has.
_WET = ("rain", "wet", "shower", "storm", "drizzle", "snow", "sleet", "hail", "monsoon", "pour")
_COLD = ("cold", "freez", "frost", "snow", "sleet", "chilly", "bitter")
_HOT = ("hot", "heat", "scorch", "sweltering", "humid")
_DRY = ("clear", "sunny", "sun ", "fine", "dry", "cloudless")


def parse_override(text: str) -> Weather:
    """Turn a typed forecast into a Weather the rules can act on.

    Only fills fields the text actually implies. Absent numbers stay None so
    the checks that need a real value skip rather than fire on a guess.
    """
    low = f" {text.lower()} "
    w = Weather(summary=text.strip() or "unknown", source="manual")

    if any(k in low for k in _WET):
        w.precip_chance = 80
    elif any(k in low for k in _DRY):
        w.precip_chance = 10

    if any(k in low for k in _COLD):
        w.low_c, w.high_c = 1.0, 6.0
    elif any(k in low for k in _HOT):
        w.low_c, w.high_c = 24.0, 33.0

    return w


def golden_hour(w: Weather) -> tuple[time, time] | None:
    """The window an outdoor viewpoint stop should sit inside: roughly the
    hour before sunset. Returned so the planner can be told a number instead
    of being asked to guess when the light goes."""
    if w.sunset is None:
        return None
    end = w.sunset.hour * 60 + w.sunset.minute
    start = max(0, end - 60)
    return time(start // 60, start % 60), time(end // 60, end % 60)
