"""The scouting pass: search the web for what is actually on, before planning.

Without this, the planner works from training data - which means it recommends
the places that were good whenever the model was trained, with no idea that the
restaurant closed in March or that there is a festival blocking the square on
Saturday. That is the difference between a plausible itinerary and a real one.

So the first call is a researcher with the web search tool: find current,
open, well-regarded places near these coordinates, and what is on that night.
The second call is the existing planner, which receives those notes and turns
them into a routed evening.

**Why two calls rather than one.** Web search always enables citations, and
citations are documented as incompatible with structured outputs. Putting the
search tool on the structured planning call would therefore be a gamble, and it
is a gamble with no upside: splitting them means the planning call keeps its
byte-stable cached system prompt and its guaranteed-parseable response, while
the research call is free to be messy and tool-using. A failed research call
degrades to planning from training data, which is exactly where we started.

Sources are collected and shown to the user, which the web search terms require
when search output is displayed.
"""

from __future__ import annotations

import logging

import anthropic

from .models import Prefs, Usage, Weather

log = logging.getLogger(__name__)

# $10 per 1,000 searches, on top of tokens.
SEARCH_COST_USD = 0.01

# How many times to resume a paused server-side loop before giving up. The
# API pauses long search turns with `stop_reason: "pause_turn"`, and resuming
# means sending the paused assistant message back unchanged.
MAX_CONTINUATIONS = 3

SYSTEM = """You are the local scout for a date planner. You do not write the \
itinerary - someone else does that. Your job is to find out what is actually \
true and current about a specific few streets, right now, and hand over notes.

Search for what a planner cannot know from memory:

- Places that are genuinely open now, and their current hours. Restaurants close, \
change owners, and stop doing dinner on Mondays.
- What is on that specific night: gigs, late openings, exhibitions, markets, \
screenings, fado sets, whatever the neighbourhood does.
- Which places are currently well regarded rather than historically famous. \
Recent reviews beat a guidebook.
- Anything that would ruin the evening: closures for refurbishment, a festival \
shutting the square, roadworks, a venue that moved.

Report back as compact notes, not prose. For each candidate give:
  NAME - what it is - roughly what two people spend - why it is worth a stop - \
anything time-sensitive (hours, whether booking is needed, what is on that night)

Group them by the kind of stop they suit: something outdoors early, somewhere to \
drink, somewhere to eat, something late.

Rules:
- Only report places you found evidence for. If a search turns up nothing solid \
for a category, say so plainly - "nothing verifiable for live music this night" \
is a useful finding and an invented venue is not.
- Prefer the specific over the famous. The planner wants the good place on this \
street, not the landmark on the other side of the city.
- Note prices in the local currency where you find them, and say when you are \
estimating.
- Keep the whole thing under 700 words. It is a briefing, not a report."""


class Source:
    """One page the scout actually read."""

    __slots__ = ("url", "title")

    def __init__(self, url: str, title: str = "") -> None:
        self.url = url
        self.title = title

    def as_dict(self) -> dict:
        return {"url": self.url, "title": self.title}


class Research:
    """What the scouting pass came back with."""

    __slots__ = ("notes", "sources", "searches")

    def __init__(self, notes: str, sources: list[Source], searches: int) -> None:
        self.notes = notes
        self.sources = sources
        self.searches = searches


def _tool(prefs: Prefs, llm: dict) -> dict:
    """The web search tool definition.

    `user_location` takes only the city: the API rejects an unsupported
    two-letter country code with a 400, and the app holds a country *name*
    from the geocoder, not an ISO code. City alone satisfies the "at least
    one of" requirement without risking the request.
    """
    tool: dict = {
        "type": llm.get("search_tool", "web_search_20260209"),
        "name": "web_search",
        "max_uses": int(llm.get("max_searches", 6)),
    }
    city = (prefs.location or "").split(",")[0].strip()
    if city:
        tool["user_location"] = {"type": "approximate", "city": city}
    return tool


