#!/usr/bin/env python3
"""Offline tests. No network, no API key, no spend.

Covers the things that are easy to get quietly wrong: the rule checks that
catch a bad plan, the clock arithmetic in the offline planner, the affiliate
link construction (a broken tag costs real money), and the shape of the
request sent to the model.

Every test supplies its own weather, so nothing here touches Open-Meteo.

    python test_planner.py
"""

from __future__ import annotations

import sys
from datetime import date, time
from pathlib import Path
from types import SimpleNamespace

from dateplanner import affiliates, geo, planner, render, rules, server
from dateplanner import weather as wx
from dateplanner.models import Plan, Prefs, Stop, Weather

FAILURES: list[str] = []


def no_network(*a, **kw):
    """Installed over the HTTP helpers for the whole run.

    The offline rule used to be a convention, and conventions rot: adding the
    keyless venue lookup silently turned four existing tests into live calls to
    Nominatim. Now anything that reaches the network fails loudly instead, and
    a test that wants a response stubs the function above it.
    """
    raise AssertionError(
        "a test tried to reach the network - stub the lookup instead "
        "(geo.search, osm.lookup, places.find), or disable it in the config"
    )


def fake_venue(name, lat=38.7223, lon=-9.1393, kind="Bar", cuisine="",
               hours="", site="", address="1 Test Street, Lisbon"):
    from dateplanner.osm import Match
    return Match(name=name, lat=lat, lon=lon, kind=kind, cuisine=cuisine,
                 opening_hours=hours, website=site, address=address)


# Candidates the stubbed lookup hands back, so the offline planner can be
# exercised properly - it composes real evenings from real venues now, and a
# test that fed it nothing would only ever prove the placeholder path works.
VENUES = {
    "drinks": [fake_venue("The Alley Bar", kind="Bar", hours="Mo-Su 16:00-01:00")],
    "coffee": [fake_venue("Copenhagen Coffee Lab", kind="Café", hours="Mo-Su 08:00-19:00")],
    "food": [fake_venue("Taberna Real", kind="Restaurant", cuisine="portuguese",
                        hours="Tu-Su 19:00-23:30")],
    "aquarium": [fake_venue("Oceanario de Lisboa", lat=38.7633, lon=-9.0950,
                            kind="Aquarium", hours="Mo-Su 10:00-18:00")],
    "activity": [fake_venue("Museu do Aljube", kind="Museum", hours="Tu-Su 10:00-18:00")],
    "music": [fake_venue("Hot Clube de Portugal", kind="Bar", hours="Tu-Sa 22:00-02:00")],
    "viewpoint": [fake_venue("Miradouro da Graca", kind="Viewpoint")],
    "show": [], "shopping": [],
}


def fake_nearby(slot, lat, lon, transport="walking", limit=8):
    return list(VENUES.get(slot, []))


def cfg(**kw) -> dict:
    """Config for tests. Venue lookups are off unless a test switches them on,
    so `planner.plan` never reaches out to map data."""
    base = {"llm": {"enabled": True, "web_search": False},
            "places": {"enabled": False}}
    for k, v in kw.items():
        base.setdefault(k, {}).update(v) if isinstance(v, dict) else base.update({k: v})
    return base


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILURES.append(name)


DRY = Weather(summary="clear", high_c=21, low_c=14, precip_chance=5,
              sunset=time(19, 30), source="open-meteo")
WET = Weather(summary="rain", high_c=12, low_c=8, precip_chance=85,
              sunset=time(19, 30), source="open-meteo")


def prefs(**kw) -> Prefs:
    # Coordinates and weather are both supplied so nothing in here ever
    # reaches the network: `resolve()` geocodes only when coords are missing.
    base = dict(location="Lisbon", lat=38.7223, lon=-9.1393, budget=150.0, currency="EUR",
                relationship_stage="getting_to_know", clothing_style="smart_casual",
                transportation="walking", on=date(2026, 10, 3), start_time=time(17, 0),
                weather=DRY)
    base.update(kw)
    return Prefs(**base)


def stop(**kw) -> Stop:
    base = dict(name="Taberna Real", kind="food", start="19:00", minutes=90,
                cost=60.0, why="Because.", indoor=True, dress_code="casual",
                travel_minutes=0)
    base.update(kw)
    return Stop(**base)


def good_plan() -> Plan:
    """A plan that should produce no warnings at all."""
    return Plan(
        title="A night out", pitch="Come out.",
        stops=[
            stop(name="Miradouro da Graca", kind="viewpoint", start="18:45", minutes=45,
                 cost=0.0, indoor=False, fallback="Museu de Lisboa", travel_minutes=10),
            stop(name="Taberna Real", start="19:40", minutes=90, cost=70.0, travel_minutes=0),
        ],
        total_cost=70.0, transport_note="All walkable.", weather_call="Dry.",
        wear="Layers.", backup="Dinner is the anchor.",
    )


# ---------------------------------------------------------------------------

def test_rules() -> None:
    print("\nrules")
    p = prefs()

    check("a clean plan produces no warnings",
          rules.check(good_plan(), p, DRY) == [],
          str(rules.check(good_plan(), p, DRY)))

    over = good_plan()
    over.stops[1].cost = 400.0
    over.total_cost = 400.0
    check("over budget is flagged",
          any("Over budget" in w for w in rules.check(over, p, DRY)))

    # 10% over is inside the tolerance on purpose - flagging it trains people
    # to ignore the warnings that matter.
    near = good_plan()
    near.stops[1].cost = 158.0
    near.total_cost = 158.0
    check("5% over budget is not flagged",
          not any("Over budget" in w for w in rules.check(near, p, DRY)),
          str(rules.check(near, p, DRY)))

    lying = good_plan()
    lying.total_cost = 20.0
    check("a stated total that contradicts the stops is flagged",
          any("does not match" in w for w in rules.check(lying, p, DRY)))

    far = good_plan()
    far.stops[0].travel_minutes = 55
    check("a 55 min hop is flagged for a walking date",
          any("long hop" in w for w in rules.check(far, p, prefs().weather)))

    posh = good_plan()
    posh.stops[1].dress_code = "formal"
    check("a venue stricter than the outfit is flagged",
          any("door policy" in w for w in rules.check(posh, p, DRY)))

    check("dressing up past the venue is not flagged",
          not any("door policy" in w
                  for w in rules.check(good_plan(), prefs(clothing_style="formal"), DRY)))

    exposed = good_plan()
    exposed.stops[0].fallback = ""
    check("an outdoor stop with no fallback is flagged",
          any("no named indoor fallback" in w for w in rules.check(exposed, p, DRY)))

    # The single most common silent failure in this kind of plan.
    late = good_plan()
    late.stops[0].start = "20:15"
    late.stops[1].start = "21:10"
    check("a viewpoint after sunset is flagged",
          any("after sunset" in w for w in rules.check(late, p, DRY)))

    overlap = good_plan()
    overlap.stops[1].start = "18:50"  # before the viewpoint + travel finishes
    check("a stop that starts before the previous one ends is flagged",
          any("before the previous stop" in w for w in rules.check(overlap, p, DRY)))

    vague = good_plan()
    vague.stops[1].name = "A nice wine bar in Alfama"
    check("a vague venue name is flagged on a model plan",
          any("not a real place" in w for w in rules.check(vague, p, DRY)))

    vague.generated_by = "offline"
    check("a vague venue name is NOT flagged on an offline plan",
          not any("not a real place" in w for w in rules.check(vague, p, DRY)))

    brief = rules.brief(prefs(interests=["jazz"], party_note="vegetarian"), WET)
    check("the prompt brief states the budget", "EUR 150" in brief)
    check("the prompt brief carries interests through", "jazz" in brief)
    check("the prompt brief carries the user's constraints through", "vegetarian" in brief)
    check("the prompt brief hardens on a wet forecast", "Rain is likely" in brief)


def test_weather() -> None:
    print("\nweather")

    # A typed override has no precipitation number, so without keyword parsing
    # nothing downstream would ever treat it as wet.
    check("'steady rain' parses as wet", wx.parse_override("steady rain").is_wet)
    check("'clear and warm' does not parse as wet", not wx.parse_override("clear and warm").is_wet)
    check("'freezing' parses as cold", wx.parse_override("freezing fog").is_cold)
    check("an override keeps the user's words as the summary",
          wx.parse_override("muggy and grim").summary == "muggy and grim")
    check("an override is marked manual", wx.parse_override("wet").source == "manual")
    check("an unrecognised override leaves the numbers unset",
          wx.parse_override("fine, I guess").low_c is None)

    daily = {
        "weather_code": [61], "temperature_2m_max": [17.4], "temperature_2m_min": [9.1],
        "precipitation_probability_max": [70], "wind_speed_10m_max": [22.0],
        "sunset": ["2026-10-03T19:11"],
    }
    w = wx._parse_daily(daily)
    check("WMO code 61 maps to light rain", w.summary == "light rain", w.summary)
    check("the forecast parses sunset", w.sunset == time(19, 11), str(w.sunset))
    check("the parsed forecast reads as wet", w.is_wet)

    check("an empty forecast payload does not raise",
          wx._parse_daily({}).summary == "unknown")

    gh = wx.golden_hour(DRY)
    check("golden hour ends at sunset", gh is not None and gh[1] == time(19, 30))
    check("golden hour is an hour long", gh is not None and gh[0] == time(18, 30))
    check("golden hour is None without a sunset", wx.golden_hour(Weather()) is None)


