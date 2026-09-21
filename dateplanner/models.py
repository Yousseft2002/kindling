"""The two data structures the whole app moves around: what you asked for
(`Prefs`) and what came back (`Plan`).

`Plan` doubles as the structured-output schema for the model call, so the
field descriptions here are load-bearing - they are the instructions the model
actually reads for each field. Edit them like prompt text, not like docstrings.
"""

from __future__ import annotations

from datetime import date, time

from pydantic import BaseModel, Field, PrivateAttr

# ---------------------------------------------------------------------------
# Vocabularies. Deliberately small closed sets: every one of these values
# changes the *shape* of a date, not just its flavour, and the planner prompt
# has specific rules keyed to each. Adding an option means adding a rule.
# ---------------------------------------------------------------------------

RELATIONSHIP_STAGES = {
    "first_date": "First meeting, probably from an app. Never met in person, or barely.",
    "getting_to_know": "Dates two through five. Interested, still auditioning.",
    "dating": "Established and exclusive. Months in. Comfortable.",
    "long_term": "Years in. Living together or close to it. Routine is the enemy.",
    "special_occasion": "Anniversary, birthday, celebration, or making up for something.",
}

CLOTHING_STYLES = {
    "casual": "Jeans, sneakers, t-shirt.",
    "smart_casual": "Dark denim or chinos, shirt or good knit, clean shoes.",
    "dressy": "Cocktail dress, blazer, heels, leather shoes.",
    "formal": "Suit, gown, jacket-required territory.",
    "streetwear": "Sneakers as the point, not the compromise. Loud is fine.",
    "outdoorsy": "Boots, layers, a jacket that can get rained on.",
}

TRANSPORT = {
    "walking": "On foot only.",
    "transit": "Bus, metro, subway, tram.",
    "car": "Own car. Parking is a real constraint.",
    "rideshare": "Uber/Lyft/taxi, paid per trip out of the same budget.",
    "bike": "Bikes or bikeshare.",
}

# How far apart consecutive stops may sensibly be, per mode. The planner is
# told these numbers directly; the validator re-checks the model against them.
MAX_HOP_MINUTES = {
    "walking": 15,
    "bike": 15,
    "transit": 25,
    "car": 20,
    "rideshare": 20,
}

# How far from the anchor point the whole evening should stay, per mode. The
# planner is given this as a hard radius: it is what stops "a date in London"
# coming back as four excellent places forty minutes apart.
RADIUS_KM = {
    "walking": 1.5,
    "bike": 4.0,
    "transit": 6.0,
    "car": 12.0,
    "rideshare": 8.0,
}

# Dress codes a venue can demand, least to most formal.
DRESS_LADDER = ["casual", "streetwear", "outdoorsy", "smart_casual", "dressy", "formal"]

# What a given style can get into. Dressing *up* past a venue's requirement is
# fine, so this is a floor comparison, not an exact match. This exists to catch
# the failure mode where a plan sends someone in sneakers to a jacket-required
# dining room and the evening ends at the host stand.
STYLE_RANK = {"casual": 1, "streetwear": 1, "outdoorsy": 1, "smart_casual": 2, "dressy": 3, "formal": 4}
VENUE_RANK = dict(STYLE_RANK)

# Stop kinds. Not cosmetic - these route each stop to a booking partner in
# affiliates.PROVIDER_BY_KIND, which is where the revenue comes from.
STOP_KINDS = [
    "walk",       # a route, a park, a waterfront, a neighbourhood
    "viewpoint",  # sunset spot, overlook, free rooftop
    "activity",   # museum, gallery, climbing, pottery, boat, tour
    "coffee",
    "drinks",     # bar, wine bar, cocktails
    "food",       # restaurant, tasting menu, street food, dessert
    "music",      # live music, jazz club, gig, DJ
    "show",       # theatre, comedy, cinema, sport
    "shopping",   # market, bookshop, record store
]