def _question(prefs: Prefs, w: Weather) -> str:
    when = prefs.on.strftime("%A %d %B %Y") if prefs.on else "this Saturday"
    where = prefs.where()
    lines = [
        f"Scout {where} for a date on {when}, starting around "
        f"{prefs.start_time.strftime('%H:%M') if prefs.start_time else '17:00'}.",
        "",
        f"Budget: about {prefs.currency} {prefs.budget:.0f} for two people, everything in.",
        f"Getting around: {prefs.transportation}. Stay within "
        f"{prefs.radius_km:g} km of the coordinates above.",
        f"Forecast: {w.brief()}.",
    ]
    if prefs.interests:
        lines.append(f"They are into: {', '.join(prefs.interests)}.")
    if prefs.party_note:
        lines.append(f"Hard constraints: {prefs.party_note}.")
    lines += ["", "Find what is actually on and actually open. Notes only."]
    return "\n".join(lines)


def gather(client, prefs: Prefs, w: Weather, llm: dict, usage: Usage) -> Research | None:
    """Run the scouting pass. None when it fails - the caller plans without it."""
    from .planner import _usage_of          # local import: planner imports us

    model = llm.get("model", "claude-opus-5")
    messages: list[dict] = [{"role": "user", "content": _question(prefs, w)}]
    sources: list[Source] = []
    searches = 0

    for attempt in range(MAX_CONTINUATIONS + 1):
        try:
            response = client.messages.create(
                model=model,
                max_tokens=int(llm.get("research_max_tokens", 8000)),
                system=[{"type": "text", "text": SYSTEM,
                         "cache_control": {"type": "ephemeral"}}],
                output_config={"effort": llm.get("research_effort", "medium")},
                tools=[_tool(prefs, llm)],
                messages=messages,
            )
        except anthropic.APIStatusError as e:
            log.error("research: HTTP %s: %s", e.status_code, e.message)
            return None
        except anthropic.APIConnectionError as e:
            log.error("research: could not reach the API: %s", e)
            return None

        usage.add(_usage_of(response, model))
        searches += _searches_in(response)
        sources.extend(_sources_in(response))

        if response.stop_reason == "refusal":
            log.error("research: the model declined to scout this request")
            return None

        if response.stop_reason == "pause_turn":
            # Resume by handing the paused assistant turn straight back. No
            # "continue" message - the API sees the trailing server_tool_use
            # block and picks up where it left off.
            if attempt == MAX_CONTINUATIONS:
                log.warning("research: still paused after %d continuations, using what we have",
                            MAX_CONTINUATIONS)
                break
            messages = messages[:1] + [{"role": "assistant", "content": response.content}]
            continue

        break

    notes = _text_of(response)
    if not notes.strip():
        log.warning("research: came back empty")
        return None

    # Each search is billed on top of tokens, and the plan's cost line should
    # say so rather than quietly under-reporting.
    usage.cost_usd = round(usage.cost_usd + searches * SEARCH_COST_USD, 6)
    usage.searches += searches

    log.info("research: %d searches, %d sources, %d chars of notes",
             searches, len(sources), len(notes))
    return Research(notes.strip(), _dedupe(sources), searches)


def _text_of(response) -> str:
    return "\n".join(b.text for b in response.content
                     if getattr(b, "type", "") == "text" and getattr(b, "text", ""))


def _searches_in(response) -> int:
    server = getattr(response.usage, "server_tool_use", None)
    return int(getattr(server, "web_search_requests", 0) or 0) if server else 0


def _sources_in(response) -> list[Source]:
    """Every page the search actually returned, plus anything cited.

    Split out and defensive because the response shape varies: a failed search
    puts a single error object where the result list normally is, and dynamic
    filtering nests the result blocks under a code execution call.
    """
    out: list[Source] = []
    for block in response.content:
        kind = getattr(block, "type", "")

        if kind == "web_search_tool_result":
            content = getattr(block, "content", None)
            if not isinstance(content, list):
                # An error object, not results - `error_code` says why.
                code = getattr(content, "error_code", "unknown")
                log.warning("research: a search failed (%s)", code)
                continue
            for r in content:
                url = getattr(r, "url", "")
                if url:
                    out.append(Source(url, getattr(r, "title", "")))

        elif kind == "text":
            for c in getattr(block, "citations", None) or []:
                url = getattr(c, "url", "")
                if url:
                    out.append(Source(url, getattr(c, "title", "")))
    return out


def _dedupe(sources: list[Source]) -> list[Source]:
    seen, out = set(), []
    for s in sources:
        if s.url not in seen:
            seen.add(s.url)
            out.append(s)
    return out