def test_geo() -> None:
    print("\ngeo")

    # Guard clauses first: these must not reach the network at all.
    check("a one-character query is not sent anywhere", geo.search("L") == [])
    check("an empty query is not sent anywhere", geo.search("") == [])
    check("a whitespace query is not sent anywhere", geo.search("   ") == [])
    check("out-of-range coordinates are rejected before any call",
          geo.reverse(91.0, 0.0) is None and geo.reverse(0.0, 181.0) is None)

    # Nominatim's address keys vary by country, which is the whole reason
    # `_label` walks a list of candidates instead of reading two fields.
    lisbon = {"address": {"neighbourhood": "Alfama", "city": "Lisboa", "country": "Portugal"}}
    check("a neighbourhood and city become one label",
          geo._label(lisbon) == "Alfama, Lisboa", geo._label(lisbon))

    village = {"address": {"village": "Sintra", "county": "Lisboa"}}
    check("a village falls back through the candidate list",
          geo._label(village) == "Sintra, Lisboa", geo._label(village))

    same = {"address": {"city": "Porto", "town": "Porto"}}
    check("a label is not repeated as 'Porto, Porto'",
          geo._label(same) == "Porto", geo._label(same))

    city_only = {"address": {"city": "Berlin"}}
    check("a city with no smaller unit still labels", geo._label(city_only) == "Berlin")

    check("an address with nothing usable still returns something printable",
          geo._label({"address": {}}) == "your current location")

    p = geo.Place("Alfama", 38.71, -9.13, "Portugal")
    check("a place serialises for the picker",
          p.as_dict() == {"label": "Alfama", "lat": 38.71, "lon": -9.13, "detail": "Portugal"})

    check("distance to the same point is zero",
          geo.distance_km(38.71, -9.13, 38.71, -9.13) == 0.0)
    check("Lisbon to Porto is about 275 km",
          270 < geo.distance_km(38.72, -9.14, 41.15, -8.61) < 285,
          f"{geo.distance_km(38.72, -9.14, 41.15, -8.61):.0f}")
    check("Brooklyn to Williamsburg VA is far enough to reject",
          geo.distance_km(40.68, -73.94, 37.27, -76.71) > geo.NEAR_KM)
    check("Alfama to Lisbon centre is near enough to accept",
          geo.distance_km(38.7139, -9.1289, 38.7223, -9.1393) < geo.NEAR_KM)

    # "Williamsburg, Brooklyn" is how people type an address, and it is the
    # case that silently planned a date in Virginia before this logic existed.
    # Open-Meteo genuinely has no Williamsburg in New York, so the right
    # answer is Brooklyn.
    WILLIAMSBURGS = [
        geo.Place("Williamsburg", 37.27, -76.71, "Virginia, United States"),
        geo.Place("Williamsburg", 36.74, -84.16, "Kentucky, United States"),
    ]
    BROOKLYN = geo.Place("Brooklyn", 40.68, -73.94, "New York, United States")
    ALFAMA = geo.Place("Alfama", 38.7139, -9.1289, "Lisbon District, Portugal")
    LISBOA = geo.Place("Lisbon", 38.7223, -9.1393, "Lisbon District, Portugal")

    real_search = geo.search
    try:
        def fake(q, count=6):
            q = q.strip().lower()
            if q in ("williamsburg, brooklyn", "alfama, lisboa", "xyzzy"):
                return []                      # the compound string matches nothing
            if q == "williamsburg":
                return list(WILLIAMSBURGS)
            if q == "brooklyn":
                return [BROOKLYN]
            if q == "alfama":
                return [ALFAMA]
            if q == "lisboa":
                return [LISBOA]
            return []
        geo.search = fake

        got = geo.first("Williamsburg, Brooklyn")
        check("a neighbourhood far from its stated city is rejected",
              got is BROOKLYN, repr(got))

        got = geo.first("Alfama, Lisboa")
        check("a neighbourhood near its stated city is kept",
              got is ALFAMA, repr(got))

        check("an unmatchable single name gives None", geo.first("Xyzzy") is None)

        geo.search = lambda q, count=6: [LISBOA] if q.strip().lower() == "lisbon" else []
        check("a plain city name resolves directly", geo.first("Lisbon") is LISBOA)
    finally:
        geo.search = real_search

    # Open-Meteo matches loosely. Typing "Boston" into the live picker offered
    # Brilliant, Alabama and Moline, Kansas, which reads as a broken search.
    def payload(*names):
        return {"results": [{"name": n, "latitude": 40.0 + i, "longitude": -71.0,
                             "admin1": "State", "country": "Country"}
                            for i, n in enumerate(names)]}

    real_get = geo.get_json
    try:
        geo.get_json = lambda url, params: payload("Boston", "Boston", "Brilliant", "Moline")
        got = [p.label for p in geo.search("Boston")]
        check("the picker keeps only places called what was typed",
              got == ["Boston", "Boston"], str(got))
        geo.get_json = lambda url, params: payload("São Paulo", "Frei Paulo")
        got = [p.label for p in geo.search("Sao Paulo")]
        check("an accent does not stop a name matching", got == ["São Paulo"], str(got))
        geo.get_json = lambda url, params: payload("Båstnäs")
        got = [p.label for p in geo.search("Bostn")]
        check("a typo still gets the loose match rather than nothing",
              got == ["Båstnäs"], str(got))
    finally:
        geo.get_json = real_get


def test_places() -> None:
    """Google Places lookups. Nothing here touches the network: the response
    mapping is tested against a captured payload and `enrich` against a stub."""
    print("\nplaces")

    import os
    from dateplanner import places

    from dateplanner import osm

    # Without a Google key the app does not lose the feature - it falls back to
    # OpenStreetMap, which needs no key at all. Verification is not a paid
    # feature.
    had = os.environ.pop("GOOGLE_MAPS_API_KEY", None)
    try:
        check("no key means Google is unavailable", not places.available())
        check("no key means OpenStreetMap is the provider", places.provider() == "osm")
        check("no key means the Google call is never made",
              places.find("Taberna Real", 38.7, -9.1) is None)

        real_lookup = osm.lookup
        try:
            osm.lookup = lambda name, lat, lon, transport="walking": (
                osm.Match("Taberna Real", 38.7141, -9.1290, kind="Restaurant",
                          cuisine="portuguese", opening_hours="Tu-Su 19:00-23:00",
                          website="https://example.org", address="R. de Sao Pedro 1, Lisboa")
                if name == "Taberna Real" else None)

            p = good_plan()
            found = places.enrich(p, prefs())
            check("the keyless path matches a real venue", found == 1, str(found))

            food = p.stops[1]
            check("osm marks the stop verified", food.verified and food.looked_up)
            check("osm records which source matched", food.source == "osm")
            check("osm attaches coordinates", food.lat == 38.7141 and food.lon == -9.1290)
            check("osm attaches the kind of place", food.venue_kind == "Restaurant")
            check("osm attaches opening hours", "19:00" in food.opening_hours)
            check("osm attaches a website", food.website.startswith("https://"))
            check("osm attaches the address", "Sao Pedro" in food.address)
            check("osm has no rating to attach", food.rating is None)

            # Distance from the anchor is the "how far is that?" answer.
            check("distance from the anchor is computed", food.distance_m > 0)
            check("distance is plausible for two points in Lisbon",
                  food.distance_m < 3000, str(food.distance_m))
            check("distance is shown in metres under a kilometre",
                  food.walk_time.endswith("m away"), food.walk_time)

            # The map link opens a pin, not a search for the name.
            check("the map link carries the coordinates",
                  "38.714" in food.map_url and "query=" in food.map_url)

            # An offline plan names venue types on purpose. Looking those up
            # would fail every time and fill the page with warnings about
            # places nobody claimed were real.
            template = good_plan()
            template.generated_by = "offline"
            check("an offline plan is not verified at all",
                  places.enrich(template, prefs()) == 0)
            check("an offline plan's stops are left unmarked",
                  not any(s.looked_up for s in template.stops))
            check("an offline plan produces no missing-venue warnings",
                  not any("could not be found" in x
                          for x in rules.check(template, prefs(), DRY)))

            # Not-found is still the hallucination signal, keylessly.
            ghost = good_plan()
            ghost.stops[1].name = "Restaurante Que Nao Existe"
            places.enrich(ghost, prefs())
            w = rules.check(ghost, prefs(), DRY)
            check("a venue OSM has never heard of is flagged",
                  any("could not be found in map data" in x for x in w), str(w))
        finally:
            osm.lookup = real_lookup
    finally:
        if had is not None:
            os.environ["GOOGLE_MAPS_API_KEY"] = had

    # --- the OSM response mapping, against a captured payload ----------
    payload = [{
        "lat": "38.7201980", "lon": "-9.1357060",
        "name": "Cervejaria Ramiro",
        "display_name": "Cervejaria Ramiro, 104, Avenida Almirante Reis, Lisboa, Portugal",
        "type": "restaurant",
        "address": {"house_number": "104", "road": "Avenida Almirante Reis", "city": "Lisboa"},
        "extratags": {"cuisine": "seafood", "opening_hours": "Tu-Su 12:00-00:30",
                      "website": "https://cervejariaramiro.com", "phone": "+351 21 885 1024"},
    }]
    m = osm._parse(payload)
    check("osm parses the venue name, not the whole display chain",
          m.name == "Cervejaria Ramiro")
    check("osm parses coordinates as floats", abs(m.lat - 38.720198) < 1e-6)
    check("osm maps the type to a readable label", m.kind == "Restaurant")
    check("osm parses cuisine", m.cuisine == "seafood")
    check("osm parses opening hours", m.opening_hours == "Tu-Su 12:00-00:30")
    check("osm builds a short address", m.address == "104 Avenida Almirante Reis, Lisboa")
    check("an empty result set is not a crash", osm._parse([]) is None)
    check("a result with no coordinates is rejected",
          osm._parse([{"name": "x"}]) is None)
    check("an unmapped type still gets a readable label",
          osm.label_for("wine_bar") == "Wine bar")
    check("a missing type produces no label", osm.label_for("") == "")

    # Guard clauses must not reach the network.
    check("a lookup with no coordinates is skipped",
          osm.lookup("Somewhere", None, None) is None)
    check("a lookup with no name is skipped", osm.lookup("  ", 38.7, -9.1) is None)

    # The response shape, from the documented field mask.
    payload = {"places": [{
        "id": "ChIJ123",
        "displayName": {"text": "Taberna Real", "languageCode": "pt"},
        "rating": 4.6,
        "userRatingCount": 1204,
        "googleMapsUri": "https://maps.google.com/?cid=123",
        "formattedAddress": "R. de Sao Pedro 1, Lisboa",
    }]}
    v = places._parse(payload)
    check("the place id is read", v.id == "ChIJ123")
    check("the display name is read, not the resource name", v.name == "Taberna Real")
    check("the rating is read", v.rating == 4.6)
    check("the review count is read", v.ratings == 1204)
    check("the real maps link is read", v.maps_url.startswith("https://maps.google.com/"))
    check("the address is read", "Lisboa" in v.address)

    check("an empty result set is not a crash", places._parse({"places": []}) is None)
    check("a missing results key is not a crash", places._parse({}) is None)

    unrated = places._parse({"places": [{"id": "x", "displayName": {"text": "New Bar"}}]})
    check("a place with no rating yet is still a match", unrated is not None)
    check("a place with no rating has rating None", unrated.rating is None)
    check("a place with no rating has a zero count", unrated.ratings == 0)

    # enrich(), with the network stubbed out.
    os.environ["GOOGLE_MAPS_API_KEY"] = "test-key"
    real_find = places.find
    try:
        places._venues.clear()
        looked = []

        def fake(name, lat=None, lon=None, radius_m=0, near=""):
            looked.append(name)
            if name == "Taberna Real":
                return places.Venue("id1", "Taberna Real", 4.6, 1204,
                                    "https://maps.google.com/?cid=1", "R. de Sao Pedro 1")
            return None            # the viewpoint and anything invented

        places.find = fake
        p = good_plan()
        found = places.enrich(p, prefs())

        check("a venue stop is looked up", "Taberna Real" in looked)
        # A viewpoint is located so it can get a pin on the route map, but it
        # is never *verified* - OSM not knowing it says nothing about whether
        # it is real, and warning about it would cry wolf on every plan.
        check("a viewpoint is located for the map", "Miradouro da Graca" in looked)
        check("a viewpoint is never marked as verifiable",
              not p.stops[0].looked_up)
        check("one venue was matched", found == 1, str(found))

        food = p.stops[1]
        check("the rating lands on the stop", food.rating == 4.6)
        check("the review count lands on the stop", food.ratings_count == 1204)
        check("the stop is marked verified", food.verified and food.looked_up)
        check("the map link points at the real place",
              food.map_url == "https://maps.google.com/?cid=1")
        check("the address lands on the stop", "Sao Pedro" in food.address)

        view = p.stops[0]
        check("an unsearched stop is not marked looked up", not view.looked_up)

        # The link must survive the affiliate pass, which used to overwrite it.
        affiliates.attach(p, "Lisbon", {})
        check("affiliate links do not clobber a real place link",
              p.stops[1].map_url == "https://maps.google.com/?cid=1")
        check("a stop with no real link still gets a search link",
              "google.com/maps/search" in p.stops[0].map_url)

        # A venue that cannot be found is the hallucination signal.
        ghost = good_plan()
        ghost.stops[1].name = "Restaurante Que Nao Existe"
        places.enrich(ghost, prefs())
        w = rules.check(ghost, prefs(), DRY)
        check("a venue that cannot be found is flagged",
              any("could not be found in map data" in x for x in w), str(w))

        # A low rating is surfaced, not vetoed - but only with enough votes.
        poor = good_plan()
        poor.stops[1].looked_up = poor.stops[1].verified = True
        poor.stops[1].rating, poor.stops[1].ratings_count = 2.9, 800
        check("a badly rated venue is surfaced",
              any("rated 2.9" in x for x in rules.check(poor, prefs(), DRY)))

        thin = good_plan()
        thin.stops[1].looked_up = thin.stops[1].verified = True
        thin.stops[1].rating, thin.stops[1].ratings_count = 2.9, 4
        check("a low rating from four people is not worth flagging",
              not any("rated 2.9" in x for x in rules.check(thin, prefs(), DRY)))

        good = good_plan()
        good.stops[1].looked_up = good.stops[1].verified = True
        good.stops[1].rating, good.stops[1].ratings_count = 4.6, 1204
        check("a well rated verified venue produces no warnings",
              rules.check(good, prefs(), DRY) == [],
              str(rules.check(good, prefs(), DRY)))
    finally:
        places.find = real_find
        os.environ.pop("GOOGLE_MAPS_API_KEY", None)