class Usage(BaseModel):
    """What one plan cost to produce.

    Kept because this app has two numbers that decide whether it is a business:
    the affiliate commission a plan could earn (`affiliates.revenue_estimate`)
    and what the plan cost to generate. Printing one without the other is how
    you end up confidently upside-down.

    `cache_read` is also the first thing to check on a live run: if it stays
    zero across repeated plans, the system prompt is not byte-stable and every
    request is paying full price for it.
    """

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    searches: int = 0          # web searches, billed on top of tokens
    cost_usd: float = 0.0

    def add(self, other: "Usage") -> None:
        self.calls += other.calls
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens
        self.searches += other.searches
        self.cost_usd = round(self.cost_usd + other.cost_usd, 6)

    def brief(self) -> str:
        bits = [f"{self.calls} call{'s' if self.calls != 1 else ''}"]
        if self.searches:
            bits.append(f"{self.searches} search{'es' if self.searches != 1 else ''}")
        bits.append(f"{self.input_tokens} in"
                    + (f" ({self.cache_read_tokens} cached)" if self.cache_read_tokens else ""))
        bits.append(f"{self.output_tokens} out")
        bits.append(f"${self.cost_usd:.4f}")
        return ", ".join(bits)


class Weather(BaseModel):
    """Forecast for the date window, or a hand-typed override."""

    summary: str = "unknown"
    high_c: float | None = None
    low_c: float | None = None
    precip_chance: int | None = None
    wind_kph: float | None = None
    sunset: time | None = None
    source: str = "unknown"  # "open-meteo" | "manual" | "unknown"

    @property
    def is_wet(self) -> bool:
        return (self.precip_chance or 0) >= 40

    @property
    def is_cold(self) -> bool:
        return self.low_c is not None and self.low_c < 8

    @property
    def is_hot(self) -> bool:
        return self.high_c is not None and self.high_c > 30

    @property
    def is_known(self) -> bool:
        return self.source != "unknown"

    def brief(self) -> str:
        """One compact line. It goes into the prompt and the page header."""
        bits = [self.summary]
        if self.high_c is not None:
            bits.append(f"{self.high_c:.0f}C high")
        if self.low_c is not None:
            bits.append(f"{self.low_c:.0f}C low")
        if self.precip_chance is not None:
            bits.append(f"{self.precip_chance}% precip")
        if self.wind_kph:
            bits.append(f"wind {self.wind_kph:.0f}kph")
        if self.sunset:
            bits.append(f"sunset {self.sunset.strftime('%H:%M')}")
        return ", ".join(b for b in bits if b)


class Prefs(BaseModel):
    """Everything the planner is allowed to know about the date."""

    location: str
    # Coordinates for `location`, when they are known - from the autocomplete
    # picker or the phone's GPS. Everything works without them; with them the
    # plan is anchored on a point rather than on a place name, which is the
    # difference between "a date in London" and a date where you are standing.
    lat: float | None = None
    lon: float | None = None
    budget: float = 150.0
    currency: str = "USD"
    relationship_stage: str = "getting_to_know"
    clothing_style: str = "smart_casual"
    transportation: str = "walking"
    interests: list[str] = Field(default_factory=list)
    on: date | None = None          # defaults to the next Saturday
    start_time: time | None = None  # defaults to 17:00
    hours: float = 5.0
    party_note: str = ""            # dietary limits, mobility, allergies, hard noes

    # Weather is an input the user *may* set. None means "go look it up";
    # an explicit value always wins over the forecast.
    weather: Weather | None = None

    @property
    def hop_limit(self) -> int:
        return MAX_HOP_MINUTES.get(self.transportation, 20)

    @property
    def radius_km(self) -> float:
        return RADIUS_KM.get(self.transportation, 8.0)

    @property
    def has_coords(self) -> bool:
        return self.lat is not None and self.lon is not None

    def where(self) -> str:
        """How the location is described to the model. Coordinates are included
        when known because a place name alone is ambiguous - there are thirty
        Springfields, and "downtown" means nothing without a city."""
        if self.has_coords:
            return f"{self.location} (latitude {self.lat:.4f}, longitude {self.lon:.4f})"
        return self.location