def test_offline_planner() -> None:
    print("\noffline planner")

    p = planner._offline_plan(prefs(), DRY)
    check("the offline planner returns stops", len(p.stops) >= 3, str(len(p.stops)))
    check("the offline plan marks itself offline", p.generated_by == "offline")
    check("the offline plan stays inside the budget",
          sum(s.cost for s in p.stops) <= prefs().budget,
          f"{sum(s.cost for s in p.stops)}")
    check("the offline plan's stated total matches its stops",
          abs(p.total_cost - sum(s.cost for s in p.stops)) < 0.01)

    # An evening never says the same thing twice.
    #
    # Asking for jazz used to produce two music slots - the anchor and the
    # closer - and in a city with one tagged jazz bar both fell back to the
    # same sentence, so the plan read "somewhere with live music near Boston"
    # twice. That is the app looking broken rather than looking honest.
    jazz = planner._slots_for(prefs(relationship_stage="dating",
                                    interests=["jazz", "photography"]), DRY)
    check("a music evening gets one music stop, not two",
          jazz.count("music") == 1, str(jazz))
    check("the closer is still there, as a nightcap",
          len(jazz) == 4 and jazz[-1] == "drinks", str(jazz))

    art = planner._slots_for(prefs(relationship_stage="dating",
                                   interests=["art"]), DRY)
    check("a non-music evening still closes on music",
          art[-1] == "music" and art.count("music") == 1, str(art))

    # And the belt-and-braces version, at the point the stops are built: two
    # unfillable slots produce identical placeholders, whatever the slot list
    # says.
    empty = {k: [] for k in VENUES}
    saved = dict(VENUES)
    VENUES.clear(); VENUES.update(empty)
    try:
        bare = planner._offline_plan(prefs(relationship_stage="dating",
                                           interests=["jazz"]), DRY)
    finally:
        VENUES.clear(); VENUES.update(saved)
    names = [s.name.lower() for s in bare.stops]
    check("no two stops in a plan share a name", len(names) == len(set(names)), str(names))
    check("a plan with nothing nearby still has stops", len(bare.stops) >= 2, str(len(bare.stops)))

    # Category words Nominatim actually resolves. Multi-word guesses return
    # nothing at all, which is a silent failure: the slot just falls back to
    # a placeholder and the plan looks thin for no visible reason.
    from dateplanner import osm as _osm_slots
    check("the music slot asks for words the phrase table knows",
          _osm_slots.SLOTS["music"] == ["jazz", "nightclub"],
          str(_osm_slots.SLOTS["music"]))
    check("the shopping slot asks for marketplace, not market",
          "marketplace" in _osm_slots.SLOTS["shopping"]
          and "market" not in _osm_slots.SLOTS["shopping"],
          str(_osm_slots.SLOTS["shopping"]))
    check("a bar with a band can fill the music slot",
          bool(_osm_slots.MUSICAL.search("Wally's Cafe Jazz Club")))
    # The name match is loose on purpose, so the thing keeping Music Hall
    # Place and Music Oval out of the evening is the noise filter, not the
    # regex. Searching the bare word "music" is what surfaces them.
    check("a street called Music Hall Place is not a venue",
          not _osm_slots._usable({"name": "Music Hall Place",
                                  "category": "highway", "type": "pedestrian"}))

    # The whole point of the rules module is that the offline planner passes it.
    warnings = rules.check(p, prefs(), DRY)
    check("the offline plan passes its own rule checks", warnings == [], str(warnings))

    wet_plan = planner._offline_plan(prefs(weather=WET), WET)
    check("rain moves the opener indoors", wet_plan.stops[0].indoor is True)
    check("rain is named in the weather call", "rain" in wet_plan.weather_call.lower())

    first = planner._offline_plan(prefs(relationship_stage="first_date"), DRY)
    check("a first date gets no late-music stop",
          not any(s.kind == "music" for s in first.stops))
    check("a first date stays within three stops", len(first.stops) <= 3, str(len(first.stops)))
    check("a first date passes its own rule checks",
          rules.check(first, prefs(relationship_stage="first_date"), DRY) == [],
          str(rules.check(first, prefs(relationship_stage="first_date"), DRY)))
    check("a first date never gets a 30-minute dinner",
          all(s.minutes >= 45 for s in first.stops if s.kind == "food"))

    long_ = planner._offline_plan(prefs(relationship_stage="long_term"), DRY)
    check("a longer stage gets a closing stop", len(long_.stops) >= 4, str(len(long_.stops)))

    # With no interests given, the template must not read "near the the ... district".
    check("no interests does not produce a doubled article",
          not any("the the" in s.name for s in p.stops),
          "; ".join(s.name for s in p.stops))

    # The sunset walk has to land in the light, not after it.
    opener = p.stops[0]
    check("the outdoor opener starts before sunset", opener.start < "19:30", opener.start)

    # --- it builds evenings out of real places now ----------------------
    boston = planner._offline_plan(prefs(interests=["aquarium"]), DRY)
    names = [s.name for s in boston.stops]
    check("the keyless plan names real venues, not venue types",
          "Oceanario de Lisboa" in names, str(names))
    check("a real venue is marked verified without a second lookup",
          all(s.verified for s in boston.stops
              if s.name in ("Oceanario de Lisboa", "The Alley Bar", "Taberna Real")))
    check("a real venue carries coordinates, so it lands on the map",
          all(s.lat is not None for s in boston.stops if s.verified))
    check("a real venue carries its opening hours",
          any(s.opening_hours for s in boston.stops))

    # The answers have to change the plan, or asking for them is theatre.
    jazz = [s.name for s in planner._offline_plan(prefs(interests=["jazz"]), DRY).stops]
    art = [s.name for s in planner._offline_plan(prefs(interests=["art"]), DRY).stops]
    check("saying 'aquarium' puts an aquarium in the evening",
          "Oceanario de Lisboa" in names)
    check("saying 'jazz' puts live music in it instead",
          "Hot Clube de Portugal" in jazz, str(jazz))
    check("saying 'art' puts a museum in it instead",
          "Museu do Aljube" in art, str(art))
    check("three different answers give three different evenings",
          len({tuple(names), tuple(jazz), tuple(art)}) == 3)

    wet_kinds = [s.kind for s in planner._offline_plan(prefs(weather=WET), WET).stops]
    check("rain keeps the evening indoors", "viewpoint" not in wet_kinds, str(wet_kinds))

    # --- closing times are a constraint, not decoration -----------------
    early = planner._offline_plan(
        prefs(interests=["aquarium"], start_time=time(16, 30)), DRY)
    aq = next(s for s in early.stops if "Oceanario" in s.name)
    shut = planner.osm.closes_at(aq.opening_hours)
    check("a venue that closes early is visited first",
          early.stops[0].name == aq.name, str([s.name for s in early.stops]))
    check("the plan does not have you there after closing",
          rules._mins(aq.end) <= shut, f"{aq.start}-{aq.end} vs close {shut}")
    check("reordering keeps the evening's own start time",
          early.stops[0].start == "16:30", early.stops[0].start)
    check("reordering leaves no dangling travel on the last stop",
          early.stops[-1].travel_minutes == 0 and not early.stops[-1].travel_next)

    # --- nothing nearby -------------------------------------------------
    real_nearby = planner.osm.nearby
    try:
        planner.osm.nearby = lambda *a, **k: []
        bare = planner._offline_plan(prefs(), DRY)
        check("with nothing nearby it still produces an evening", len(bare.stops) >= 2)
        check("with nothing nearby it invents no venue names",
              all(not s.verified for s in bare.stops))
        check("with nothing nearby it says what to look for instead",
              any("do not build the night around it" in s.why for s in bare.stops),
              str([s.why[:44] for s in bare.stops]))
    finally:
        planner.osm.nearby = real_nearby

    check("Stop.end is start plus duration",
          stop(start="19:00", minutes=90).end == "20:30",
          stop(start="19:00", minutes=90).end)
    check("Stop.end wraps past midnight",
          stop(start="23:30", minutes=60).end == "00:30",
          stop(start="23:30", minutes=60).end)


def test_fit_window() -> None:
    print("\nfit window")

    def legs():
        return [
            stop(name="A", start="17:00", minutes=60, travel_minutes=10),
            stop(name="B", start="18:10", minutes=60, travel_minutes=10),
            stop(name="C", start="19:20", minutes=60, travel_minutes=10),
            stop(name="D", start="20:30", minutes=60, travel_minutes=0),
        ]

    s = legs()
    planner._fit_window(s, 6.0)
    check("a plan already inside its window is untouched", len(s) == 4)

    # 4 x 60 min + 3 x 10 min of travel is 4h30. A 3h30 window needs exactly
    # one stop cut; a 3h window needs two.
    s = legs()
    planner._fit_window(s, 3.5)
    check("an overlong plan loses its last stop", len(s) == 3, str(len(s)))

    # Dinner is not the stop to cut, wherever it ended up sitting.
    #
    # `_respect_hours` moves food to the end of the evening so nothing is
    # scheduled after its venue shuts. A trim that pops the tail therefore
    # cuts dinner - which is exactly backwards, and produced a real Boston
    # plan of drinks, live music and more drinks with nothing to eat in it.
    mixed = [
        stop(name="Bar", kind="drinks", start="17:00", minutes=60, travel_minutes=10),
        stop(name="Gig", kind="music", start="18:10", minutes=60, travel_minutes=10),
        stop(name="Nightcap", kind="drinks", start="19:20", minutes=60, travel_minutes=10),
        stop(name="Dinner", kind="food", start="20:30", minutes=60, travel_minutes=0),
    ]
    planner._fit_window(mixed, 3.5)
    kinds = [x.kind for x in mixed]
    check("a trim keeps dinner", "food" in kinds, str(kinds))
    check("a trim cuts the closer instead", len(mixed) == 3, str(len(mixed)))
    check("the evening still starts when it was told to", mixed[0].start == "17:00",
          mixed[0].start)
    # The stops that remain have to close the gap the cut left behind.
    starts = [x.start for x in mixed]
    check("the stops after a cut are re-timed", starts == sorted(starts), str(starts))
    check("the new last stop has no onward travel", s[-1].travel_next == "" and s[-1].travel_minutes == 0)

    s = legs()
    planner._fit_window(s, 3.0)
    check("a much-too-long plan keeps losing stops until it fits", len(s) == 2, str(len(s)))

    s = legs()
    planner._fit_window(s, 2.0)
    check("trimming never goes below the minimum stop count", len(s) >= 2, str(len(s)))
    check("trimming never produces a stop under 30 minutes",
          all(x.minutes >= 30 for x in s), str([x.minutes for x in s]))

    # After a duration changes, the clock has to be re-flowed or every
    # subsequent start time is wrong.
    s = legs()
    planner._fit_window(s, 2.0)
    starts = [x.start for x in s]
    check("start times stay in order after trimming", starts == sorted(starts), str(starts))

    # Four minutes over is a shorter stay, not a lost stop. The live Boston
    # plan lost the bar between the aquarium and dinner over exactly this.
    boston = [
        stop(name="Aquarium", kind="activity", start="17:00", minutes=75, travel_minutes=12),
        stop(name="Bar", kind="drinks", start="18:27", minutes=50, travel_minutes=12),
        stop(name="Dinner", start="19:29", minutes=95),
    ]
    planner._fit_window(boston, 4.0)
    check("a few minutes over shortens a stay instead of cutting a stop",
          [x.name for x in boston] == ["Aquarium", "Bar", "Dinner"],
          str([x.name for x in boston]))
    check("the minutes do not come out of dinner", boston[-1].minutes == 95,
          str(boston[-1].minutes))
    span = rules._mins(boston[-1].end) - rules._mins(boston[0].start)
    check("and the evening then fits its window", span <= 240, str(span))

    # What they asked for is the last thing to go. A Chicago evening asked for
    # art galleries kept the bar and cut the gallery, because the gallery sat
    # later in the evening.
    chicago = [
        stop(name="Bar", kind="drinks", start="17:00", minutes=50, travel_minutes=25),
        stop(name="Gallery", kind="activity", start="18:15", minutes=70, travel_minutes=25),
        stop(name="Dinner", start="19:50", minutes=95),
    ]
    planner._fit_window(chicago, 4.0, keep="Gallery")
    check("a trim keeps the stop they asked for",
          [x.name for x in chicago] == ["Gallery", "Dinner"], str([x.name for x in chicago]))
    check("and the evening still starts on time without its opener",
          chicago[0].start == "17:00", chicago[0].start)


def test_evening_shape() -> None:
    print("\nevening shape")

    # --- a place that has shut is not a suggestion ----------------------
    # Chicago, live: a museum that closes at 16:00 booked for 17:00, and a
    # lunch counter that closes at 17:00 booked for dinner at 19:24.
    museum = fake_venue("Maritime Museum", kind="Museum", hours="Tu-Su 10:00-16:00")
    gallery = fake_venue("Late Gallery", kind="Gallery", hours="Mo-Su 10:00-20:00")
    lunch = fake_venue("Lunch Counter", kind="Restaurant", hours="Mo-Su 07:00-17:00")
    supper = fake_venue("Supper Club", kind="Restaurant", hours="Mo-Su 17:00-23:00")
    check("a museum shut before the evening starts is passed over",
          planner._pick([museum, gallery], set(), need_until=17 * 60 + 30) is gallery)
    check("dinner is never somewhere that shuts before dinner ends",
          planner._pick([lunch, supper], set(), need_until=21 * 60) is supper)
    check("unknown hours are not treated as closed",
          planner._pick([fake_venue("No Hours Bar")], set(), need_until=23 * 60) is not None)
    check("if everything has shut, nothing is picked rather than a closed door",
          planner._pick([museum], set(), need_until=17 * 60 + 30) is None)
    far = fake_venue("Far Bar", lat=38.80, lon=-9.20, hours="Mo-Su 16:00-01:00")
    near = fake_venue("Near Bar", lat=38.7225, lon=-9.1390, hours="Mo-Su 16:00-01:00")
    check("of two open places, the one nearer the last stop wins",
          planner._pick([far, near], set(), near=(38.7223, -9.1393)) is near)

    saved = dict(VENUES)
    try:
        VENUES["activity"] = [museum, gallery]
        VENUES["food"] = [lunch, supper]
        chicago = planner._offline_plan(prefs(interests=["art"]), DRY)
    finally:
        VENUES.clear(); VENUES.update(saved)
    names = [s.name for s in chicago.stops]
    check("an evening skips the places that have shut",
          "Maritime Museum" not in names and "Lunch Counter" not in names, str(names))
    check("and uses the ones that are open", "Late Gallery" in names and "Supper Club" in names,
          str(names))
    warnings = rules.check(chicago, prefs(interests=["art"]), DRY)
    check("and passes its own rule checks", warnings == [], str(warnings))

    # --- a visit ends when the doors close ------------------------------
    aq = stop(name="Aquarium", kind="activity", start="17:00", minutes=75,
              opening_hours="Mo-Su 09:00-18:00", travel_minutes=12)
    dinner = stop(name="Dinner", start="18:27", minutes=95)
    planner._close_on_time([aq, dinner])
    check("a visit is cut to end at closing time", aq.end == "18:00", aq.end)
    check("the next stop moves up to match", dinner.start == "18:12", dinner.start)
    late = stop(name="Museum", kind="activity", start="17:40", minutes=70,
                opening_hours="Mo-Su 10:00-18:00")
    planner._close_on_time([late])
    check("a visit is never cut below half an hour, it is flagged instead",
          late.minutes == 70, str(late.minutes))

    # Closing time applies to the evening that survives the trim. Lisbon, live:
    # a jazz bar moved ahead of dinner made dinner late enough to be cut to 75
    # minutes, then the jazz bar was trimmed and dinner kept the cut.
    step = 0.0144          # about 1.6 km: a 15-minute hop by transit
    lat0, lon0 = 38.7223, -9.1393
    saved = dict(VENUES)
    try:
        VENUES["drinks"] = [fake_venue("Zenite", hours="Mo-Su 16:00-02:00")]
        VENUES["show"] = [fake_venue("Teatro", lat=lat0 + step, kind="Theatre")]
        VENUES["music"] = [fake_venue("Onda Jazz", lat=lat0 + 2 * step)]
        VENUES["food"] = [fake_venue("Tati", lat=lat0 + 3 * step, kind="Restaurant",
                                     hours="Mo-Su 17:00-23:00")]
        lisbon = planner._offline_plan(prefs(relationship_stage="dating", interests=["film"],
                                             transportation="transit"), DRY)
    finally:
        VENUES.clear(); VENUES.update(saved)
    names = [s.name for s in lisbon.stops]
    check("the closer that does not fit is the stop cut",
          "Onda Jazz" not in names and "Teatro" in names, str(names))
    dinner = next(s for s in lisbon.stops if s.name == "Tati")
    check("dinner is not shortened for a stop that was then cut",
          dinner.minutes == 95, str(dinner.minutes))
    check("a transit evening says how you get between stops",
          any("bus or metro" in s.travel_next for s in lisbon.stops),
          str([s.travel_next for s in lisbon.stops]))

    # --- travel is measured, not assumed --------------------------------
    here = stop(name="A", lat=38.7223, lon=-9.1393)
    door = stop(name="B", lat=38.7230, lon=-9.1390)        # about 80 m
    across = stop(name="C", lat=38.7633, lon=-9.0950)      # about 6 km
    check("next door is a few minutes on foot",
          planner._leg(here, door, "walking") == (5, "A few minutes on foot."),
          str(planner._leg(here, door, "walking")))
    minutes, text = planner._leg(here, across, "walking")
    check("6 km on foot is not 'a few minutes'", minutes > 60 and "on foot" in text, text)
    minutes, text = planner._leg(here, across, "transit")
    check("6 km by transit says so", "bus or metro" in text and minutes < 60, text)
    check("nobody drives next door", "on foot" in planner._leg(here, door, "car")[1])
    check("a placeholder has no distance to measure",
          planner._leg(here, stop(name="Somewhere"), "walking") is None)

    # --- the copy follows the order -------------------------------------
    order = [
        stop(name="Aquarium", kind="activity", start="17:00", minutes=60, verified=True,
             why="Fish."),
        stop(name="Bar", kind="drinks", start="18:12", minutes=50, verified=True,
             why=planner.BLURB["drinks"][0]),
        stop(name="Dinner", start="19:14", minutes=95, verified=True, why="Dinner."),
    ]
    planner._retell(order)
    check("a bar in the middle of the evening does not say 'Start here'",
          not order[1].why.startswith("Start here") and "first" not in order[1].why,
          order[1].why)
    check("the first stop's line is left alone", order[0].why == "Fish.")
    cap = [order[0], stop(name="Late Bar", kind="drinks", start="18:12", minutes=50,
                          verified=True, why=planner.BLURB["drinks"][0])]
    planner._retell(cap)
    check("a bar at the end of the night reads as a nightcap",
          cap[-1].why in planner.NIGHTCAP, cap[-1].why)


def test_affiliates() -> None:
    print("\naffiliates")

    p = good_plan()
    affiliates.attach(p, "Lisbon", {})
    free, dinner = p.stops

    check("a free stop gets no booking partner", free.provider == "search", free.provider)
    check("a free stop still gets a map link", "google.com/maps" in free.map_url)
    check("a paid meal routes to the reservation partner",
          dinner.provider == "opentable", dinner.provider)
    check("the booking link carries the venue name",
          "Taberna" in dinner.book_url, dinner.book_url)
    check("the booking link carries the city, so the pin is not in another country",
          "Lisbon" in dinner.book_url)

    # An invented partner tag does not earn money - it breaks the link and can
    # get the account closed. No tag configured must mean no tag in the URL.
    check("no configured tag means no tracking parameter in the link",
          "ref=" not in dinner.book_url, dinner.book_url)

    tagged = good_plan()
    affiliates.attach(tagged, "Lisbon", {"partners": {"opentable": "abc123"}})
    check("a configured tag reaches the link",
          "ref=abc123" in tagged.stops[1].book_url, tagged.stops[1].book_url)

    blank = good_plan()
    affiliates.attach(blank, "Lisbon", {"partners": {"opentable": "   "}})
    check("a whitespace-only tag is treated as unset",
          "ref=" not in blank.stops[1].book_url)

    gig = Plan(title="t", pitch="p", stops=[stop(name="Hot Clube", kind="music", cost=30.0)],
               total_cost=30.0, transport_note="", weather_call="", wear="", backup="")
    affiliates.attach(gig, "Lisbon", {})
    check("live music routes to the ticketing partner", gig.stops[0].provider == "dice")

    rev = affiliates.revenue_estimate(p)
    check("commission is estimated per stop", len(rev["lines"]) == 2)
    check("a free stop earns nothing",
          rev["lines"][0]["commission"] == 0.0, str(rev["lines"][0]))
    check("a reservation earns the per-cover rate for two",
          rev["lines"][1]["commission"] == 2.0, str(rev["lines"][1]))
    check("the revenue total sums the lines",
          rev["total"] == sum(l["commission"] for l in rev["lines"]))


def test_model_request() -> None:
    print("\nmodel request shape")

    captured: dict = {}

    returned = good_plan()
    returned.title = "From the model"

    class StubMessages:
        def parse(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                stop_reason="end_turn",
                parsed_output=returned.model_copy(deep=True),
                usage=SimpleNamespace(input_tokens=10, cache_read_input_tokens=0, output_tokens=5),
            )

    class StubClient:
        messages = StubMessages()

    real_client = planner._client
    planner._client = lambda: StubClient()
    try:
        p = planner.plan(prefs(interests=["jazz"]), cfg(llm={"model": "claude-opus-5"}))
    finally:
        planner._client = real_client

    check("the model's plan is used", p.title == "From the model", p.title)
    check("the model's plan is marked as such", p.generated_by == "model")
    check("booking links are attached after the model answers",
          all(s.map_url for s in p.stops))

    check("the configured model is requested",
          captured.get("model") == "claude-opus-5", str(captured.get("model")))
    check("structured output is requested", captured.get("output_format") is Plan)

    system = captured.get("system")
    check("the system prompt is sent as a cacheable block",
          isinstance(system, list) and system[0]["cache_control"] == {"type": "ephemeral"},
          str(system)[:120])
    check("the system prompt is the module constant, byte for byte",
          isinstance(system, list) and system[0]["text"] == planner.SYSTEM)

    user = captured["messages"][0]["content"]
    check("the request names the location", "Lisbon" in user)
    check("the request carries the budget", "EUR 150" in user)
    check("the request carries the golden hour window", "Golden hour" in user, user[:200])
    check("the request carries the interests", "jazz" in user)

    # The whole point of collecting coordinates: without them in the prompt
    # the model answers for the city, not for where you actually are.
    check("the request carries the coordinates", "38.7223" in user and "-9.1393" in user)
    check("the request states a radius for the transport mode",
          "1.5 km" in user, user[:400])
    check("the request tells the model to stay in the neighbourhood",
          "neighbourhood" in user)