class Stop(BaseModel):
    """One leg of the evening."""

    name: str = Field(description="The venue or place, named specifically. Never a category like 'a nice restaurant'.")
    kind: str = Field(description="One of: " + ", ".join(STOP_KINDS))
    start: str = Field(description="24-hour local start time, HH:MM.")
    minutes: int = Field(description="Time spent here, including queueing.")
    cost: float = Field(description="Realistic total for two people at this stop, in the requested currency. 0 if free.")
    why: str = Field(description="One sentence on why THIS stop, for THIS couple, at THIS point in the evening. Not a description of the venue.")
    travel_next: str = Field(default="", description="How to reach the next stop and how long, e.g. '8 min walk south along the canal'. Empty for the last stop.")
    travel_minutes: int = Field(default=0, description="Door-to-door minutes to the next stop. 0 for the last stop.")
    booking: str = Field(default="", description="What must be reserved and how far ahead, e.g. 'Resy, drops 30 days out at 9am'. Empty if walk-in.")
    dress_code: str = Field(default="casual", description="Strictest dress this stop demands, one of: " + ", ".join(DRESS_LADDER))
    indoor: bool = Field(description="True if this stop still works in rain.")
    fallback: str = Field(default="", description="Named indoor alternative if weather kills this stop. Required whenever indoor is false.")
    tip: str = Field(default="", description="The thing only a local knows: which table, which entrance, what to order, when to arrive.")

    # Filled in locally after the model returns; not part of what it writes.
    book_url: str = ""
    map_url: str = ""
    provider: str = ""

    # From the venue lookup - OpenStreetMap by default, Google Places when a
    # key is configured. `looked_up` distinguishes "searched for and not
    # found" - a real signal that the model may have invented the place - from
    # "never searched", which says nothing at all.
    looked_up: bool = False
    verified: bool = False
    address: str = ""
    lat: float | None = None
    lon: float | None = None
    distance_m: int = 0        # from the anchor the user gave
    venue_kind: str = ""       # "Restaurant", "Wine bar", ...
    cuisine: str = ""
    opening_hours: str = ""
    website: str = ""
    source: str = ""           # "osm" | "google"

    # Google only; OpenStreetMap has no review system.
    rating: float | None = None
    ratings_count: int = 0

    @property
    def walk_time(self) -> str:
        """Distance from the anchor in the unit people actually think in."""
        if not self.distance_m:
            return ""
        if self.distance_m < 1000:
            return f"{self.distance_m} m away"
        return f"{self.distance_m / 1000:.1f} km away"

    @property
    def end(self) -> str:
        try:
            h, m = (int(x) for x in self.start.split(":"))
        except ValueError:
            return self.start
        total = h * 60 + m + self.minutes
        return f"{(total // 60) % 24:02d}:{total % 60:02d}"


class Plan(BaseModel):
    """A full date, start to finish."""

    title: str = Field(description="A short evocative name for the evening, under 60 characters.")
    pitch: str = Field(description="One sentence you could text them to sell this plan. Under 160 characters.")
    stops: list[Stop] = Field(description="Three to five stops in chronological order, each starting after the previous one ends plus travel.")
    total_cost: float = Field(description="Sum of all stop costs plus transport, for two people.")
    transport_note: str = Field(description="How the route hangs together for the stated transport mode, including parking or last-train warnings.")
    weather_call: str = Field(description="One sentence on how the forecast shaped this plan, and the one decision to re-check on the day.")
    wear: str = Field(description="One sentence of concrete wardrobe advice that satisfies the strictest stop and the weather at once.")
    backup: str = Field(description="Which stop is load-bearing, and what replaces it if it falls through.")

    # Filled in locally.
    warnings: list[str] = Field(default_factory=list)
    generated_by: str = "model"  # "model" | "offline"
    repaired: bool = False       # true if a second pass fixed rule violations

    # Pages the scouting pass actually read. Shown to the user, because the
    # web search terms require crediting sources when search output is
    # displayed - and because "where did this come from" is a fair question.
    sources: list[dict] = Field(default_factory=list)

    # A private attribute, so token counts never appear in the schema the
    # model is asked to fill, and never round-trip through its output.
    _usage: Usage = PrivateAttr(default_factory=Usage)

    @property
    def usage(self) -> Usage:
        return self._usage

    def arc(self) -> str:
        """The pitch-deck one-liner: sunset walk -> photo spot -> dinner -> jazz."""
        return " → ".join(s.name for s in self.stops)