def stub_client(*plans, stop_reason: str = "end_turn", usage=None):
    """A client that returns each given plan in turn, recording the prompts."""
    sent: list[str] = []
    queue = list(plans)

    class Messages:
        def create(self, **kwargs):
            """The scouting pass uses `create`, not `parse` - no structured
            output, because it has the search tool attached."""
            sent.append(kwargs["messages"][0]["content"])
            return SimpleNamespace(
                stop_reason="end_turn",
                content=[SimpleNamespace(type="text", text="SCOUT NOTES", citations=None)],
                usage=SimpleNamespace(input_tokens=500, output_tokens=200,
                                      cache_read_input_tokens=0,
                                      cache_creation_input_tokens=0,
                                      server_tool_use=SimpleNamespace(web_search_requests=2)),
            )

        def parse(self, **kwargs):
            sent.append(kwargs["messages"][0]["content"])
            p = queue.pop(0) if queue else (plans[-1] if plans else None)
            return SimpleNamespace(
                stop_reason=stop_reason,
                parsed_output=p.model_copy(deep=True) if p is not None else None,
                usage=usage or SimpleNamespace(
                    input_tokens=1000, output_tokens=500,
                    cache_read_input_tokens=0, cache_creation_input_tokens=0),
            )

    class Client:
        messages = Messages()

    return Client(), sent


def test_cost() -> None:
    print("\ncost accounting")

    from dateplanner.models import Usage

    # Opus 5 is $5/MTok in, $25/MTok out. 1M in + 1M out = $30.
    resp = SimpleNamespace(usage=SimpleNamespace(
        input_tokens=1_000_000, output_tokens=1_000_000,
        cache_read_input_tokens=0, cache_creation_input_tokens=0))
    u = planner._usage_of(resp, "claude-opus-5")
    check("input and output are priced separately",
          abs(u.cost_usd - 30.0) < 0.01, f"${u.cost_usd}")

    # Cache reads bill at a tenth of the input rate: 1M cached = $0.50.
    cached = SimpleNamespace(usage=SimpleNamespace(
        input_tokens=0, output_tokens=0,
        cache_read_input_tokens=1_000_000, cache_creation_input_tokens=0))
    u2 = planner._usage_of(cached, "claude-opus-5")
    check("cached input is a tenth of the price",
          abs(u2.cost_usd - 0.50) < 0.01, f"${u2.cost_usd}")

    # Cache writes cost a premium, which is why the system prompt is written
    # once and read many times.
    written = SimpleNamespace(usage=SimpleNamespace(
        input_tokens=0, output_tokens=0,
        cache_read_input_tokens=0, cache_creation_input_tokens=1_000_000))
    u3 = planner._usage_of(written, "claude-opus-5")
    check("writing the cache costs more than plain input",
          abs(u3.cost_usd - 6.25) < 0.01, f"${u3.cost_usd}")

    check("a cheaper model is priced lower",
          planner._usage_of(resp, "claude-haiku-4-5").cost_usd
          < planner._usage_of(resp, "claude-opus-5").cost_usd)

    total = Usage()
    total.add(u)
    total.add(u2)
    check("usage accumulates across calls", total.calls == 2)
    check("cost accumulates across calls", abs(total.cost_usd - 30.5) < 0.01)


def test_repair() -> None:
    """The correction pass. Its one hard guarantee is that it can never make
    a plan worse, so that is what most of this checks."""
    print("\nrepair pass")

    over = good_plan()
    over.stops[1].cost = 900.0       # way over the EUR 150 budget
    over.total_cost = 900.0

    fixed = good_plan()              # clean

    worse = good_plan()
    worse.stops[1].cost = 900.0
    worse.total_cost = 900.0
    worse.stops[1].dress_code = "formal"   # over budget AND a door policy problem

    repair_cfg = cfg(llm={"repair": True, "max_repairs": 1})
    real = planner._client

    try:
        # A draft with problems, then a clean second pass.
        client, sent = stub_client(over, fixed)
        planner._client = lambda: client
        p = planner.plan(prefs(), repair_cfg)
        check("a broken draft is repaired", p.warnings == [], str(p.warnings))
        check("the repaired plan is marked as repaired", p.repaired is True)
        check("repairing costs a second call", len(sent) == 2, str(len(sent)))
        check("the repair prompt states the specific problem",
              "Over budget" in sent[1], sent[1][-400:])
        check("the repair prompt includes the rejected draft",
              "You already drafted this" in sent[1])
        check("the repair prompt repeats the original brief",
              "Plan a date in" in sent[1])
        check("both calls are counted", p.usage.calls == 2, str(p.usage.calls))

        # A repair that does not help must be discarded, not accepted.
        client, sent = stub_client(over, worse)
        planner._client = lambda: client
        p = planner.plan(prefs(), repair_cfg)
        check("a repair that does not improve things is rejected",
              p.repaired is False)
        check("the original draft is kept when the repair is worse",
              any("Over budget" in w for w in p.warnings))
        check("no more than one repair is attempted", len(sent) == 2)

        # A clean first answer must not trigger a second call at all.
        client, sent = stub_client(fixed)
        planner._client = lambda: client
        p = planner.plan(prefs(), repair_cfg)
        check("a clean plan is not repaired", len(sent) == 1 and not p.repaired)

        # Turning it off means one call, warnings surfaced as before.
        client, sent = stub_client(over, fixed)
        planner._client = lambda: client
        p = planner.plan(prefs(), cfg(llm={"repair": False}))
        check("repair can be switched off", len(sent) == 1, str(len(sent)))
        check("with repair off the warnings still surface", p.warnings != [])

        # A truncated response is worse than no response: it is a half plan.
        client, sent = stub_client(fixed, stop_reason="max_tokens")
        planner._client = lambda: client
        p = planner.plan(prefs(), repair_cfg)
        check("hitting max_tokens falls back rather than returning half a plan",
              p.generated_by == "offline")
    finally:
        planner._client = real


def test_research() -> None:
    """The scouting pass: a web search before planning, so the itinerary is
    built from what is open now rather than from training data."""
    print("\nscouting pass")

    from dateplanner import research
    from dateplanner.models import Usage

    p = prefs(interests=["jazz"], party_note="vegetarian")

    # --- the question it asks -----------------------------------------
    q = research._question(p, DRY)
    check("the scout is told where", "Lisbon" in q)
    check("the scout gets the coordinates", "38.7223" in q)
    check("the scout is told the budget", "EUR 150" in q)
    check("the scout is told the radius", "1.5 km" in q)
    check("the scout is told the interests", "jazz" in q)
    check("the scout is told the hard constraints", "vegetarian" in q)
    check("the scout is told the date", "October" in q, q[:120])

    # --- the tool definition ------------------------------------------
    tool = research._tool(p, {"max_searches": 4})
    check("the search tool is named web_search", tool["name"] == "web_search")
    check("the search tool version is the dynamic-filtering one",
          tool["type"] == "web_search_20260209", tool["type"])
    check("the search count is capped", tool["max_uses"] == 4)
    check("results are localised to the city",
          tool["user_location"] == {"type": "approximate", "city": "Lisbon"},
          str(tool.get("user_location")))
    # A country code the API does not recognise is a 400, and the app only has
    # a country *name* from the geocoder - so it must not send one.
    check("no country code is guessed", "country" not in tool["user_location"])
    check("the tool version is configurable",
          research._tool(p, {"search_tool": "web_search_20250305"})["type"]
          == "web_search_20250305")

    # --- a normal run --------------------------------------------------
    def block(**kw):
        kw.setdefault("citations", None)
        return SimpleNamespace(**kw)

    def response(stop_reason="end_turn", searches=2, content=None):
        return SimpleNamespace(
            stop_reason=stop_reason,
            content=content if content is not None else [
                block(type="text", text="Found three places."),
                block(type="web_search_tool_result", content=[
                    SimpleNamespace(url="https://a.example/x", title="A"),
                    SimpleNamespace(url="https://b.example/y", title="B"),
                ]),
            ],
            usage=SimpleNamespace(input_tokens=1000, output_tokens=400,
                                  cache_read_input_tokens=0, cache_creation_input_tokens=0,
                                  server_tool_use=SimpleNamespace(web_search_requests=searches)),
        )

    class One:
        def __init__(self, *rs): self.queue = list(rs); self.calls = []
        class _M:
            pass
        @property
        def messages(self):
            outer = self
            m = self._M()
            def create(**kw):
                outer.calls.append(kw)
                return outer.queue.pop(0)
            m.create = create
            return m

    u = Usage()
    c = One(response())
    got = research.gather(c, p, DRY, {}, u)
    check("the scout returns notes", got is not None and "Found three places" in got.notes)
    check("sources are collected", len(got.sources) == 2, str(len(got.sources)))
    check("sources keep their titles", got.sources[0].title == "A")
    check("searches are counted", got.searches == 2)
    check("the search tool is actually attached",
          c.calls[0]["tools"][0]["name"] == "web_search")
    check("the scout call is not a structured-output call",
          "output_format" not in c.calls[0])
    check("the scout system prompt is cached",
          c.calls[0]["system"][0]["cache_control"] == {"type": "ephemeral"})

    # $10 per 1000 searches, on top of tokens - the cost line must say so.
    tokens_only = planner._usage_of(response(), "claude-opus-5").cost_usd
    check("each search adds its own cost",
          abs(u.cost_usd - (tokens_only + 2 * research.SEARCH_COST_USD)) < 1e-6,
          f"{u.cost_usd} vs {tokens_only}")
    check("searches are recorded on the usage", u.searches == 2)

    # --- pause_turn ----------------------------------------------------
    u2 = Usage()
    c2 = One(response(stop_reason="pause_turn"), response())
    got2 = research.gather(c2, p, DRY, {}, u2)
    check("a paused turn is resumed", got2 is not None and len(c2.calls) == 2)
    check("resuming sends the paused assistant turn back",
          c2.calls[1]["messages"][-1]["role"] == "assistant")
    check("resuming adds no 'continue' message",
          len(c2.calls[1]["messages"]) == 2, str(len(c2.calls[1]["messages"])))
    check("searches accumulate across a resume", u2.searches == 4, str(u2.searches))

    # A turn that never stops pausing must still return what it has.
    c3 = One(*[response(stop_reason="pause_turn") for _ in range(6)])
    got3 = research.gather(c3, p, DRY, {}, Usage())
    check("an endlessly paused turn gives up and uses what it has",
          got3 is not None and len(c3.calls) == research.MAX_CONTINUATIONS + 1,
          str(len(c3.calls)))

    # --- failures ------------------------------------------------------
    refused = One(response(stop_reason="refusal"))
    check("a refusal returns nothing rather than half a briefing",
          research.gather(refused, p, DRY, {}, Usage()) is None)

    empty = One(response(content=[block(type="text", text="   ")]))
    check("empty notes count as a failure",
          research.gather(empty, p, DRY, {}, Usage()) is None)

    # A failed search returns 200 with an error object where the list goes.
    broke = One(response(content=[
        block(type="text", text="Could not search."),
        block(type="web_search_tool_result",
              content=SimpleNamespace(type="web_search_tool_result_error",
                                      error_code="max_uses_exceeded")),
    ]))
    out = research.gather(broke, p, DRY, {}, Usage())
    check("a search error does not crash the scout", out is not None)
    check("a search error yields no sources", out.sources == [])

    # --- sources -------------------------------------------------------
    dupes = One(response(content=[
        block(type="text", text="notes", citations=[
            SimpleNamespace(url="https://a.example/x", title="A again")]),
        block(type="web_search_tool_result", content=[
            SimpleNamespace(url="https://a.example/x", title="A"),
            SimpleNamespace(url="https://a.example/x", title="A"),
        ]),
    ]))
    out2 = research.gather(dupes, p, DRY, {}, Usage())
    check("the same page is only listed once", len(out2.sources) == 1, str(len(out2.sources)))

    # --- how it reaches the planner ------------------------------------
    plan_with_notes = planner._user_message(p, DRY, "SCOUT SAYS: Ramiro is open until 00:30.")
    check("the notes reach the planning prompt", "Ramiro is open" in plan_with_notes)
    check("the planner is told to trust the notes over memory",
          "Prefer these places over anywhere you remember" in plan_with_notes)
    check("without notes the prompt says nothing about a scout",
          "scout" not in planner._user_message(p, DRY).lower())


def test_model_failure_falls_back() -> None:
    print("\nmodel failure")

    class Refusing:
        class messages:
            @staticmethod
            def parse(**kwargs):
                return SimpleNamespace(stop_reason="refusal", parsed_output=None,
                                       usage=SimpleNamespace(input_tokens=1, cache_read_input_tokens=0,
                                                             output_tokens=0))

    class Exploding:
        class messages:
            @staticmethod
            def parse(**kwargs):
                raise RuntimeError("boom")

    real_client = planner._client
    try:
        planner._client = lambda: Refusing()
        p = planner.plan(prefs(), cfg())
        check("a refusal falls back to the offline planner", p.generated_by == "offline")

        # An unexpected exception is the planner's problem, not the user's -
        # but it must not be swallowed into a blank page either.
        planner._client = lambda: Exploding()
        try:
            planner.plan(prefs(), cfg())
            check("an unexpected error is not silently swallowed", False, "no exception raised")
        except RuntimeError:
            check("an unexpected error surfaces to the caller", True)
    finally:
        planner._client = real_client

    p = planner.plan(prefs(), cfg(llm={"enabled": False}))
    check("llm.enabled=false never calls the API", p.generated_by == "offline")


def test_defaults() -> None:
    print("\ndefaults")

    sat = planner._next_saturday(date(2026, 9, 19))  # a Saturday
    check("the default date is always the NEXT Saturday, never today",
          sat == date(2026, 9, 26), str(sat))
    check("the default date from midweek is the coming Saturday",
          planner._next_saturday(date(2026, 9, 23)) == date(2026, 9, 26))

    # resolve() geocodes when coordinates are missing, so stub the lookup
    # rather than letting the test suite reach Open-Meteo.
    real_first = geo.first
    geo.first = lambda q: geo.Place("Porto", 41.1579, -8.6291, "Portugal")
    try:
        p = Prefs(location="Porto", weather=DRY)
        resolved, w = planner.resolve(p)
        check("an unset date is filled in", resolved.on is not None)
        check("an unset start time defaults to 17:00", resolved.start_time == time(17, 0))
        check("a supplied forecast is used as-is, with no lookup", w is DRY)
        check("a bare place name is resolved to coordinates", resolved.has_coords)
        check("the resolved location is qualified with its country",
              "Portugal" in resolved.location, resolved.location)

        manual = Prefs(location="Porto", weather=Weather(summary="humid"))
        _, w2 = planner.resolve(manual)
        check("a hand-typed forecast is marked manual", w2.source == "manual")

        # Supplied coordinates must win: they came from the picker or the
        # phone, and re-geocoding the display text could move the date.
        exact = Prefs(location="Alfama", lat=38.7139, lon=-9.1289, weather=DRY)
        planner.resolve(exact)
        check("supplied coordinates are not overwritten by a lookup",
              (exact.lat, exact.lon) == (38.7139, -9.1289))
        check("supplied coordinates leave the typed location alone",
              exact.location == "Alfama", exact.location)
    finally:
        geo.first = real_first

    # A location nobody can place still has to produce a date.
    geo.first = lambda q: None
    try:
        nowhere = Prefs(location="Xyzzy", weather=DRY)
        resolved, _ = planner.resolve(nowhere)
        check("an unplaceable location still resolves", resolved.location == "Xyzzy")
        check("an unplaceable location has no coordinates", not resolved.has_coords)
    finally:
        geo.first = real_first


def test_server_input() -> None:
    print("\nserver input handling")

    p = server._prefs_from({
        "location": "Lisbon", "budget": 120, "interests": "jazz, photography , ",
        "on": "", "start_time": "", "weather": "cold and wet", "hours": 4,
    })
    check("comma-separated interests are split",
          p.interests == ["jazz", "photography"], str(p.interests))
    check("empty date strings are dropped rather than rejected", p.on is None)
    check("a typed weather string becomes a Weather", isinstance(p.weather, Weather))
    check("a typed weather string keeps its teeth", p.weather.is_wet and p.weather.is_cold)

    p2 = server._prefs_from({"location": "Lisbon", "interests": ["a", "b"]})
    check("an interests list is accepted as-is", p2.interests == ["a", "b"])
    check("budget falls back to its default", p2.budget == 150.0)

    # The hidden lat/lon inputs are empty until the user picks a place or
    # taps the location button, and "" is not a float.
    blank = server._prefs_from({"location": "Lisbon", "lat": "", "lon": ""})
    check("empty coordinate fields are dropped, not rejected", not blank.has_coords)

    picked = server._prefs_from({"location": "Alfama", "lat": "38.7139", "lon": "-9.1289"})
    check("picked coordinates are parsed as numbers",
          picked.has_coords and abs(picked.lat - 38.7139) < 1e-9)

    # Half a coordinate pair would silently anchor the plan on the equator.
    half = server._prefs_from({"location": "Lisbon", "lat": "38.71"})
    check("half a coordinate pair is discarded", not half.has_coords)

    check("a walking date gets a tight radius",
          server._prefs_from({"location": "x", "transportation": "walking"}).radius_km == 1.5)
    check("a car date gets a wide radius",
          server._prefs_from({"location": "x", "transportation": "car"}).radius_km == 12.0)

    try:
        server._prefs_from({"budget": 100})
        check("a request with no location is rejected", False, "no error raised")
    except Exception:
        check("a request with no location is rejected", True)


def _unfound(plan, affiliates_mod, pr):
    """A plan whose venue was searched for and not found."""
    plan.stops[1].looked_up = True
    plan.stops[1].verified = False
    affiliates_mod.attach(plan, "Lisbon", {})
    return plan


def test_render() -> None:
    print("\nrender")

    p = good_plan()
    affiliates.attach(p, "Lisbon", {})
    pr = prefs()

    txt = render.to_text(p, pr)
    check("the text output names every stop", all(s.name in txt for s in p.stops))
    check("the text output shows the arc", "→" in txt)
    check("the text output marks a free stop as free", "free" in txt)
    check("the text output shows the currency", "EUR" in txt)

    html = render.to_html(p, pr)
    check("the HTML output is a complete document",
          html.startswith("<!doctype html>") and html.rstrip().endswith("</html>"))
    check("the HTML output names every stop", all(s.name in html for s in p.stops))
    check("the HTML output carries the booking links", p.stops[1].book_url in html)

    # The model writes these strings; an unescaped apostrophe or ampersand in a
    # venue name must not be able to break the page.
    nasty = good_plan()
    nasty.stops[0].name = 'Bar <script>alert("x")</script> & Grill'
    affiliates.attach(nasty, "Lisbon", {})
    out = render.to_html(nasty, pr)
    check("venue names are HTML-escaped", "<script>" not in out)
    check("escaped names still render their text", "&amp; Grill" in out)

    warned = good_plan()
    warned.warnings = ["Over budget by EUR 40."]
    check("warnings reach the HTML", "Over budget" in render.to_html(warned, pr))
    check("warnings reach the text", "Over budget" in render.to_text(warned, pr))

    # The exported plan must not be a lesser version of the app: whatever the
    # venue lookup found should reach the file you send to the other person.
    rich = good_plan()
    v = rich.stops[1]
    v.looked_up = v.verified = True
    v.venue_kind, v.cuisine, v.distance_m = "Restaurant", "seafood", 916
    v.address, v.opening_hours = "104 Avenida Almirante Reis", "Tu-Su 12:00-00:30"
    v.website, v.rating, v.ratings_count = "https://example.org", 4.6, 1204
    rich.sources = [{"url": "https://timeout.com/lisbon", "title": "Best bars right now"}]
    affiliates.attach(rich, "Lisbon", {})

    txt, htm = render.to_text(rich, pr), render.to_html(rich, pr)
    for label, doc in (("text", txt), ("HTML", htm)):
        check(f"the {label} export shows what kind of place it is", "Restaurant" in doc)
        check(f"the {label} export shows the distance", "916 m away" in doc)
        check(f"the {label} export shows opening hours", "12:00-00:30" in doc)
        check(f"the {label} export shows the address", "Almirante Reis" in doc)
        check(f"the {label} export shows the rating", "4.6" in doc)
        check(f"the {label} export credits the sources", "timeout.com" in doc or "Best bars" in doc)

    check("the text export flags an unfound venue",
          "check this place exists" in render.to_text(
              _unfound(good_plan(), affiliates, pr), pr))
    check("the HTML export credits the ratings provider",
          "Google Maps" in htm)

    osm_only = good_plan()
    osm_only.stops[1].looked_up = osm_only.stops[1].verified = True
    osm_only.stops[1].source = "osm"
    check("the HTML export credits OpenStreetMap when there are no ratings",
          "OpenStreetMap" in render.to_html(osm_only, pr))


def test_env() -> None:
    """The .env loader. Small, but it handles a secret, so the rules about
    what wins and what never gets logged are worth pinning down."""
    print("\nenv file")

    import os
    import tempfile
    from pathlib import Path

    from dateplanner import env

    tmp = Path(tempfile.mkdtemp())

    check("a missing .env is not an error", env.load(tmp / "nope.env") == [])

    f = tmp / ".env"
    f.write_text(
        "# a comment\n"
        "\n"
        "DP_TEST_PLAIN=abc\n"
        'DP_TEST_QUOTED="quoted value"\n'
        "DP_TEST_SINGLE='single'\n"
        "export DP_TEST_EXPORT=exported\n"
        "DP_TEST_EXISTING=from-file\n"
        "not a key value line\n",
        encoding="utf-8",
    )

    os.environ["DP_TEST_EXISTING"] = "from-environment"
    for k in ("DP_TEST_PLAIN", "DP_TEST_QUOTED", "DP_TEST_SINGLE", "DP_TEST_EXPORT"):
        os.environ.pop(k, None)

    try:
        loaded = env.load(f)
        check("a plain KEY=value is loaded", os.environ.get("DP_TEST_PLAIN") == "abc")
        check("double quotes are stripped",
              os.environ.get("DP_TEST_QUOTED") == "quoted value")
        check("single quotes are stripped", os.environ.get("DP_TEST_SINGLE") == "single")
        check("a leading 'export' is tolerated",
              os.environ.get("DP_TEST_EXPORT") == "exported")

        # The important one: a variable set for real must not be clobbered by
        # a stale file, or `KEY=x python run.py` would not behave as expected.
        check("the real environment beats the file",
              os.environ.get("DP_TEST_EXISTING") == "from-environment")
        check("an already-set name is not reported as loaded",
              "DP_TEST_EXISTING" not in loaded, str(loaded))

        check("a malformed line is skipped, not fatal", "DP_TEST_PLAIN" in loaded)
        check("comments and blank lines are ignored", len(loaded) == 4, str(loaded))
        check("load reports names only, never values",
              all("=" not in name for name in loaded))
    finally:
        for k in ("DP_TEST_PLAIN", "DP_TEST_QUOTED", "DP_TEST_SINGLE",
                  "DP_TEST_EXPORT", "DP_TEST_EXISTING"):
            os.environ.pop(k, None)
        f.unlink(missing_ok=True)
        tmp.rmdir()


def test_jobs() -> None:
    """Planning runs in the background and the page polls for the phase.

    A full plan is a web search, two model calls and a throttled lookup per
    stop; holding a request open that long is how a working app comes to look
    broken.
    """
    print("\nbackground jobs")

    import time as _t

    # Phase names shown to the user must exist for every phase the planner
    # reports, or the button goes blank mid-wait.
    offline = []
    planner.plan(prefs(), cfg(), progress=offline.append)
    check("the offline path reports start and finish",
          offline == ["locating", "done"], str(offline))

    # The path that actually takes a minute is the one with the model in it,
    # and that is the one whose phases have to be nameable.
    full = []
    client, _ = stub_client(good_plan())
    real = planner._client
    try:
        planner._client = lambda: client
        planner.plan(prefs(), cfg(llm={"web_search": False}), progress=full.append)
    finally:
        planner._client = real
    check("the model path reports planning", "planning" in full, str(full))
    check("the phases arrive in order",
          full.index("locating") < full.index("planning") < full.index("done"),
          str(full))
    check("every reported phase has a label",
          all(ph in planner.PHASES for ph in offline + full), str(offline + full))
    check("the last phase is always done", full[-1] == "done", str(full))

    server.JOBS.clear()

    # Whether the job is still running when `_start` returns is a race - an
    # offline plan can finish first on a fast machine, which made this flaky.
    # The property that actually matters is that `_start` does not wait for
    # the plan, so hold the plan open and check it returned anyway.
    import threading as _th
    release = _th.Event()
    real_plan = planner.plan

    def slow(*a, **k):
        release.wait(5)
        return real_plan(*a, **k)

    try:
        planner.plan = slow
        held = server._start(prefs(), cfg())
        check("starting a plan does not wait for it", held.state == "running")
        check("the job gets an id", len(held.id) == 16)
        check("a running job reports a phase a human can read",
              held.status()["label"] in planner.PHASES.values())
    finally:
        release.set()
        planner.plan = real_plan

    job = server._start(prefs(), cfg())

    for _ in range(80):                     # offline planning is fast
        if job.state != "running":
            break
        _t.sleep(0.05)

    check("the job finishes", job.state == "done", job.state + " " + job.error)
    s = job.status()
    check("a finished job carries the plan", "plan" in s and s["plan"]["stops"])
    check("a finished job carries the prefs", "prefs" in s)
    check("a finished job carries the arc", "arc" in s)
    check("the status reports elapsed time", s["elapsed"] >= 0)
    check("the status carries a human label", s["label"] == "Done")

    # A planning failure must end the job, not leave the page polling forever.
    real = planner.plan
    try:
        planner.plan = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        bad = server._start(prefs(), cfg())
        for _ in range(80):
            if bad.state != "running":
                break
            _t.sleep(0.05)
        check("a crashed plan ends as an error, not a hang", bad.state == "error")
        check("the error status carries a message", bad.status()["error"])
        check("the error message does not leak the traceback",
              "boom" not in bad.status()["error"])
    finally:
        planner.plan = real

    # The job table is keyed on user input in a long-lived process, so it has
    # to be swept.
    old = server.Job("stale")
    old.state, old.finished = "done", _t.monotonic() - server.JOB_TTL - 10
    wedged = server.Job("wedged")
    wedged.started = _t.monotonic() - server.JOB_TIMEOUT - 10
    fresh = server.Job("fresh")
    server.JOBS.update({"stale": old, "wedged": wedged, "fresh": fresh})
    server._reap()
    check("finished jobs are eventually dropped", "stale" not in server.JOBS)
    check("a wedged job is dropped too", "wedged" not in server.JOBS)
    check("a live job survives the sweep", "fresh" in server.JOBS)
    server.JOBS.clear()

    index = (Path(server.WEB) / "index.html").read_text(encoding="utf-8")
    check("the page polls for the job", "/api/plan?job=" in index)
    check("the page shows the phase while waiting", "s.label" in index)
    check("the page gives up rather than spinning forever",
          "PLAN_TIMEOUT_MS" in index)
    check("a dropped poll does not abandon a running plan",
          "One dropped poll is not a failed plan" in index)


def test_app_shell() -> None:
    """The installable-app bits. A manifest that points at a missing icon
    fails silently in the browser, so check the wiring here instead."""
    print("\napp shell")

    import json as _json
    from pathlib import Path

    web = Path(server.WEB)
    manifest_path = web / "manifest.webmanifest"
    check("the manifest exists", manifest_path.exists())

    manifest = _json.loads(manifest_path.read_text(encoding="utf-8"))
    check("the manifest declares standalone display", manifest["display"] == "standalone")
    check("the manifest has a start url", manifest["start_url"] == "/")

    icons = manifest["icons"]
    missing = [i["src"] for i in icons if not (web / i["src"].lstrip("/")).exists()]
    check("every icon the manifest declares exists on disk", not missing, str(missing))

    sizes = {i["sizes"] for i in icons}
    check("the manifest offers both install sizes", {"192x192", "512x512"} <= sizes, str(sizes))
    check("one icon is maskable, or Android crops the mark badly",
          any(i.get("purpose") == "maskable" for i in icons))

    index = (web / "index.html").read_text(encoding="utf-8")
    check("the page links the manifest", 'rel="manifest"' in index)
    check("the page declares an apple touch icon", "apple-touch-icon" in index)
    check("the page sets a theme colour", 'name="theme-color"' in index)
    check("the page registers the service worker", "serviceWorker" in index)
    check("service worker registration is gated on a secure context",
          "isSecureContext" in index)
    check("the page handles the install prompt", "beforeinstallprompt" in index)
    check("the page offers a location button", "/api/where" in index)
    check("the page uses the autocomplete endpoint", "/api/places" in index)
    check("the page keeps the last plan for offline use", "localStorage" in index)

    # "Failed to fetch" is what the browser says when the page is opened off
    # the disk, or when the server has stopped. Both are easy to hit and the
    # default message names neither, so the page has to.
    # An editor preview of this file (data:/blob:) looks identical to the real
    # app but has no server behind it. Checking for http/https rather than
    # excluding file: is what catches that case too.
    check("the page detects not being served",
          "location.protocol === 'http:'" in index and "const SERVED" in index)
    check("an unserved page disables the button instead of failing on click",
          "Not the running app" in index)
    check("the page warns up front when the server has no API key",
          "has_key" in index)

    # --- phone-shaped problems, each found by actually looking at it -----

    # `svh` does not shrink for the software keyboard, so the button sat
    # behind it on every screen with a text field.
    check("the layout follows the visual viewport, not just svh",
          "visualViewport" in index and "--vh" in index)
    check("a focused field is scrolled clear of the keyboard",
          "scrollIntoView" in index and "focusin" in index)

    # A screen taller than the phone scrolled with no sign that it did, so
    # the fifth option did not exist as far as the user knew.
    check("an overflowing screen shows it can be scrolled",
          "#f.more::after" in index and "more-hint" in index)
    check("the scroll hint is cleared when the deck is gone",
          "!d.hidden &&" in index)

    # requestAnimationFrame is deferred indefinitely on a page that is not
    # being painted - switch apps mid-form and every queued callback fired
    # at once, stacking every question on top of every other.
    check("screen transitions do not depend on requestAnimationFrame",
          "requestAnimationFrame(" not in index)   # the call, not the comment
    check("the transition start state is flushed synchronously",
          "void el.offsetWidth" in index)

    # Only two of five option cards fitted on a phone.
    check("short viewports get a compact layout", "@media (max-height:860px)" in index)
    check("the no-key warning points at the diagnostic", "--check-key" in index)

    # --- transitions ----------------------------------------------------
    # Going back used to animate identically to going forward: the entering
    # screen always started below, so the motion said nothing about which way
    # you had moved.
    for _cls in ("enter-up", "enter-down", "exit-up", "exit-down"):
        check(f"the deck has a {_cls} state", f".screen.{_cls}{{" in index)
    check("direction is taken from the direction of travel",
          "back ? 'enter-down' : 'enter-up'" in index
          and "back ? 'exit-down' : 'exit-up'" in index)
    check("going back skips the stagger", ".screen.active.quick > *" in index)

    # The reduced-motion override has to name every direction class:
    # `.screen.enter-up` is a two-class selector and out-specifies a bare
    # `.screen{transform:none}`, so renaming the classes silently handed
    # motion back to people who had asked for none.
    _reduced = index[index.index("@media (prefers-reduced-motion"):]
    _reduced = _reduced[:_reduced.index("</style>")]
    for _cls in ("enter-up", "enter-down", "exit-up", "exit-down"):
        check(f"reduced motion also neutralises {_cls}", _cls in _reduced)
    check("reduced motion stops the results animation too",
          "#out.on{animation:none}" in _reduced)

    # One clock for the whole gesture, rather than three.
    check("the stage and the screens share a duration",
          "transition:height .34s" in index and "transform .34s" in index)
    check("the results view arrives rather than cutting in",
          "@keyframes arrive" in index)
    check("a chosen option card acknowledges the tap", "@keyframes chose" in index)

    # Touch has no hover, so without a press state every tap reads as lag.
    for _sel in (".go:active", ".btn:active", ".back:active", ".chip:active"):
        check(f"{_sel} gives press feedback", _sel in index)

    # The scroll-affordance check was timed to the old .5s stage and kept
    # firing after the move had finished.
    check("the affordance check is timed to the current stage duration",
          "setTimeout(affordance, 360)" in index)
    check("the progress bar shares the same clock",
          "transition:width .34s" in index)

    # A tile served from cache finishes before any handler is attached, so
    # `complete` has to be checked too - otherwise the second plan you make
    # has an invisible map.
    check("map tiles fade in", ".map img.on{opacity:1}" in index)
    check("a cached tile is revealed rather than left invisible",
          "img.complete && img.naturalWidth > 0" in index)
    check("a failed tile does not leave a permanent hole",
          "'error'" in index)
    check("the stop stagger is capped", "Math.min(i * 55, 220)" in index)

    # The secret must never be serialisable out of the process.
    srv = (Path(server.__file__)).read_text(encoding="utf-8")
    check("the server reports key presence as a boolean, never the key",
          'bool(os.environ.get("ANTHROPIC_API_KEY"))' in srv)
    check("the page names the fix when there is no server",
          "run.py --serve" in index)
    check("a dead server is told apart from being offline",
          "navigator.onLine" in index and "TypeError" in index)

    sw = (web / "sw.js").read_text(encoding="utf-8")
    check("the service worker exists and versions its cache", "VERSION" in sw)
    check("the service worker never caches API responses", "/api/" in sw)
    for asset in ("/icons/icon-192.png", "/manifest.webmanifest"):
        check(f"the shell precaches {asset}", asset in sw)

    # The static handler serves from a folder that sits next to the API key
    # holder, so the traversal guard matters more than the 404 does.
    check("every extension the app serves is allowlisted",
          {".html", ".js", ".webmanifest", ".png"} <= set(server.STATIC))
    check("python files are not servable", ".py" not in server.STATIC)



def test_static_app() -> None:
    """The browser build in docs/, which is what GitHub Pages serves.

    None of this can be checked by running the Python app - it is a separate
    implementation - and every failure here is silent in a browser: a path
    that resolves to the domain root just 404s into an empty page.
    """
    print("\nstatic app (docs/)")

    import json as _json
    import re as _re
    from pathlib import Path

    docs = Path(__file__).resolve().parent / "docs"
    check("the static app exists", docs.is_dir())

    index = (docs / "index.html").read_text(encoding="utf-8")
    app = (docs / "app.js").read_text(encoding="utf-8")
    sw = (docs / "sw.js").read_text(encoding="utf-8")
    lib = {p.name: p.read_text(encoding="utf-8") for p in sorted((docs / "lib").glob("*.js"))}

    # --- Pages serves a project site from a subpath -----------------------
    #
    # https://you.github.io/kindling/ - so a leading "/" points at
    # you.github.io itself. This is the single most likely way the deploy
    # breaks while working perfectly on localhost.
    for attr in ('href="/', 'src="/'):
        bad = index.count(attr)
        check(f"the page has no absolute {attr[:-2]}", bad == 0, f"{bad} found")
    check("Jekyll is disabled, so no filename is reinterpreted",
          (docs / ".nojekyll").exists())

    # --- every module it imports is actually there ------------------------
    sources = {docs / "app.js": app}
    sources.update({docs / "lib" / n: t for n, t in lib.items()})
    missing = [f"{path.name} -> {spec}"
               for path, text in sources.items()
               for spec in _re.findall(r"from\s+'(\.[^']+)'", text)
               if not (path.parent / spec).exists()]
    check("every imported module exists on disk", not missing, str(missing))
    check("the page loads the app as a module", 'type="module"' in index)

    # --- no server ---------------------------------------------------------
    #
    # The whole point of this build. One leftover /api/ call and the app
    # works only on the machine it was developed on.
    for name, text in [("app.js", app), *lib.items()]:
        check(f"{name} calls no local endpoint", "/api/" not in text)

    # --- the service worker, resolved relative to itself -------------------
    check("the service worker resolves paths against its own location",
          "new URL('./', self.location)" in sw)
    precached = _re.findall(r"at\('([^']+)'\)", sw)
    gone = [p for p in precached if p != "./" and not (docs / p).exists()]
    check("every precached file exists on disk", not gone, str(gone))
    check("the service worker never caches third-party data",
          "url.origin !== self.location.origin" in sw)
    check("the cache is versioned", "VERSION" in sw)

    # A deploy that does not touch sw.js leaves the worker byte-identical, so
    # the browser never reinstalls it. Under plain cache-first that means a
    # returning visitor never sees the new app at all - the fix sits on the
    # server while the cached bug keeps being served. Observed live on the
    # first redeploy, not theorised.
    check("static assets are refreshed in the background, not cached forever",
          "caches.match(request).then(hit => {" in sw and "return hit || fresh;" in sw)
    check("the page itself is network-first, so a redeploy lands",
          "request.mode === 'navigate'" in sw)

    manifest = _json.loads((docs / "manifest.webmanifest").read_text(encoding="utf-8"))
    check("the manifest starts at the app, not the domain root",
          manifest["start_url"] == "./" and manifest["scope"] == "./")
    absent = [i["src"] for i in manifest["icons"] if not (docs / i["src"]).exists()]
    check("every icon the manifest declares exists", not absent, str(absent))
    check("one icon is maskable, or Android crops the mark badly",
          any(i.get("purpose") == "maskable" for i in manifest["icons"]))

    # --- the rules that took a bug each to learn --------------------------
    #
    # Reduced motion: `.screen.enter-up` is a two-class selector, so a bare
    # `.screen{transform:none}` loses to it and people who asked for no
    # motion get it anyway. Every direction class used has to be named.
    block = index[index.index("prefers-reduced-motion"):]
    block = block[:block.index("}\n</style>") + 1] if "}\n</style>" in block else block[:600]
    for cls in ("enter-up", "enter-down", "exit-up", "exit-down"):
        check(f"reduced motion overrides .screen.{cls}", f".screen.{cls}" in block)

    # Tiles inside a short clipped box are judged off-screen and never
    # fetched, which is a blank map rather than a slow one.
    # Only the tile <img> itself - the comment above it says the words, and
    # the Wikipedia photograph further down is lazy on purpose.
    start = app.index("tiles +=")
    tag = app[start:app.index(";", start)]
    check("map tiles are not lazily loaded", "lazy" not in tag)
    check("cached tiles are revealed without waiting for a load event",
          ".complete" in app)

    # Nominatim allows one request a second. One gate, or the limit is a
    # suggestion.
    net = lib["net.js"]
    # places.js owns the endpoints; net.js owns the one-a-second gate. The
    # invariant is that no module reaches Nominatim except through nominatim().
    stray = [n for n, t in lib.items()
             if "nominatim.openstreetmap.org" in t and n != "places.js"]
    check("only places.js names the Nominatim endpoints", not stray, str(stray))
    check("every Nominatim call goes through the rate gate",
          "getJSON(SEARCH" not in lib["places.js"]
          and "getJSON(REVERSE" not in lib["places.js"]
          and "nominatim(" in lib["places.js"])
    check("the Nominatim gate serialises requests", "chain" in net or "queue" in net)
    check("Wikipedia is asked for CORS explicitly", "origin: '*'" in lib["wiki.js"]
          or "origin=*" in lib["wiki.js"])
    check("a photograph is checked against the article's own coordinates",
          "NEAR_KM" in lib["wiki.js"])
    check("a specific place is only accepted near its container",
          "NEAR_KM" in lib["places.js"])
    check("opening hours are read before ordering the evening",
          "closesAt" in lib["plan.js"])
    # The same rules as the Python planner, by name. Each took a live plan
    # going wrong to find, and the browser build is the one people use.
    for rule in ("needUntil", "closeOnTime(", "legs(", "SLACK", "retell(", "!== keep"):
        check(f"plan.js has the {rule.rstrip('(')} rule", rule in lib["plan.js"])
    build_js = lib["plan.js"][lib["plan.js"].index("export async function build"):]
    check("plan.js applies closing times after the trim, not before",
          build_js.index("closeOnTime(stops") > build_js.index("fitWindow(stops,"))
    check("the location picker drops loose matches", "startsWith(typed)" in lib["places.js"])

    # --- the community ------------------------------------------------------
    #
    # The browser holds the anon key, so the database's row-level security is
    # the only real protection. A table without it is readable and writable by
    # anyone who opens the page.
    config = (docs / "config.js").read_text(encoding="utf-8")
    check("config.js never holds the service_role key", "service_role" not in config.replace(
        "Never put the service_role", "")
          and not _re.search(r"eyJ[^'\"]*c2VydmljZV9yb2xl", config))
    schema = (Path(__file__).resolve().parent / "supabase" / "schema.sql").read_text(encoding="utf-8")
    tables = _re.findall(r"create table if not exists public\.(\w+)", schema)
    unguarded = [t for t in tables if f"alter table public.{t} enable row level security" not in schema]
    check("every community table has row-level security", tables and not unguarded, str(unguarded))
    check("every community view runs with the reader's rights",
          all("security_invoker = on" in v
              for v in _re.findall(r"create or replace view[^\n]+", schema)))
    check("counters are set by the database, not the poster",
          "new.love_count   := 0" in schema and "new.hidden       := false" in schema)
    check("nobody can love their own evening", "i.author_id = auth.uid()" in schema)
    check("three reports hide an evening", "r.n >= 3" in schema)
    check("who loved what is private", "for select using (true)" not in
          schema[schema.index("create table if not exists public.reactions"):schema.index("create or replace function public.reactions_count")])
    tab = (docs / "community-tab.js").read_text(encoding="utf-8")
    comm = lib["community.js"]
    check("the community tab stays hidden without a backend", "if (!C.enabled) return;" in tab)
    check("the planner never waits long for the locals", "setTimeout(() => no(new Error('slow'))" in comm)
    check("a sign-in link is wiped from the address bar", "history.replaceState" in comm)
    check("a wrong sign-in code is not mistaken for signing out",
          comm.index("otp_expired") < comm.index("status === 403"))
    check("the guide rule on the page matches the database",
          "GUIDE_POSTS = 3" in comm and "GUIDE_LOVES = 10" in comm
          and "count(*) >= 3 and sum(i.love_count) >= 10" in schema)
    check("community text is escaped before it is shown", tab.count("esc(p.") >= 4)
    # --- phones -------------------------------------------------------------
    #
    # iOS Safari zooms into any focused field under 16px and leaves the page
    # zoomed. Every rule that sizes a form field has to stay at 16px or more,
    # and the fix is never to take pinch-zoom away from people who need it.
    small = []
    for sel, body in _re.findall(r"([^{}]+)\{([^{}]*font-size:\s*[\d.]+px[^{}]*)\}", index):
        if not _re.search(r"\b(input|textarea|select)\b", sel) or "range" in sel:
            continue
        for px in _re.findall(r"font-size:\s*([\d.]+)px", body):
            if float(px) < 16:
                small.append(f"{sel.strip()[-60:]} -> {px}px")
    check("no form field is under 16px, so iOS never zooms into it", not small, str(small))
    viewport = _re.search(r'name="viewport" content="([^"]+)"', index).group(1)
    check("the viewport fits the screen and the notch",
          "width=device-width" in viewport and "viewport-fit=cover" in viewport)
    check("pinch-zoom is never disabled",
          "maximum-scale" not in viewport and "user-scalable" not in viewport)
    check("full-height screens use dynamic viewport units", "100dvh" in index)
    check("the notch is respected on every side",
          all(f"safe-area-inset-{s}" in index for s in ("top", "bottom", "left", "right")))
    check("the questions are pinned to the visible part of the screen",
          "--vvt" in app and "translateY(var(--vvt" in index)
    check("following the keyboard never fights pinch-zoom", "(vv.scale || 1) > 1.01" in app)

    # --- adventure, local-only, and hours by day ------------------------------
    plan_js = lib["plan.js"]
    check("five adventure levels, from a night in to wild",
          all(f"{n}: [" in plan_js for n in range(1, 6)) and "'Stay in'" in plan_js and "'Wild'" in plan_js)
    check("the adventure question is in the form", 'id="adventure"' in index and 'id="local_only"' in index)
    check("local-only drops chains outright", "!localOnly || !isChain(c.name)" in plan_js)
    check("an independent ranks above a chain even without the switch", "(chain(a) - chain(b))" in plan_js)
    check("daylight is a closing time for anything outside", "function shutsAt" in plan_js and "sunset" in plan_js)
    check("an outdoor start moves into daylight", "so you are outside while it is" in plan_js)
    check("a cold plunge always carries its safety warning", "Cold water: never alone" in plan_js)
    check("opening hours are read for the evening's weekday",
          "closesAt(hours, weekday)" in plan_js and "function covers" in lib["places.js"])
    check("the community can share outdoor spots and local treats", "'treat', 'outdoors'" in schema)
    check("the privacy page exists and is linked",
          (docs / "privacy.html").exists() and 'href="privacy.html"' in index)

    # An invented affiliate tag does not earn money - it breaks the link and
    # can close the account.
    partners = _re.search(r"PARTNERS = \{([^}]*)\}", lib["links.js"]).group(1)
    check("no affiliate tag is invented",
          not _re.search(r":\s*'[^']+'", partners), partners.strip())

# ---------------------------------------------------------------------------

def main() -> int:
    # Offline, enforced rather than trusted.
    #
    # Patching `http.get_json` alone does nothing: every module does
    # `from .http import get_json`, which binds the original function into its
    # own namespace at import time. The name has to be replaced in each module
    # that holds a reference - a subtlety that let four tests quietly call
    # Nominatim for a while.
    from dateplanner import http as _http, osm as _osm, places as _places
    from dateplanner import wiki as _wiki
    for _mod in (_http, geo, _osm, wx, _places, _wiki):
        for _name in ("get_json", "post_json"):
            if hasattr(_mod, _name):
                setattr(_mod, _name, no_network)

    # The offline planner composes evenings from real nearby venues, so give
    # it a stubbed source rather than a network.
    _osm.nearby = fake_nearby
    planner.osm.nearby = fake_nearby
    # Wikipedia photos are a network call too. Off by default; the wiki tests
    # drive `_parse` directly against captured payloads.
    _wiki.look = lambda *a, **k: None
    planner.wiki.look = _wiki.look

    for fn in (test_rules, test_weather, test_geo, test_places, test_offline_planner, test_fit_window,
               test_evening_shape,
               test_affiliates, test_model_request, test_cost, test_research, test_repair,
               test_model_failure_falls_back,
               test_defaults, test_server_input, test_render, test_env,
               test_jobs, test_app_shell, test_static_app):
        fn()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + ", ".join(FAILURES))
        return 1
    print("all tests pass")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
