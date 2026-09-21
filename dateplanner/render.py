"""Output. Terminal for the CLI, a self-contained HTML page for sharing.

The HTML is inline-styled with no external assets on purpose: the useful thing
to do with a finished plan is send it to the other person, and a saved page or
a pasted email body has to survive that trip intact.
"""

from __future__ import annotations

from html import escape

from . import affiliates
from .models import Plan, Prefs

BAR = "-" * 68


def to_text(plan: Plan, prefs: Prefs) -> str:
    out: list[str] = []
    when = prefs.on.strftime("%A %d %B") if prefs.on else "Saturday"

    out.append("")
    out.append(plan.title)
    out.append(BAR)
    out.append(plan.pitch)
    out.append("")
    out.append(f"{prefs.location} | {when} | {prefs.currency} {plan.total_cost:.0f} for two")
    if prefs.weather and prefs.weather.is_known:
        out.append(f"Forecast: {prefs.weather.brief()}")
    out.append("")
    out.append(plan.arc())
    out.append("")

    for i, s in enumerate(plan.stops, 1):
        cost = "free" if s.cost <= 0 else f"{prefs.currency} {s.cost:.0f}"
        out.append(f"{i}. {s.start}-{s.end}  {s.name}   [{cost}]")
        out.append(f"   {s.why}")

        # What the venue lookup found. Same facts the app shows, so a plan
        # printed to a terminal or saved as HTML is not a lesser version.
        facts = [x for x in (s.venue_kind, s.cuisine, s.walk_time) if x]
        if s.rating is not None:
            facts.append(f"{s.rating:.1f} on Google"
                         + (f" ({s.ratings_count:,} reviews)" if s.ratings_count else ""))
        if facts:
            out.append(f"   {' | '.join(facts)}")
        if s.address:
            out.append(f"   {s.address}")
        if s.opening_hours:
            out.append(f"   Hours: {s.opening_hours}")
        if s.website:
            out.append(f"   Site: {s.website}")
        if s.looked_up and not s.verified:
            out.append("   ! Not found in map data - check this place exists.")

        if s.tip:
            out.append(f"   Tip: {s.tip}")
        if s.booking:
            out.append(f"   Booking: {s.booking}")
        if not s.indoor and s.fallback:
            out.append(f"   If it rains: {s.fallback}")
        if s.book_url:
            out.append(f"   {affiliates.label(s)}: {s.book_url}")
        if s.map_url:
            out.append(f"   Map: {s.map_url}")
        if s.travel_next:
            out.append(f"   -> {s.travel_next}")
        out.append("")

    out.append(BAR)
    out.append(f"Wear:      {plan.wear}")
    out.append(f"Getting around: {plan.transport_note}")
    out.append(f"Weather:   {plan.weather_call}")
    out.append(f"If it breaks: {plan.backup}")

    if plan.warnings:
        out.append("")
        out.append("Check before you commit:")
        for wrn in plan.warnings:
            out.append(f"  ! {wrn}")

    if plan.sources:
        # Credited because the web search terms require it when search output
        # is displayed, and because "how do you know that" is a fair question.
        out.append("")
        out.append(f"Checked {len(plan.sources)} source"
                   f"{'s' if len(plan.sources) != 1 else ''} just now:")
        for src in plan.sources[:12]:
            title = src.get("title") or ""
            out.append(f"  - {title[:60] + '  ' if title else ''}{src.get('url', '')}")

    if plan.generated_by == "offline":
        out.append("")
        out.append("(Offline plan - no ANTHROPIC_API_KEY set, so venue names are")
        out.append(" types and areas rather than real places.)")
    out.append("")
    return "\n".join(out)


# --- HTML ------------------------------------------------------------------

_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title></head>
<body style="margin:0;padding:24px 16px;background:#faf7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#241f1c;">
<div style="max-width:620px;margin:0 auto;">
  <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a8705a;">{meta}</p>
  <h1 style="margin:0 0 10px;font-size:30px;line-height:1.15;font-weight:650;">{title}</h1>
  <p style="margin:0 0 18px;font-size:17px;line-height:1.5;color:#5a4f49;">{pitch}</p>
  <p style="margin:0 0 26px;padding:12px 14px;background:#fff;border:1px solid #ebe1da;border-radius:10px;font-size:14px;line-height:1.6;color:#5a4f49;">{arc}</p>
  {stops}
  {warnings}
  <div style="margin-top:26px;padding:18px;background:#fff;border:1px solid #ebe1da;border-radius:12px;font-size:14px;line-height:1.65;color:#3d3531;">
    {notes}
  </div>
  <p style="margin:22px 0 0;font-size:12px;color:#9b8f88;">{footer}</p>
</div></body></html>"""

_STOP = """<div style="position:relative;margin:0 0 14px;padding:16px 18px;background:#fff;border:1px solid #ebe1da;border-radius:12px;">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#a8705a;margin-bottom:4px;">{n} &middot; {start}&ndash;{end} &middot; {cost}</div>
  <div style="font-size:19px;font-weight:620;line-height:1.25;margin-bottom:6px;">{name}</div>
  <div style="font-size:15px;line-height:1.55;color:#5a4f49;">{why}</div>
  {extras}
  {links}
</div>{travel}"""

_EXTRA = '<div style="margin-top:8px;font-size:13.5px;line-height:1.55;color:#6b605a;"><strong style="color:#3d3531;font-weight:600;">{k}</strong> {v}</div>'
_LINK = '<a href="{href}" style="display:inline-block;margin:12px 8px 0 0;padding:7px 13px;background:#241f1c;color:#fff;text-decoration:none;border-radius:999px;font-size:13px;font-weight:550;">{text}</a>'
_LINK2 = '<a href="{href}" style="display:inline-block;margin:12px 0 0;padding:7px 13px;background:#fff;color:#241f1c;border:1px solid #d9cdc5;text-decoration:none;border-radius:999px;font-size:13px;font-weight:550;">{text}</a>'
_TRAVEL = '<div style="margin:0 0 14px;padding-left:20px;font-size:13px;color:#8a7d76;">&darr;&nbsp; {t}</div>'


def to_html(plan: Plan, prefs: Prefs) -> str:
    when = prefs.on.strftime("%A %d %B") if prefs.on else "Saturday"
    meta = escape(f"{prefs.location} - {when} - {prefs.currency} {plan.total_cost:.0f} for two")

    blocks = []
    for i, s in enumerate(plan.stops, 1):
        extras = ""

        facts = [x for x in (s.venue_kind, s.cuisine, s.walk_time) if x]
        if s.rating is not None:
            stars = "★" * round(s.rating) + "☆" * (5 - round(s.rating))
            facts.append(f"{stars} {s.rating:.1f}"
                         + (f" ({s.ratings_count:,})" if s.ratings_count else ""))
        if facts:
            extras += (
                '<div style="margin-top:8px;font-size:13.5px;color:#6b605a;">'
                + escape(" · ".join(facts)) + "</div>"
            )
        if s.address:
            extras += _EXTRA.format(k="Address:", v=escape(s.address))
        if s.opening_hours:
            extras += _EXTRA.format(k="Hours:", v=escape(s.opening_hours))
        if s.website:
            extras += _EXTRA.format(
                k="Site:",
                v=f'<a href="{escape(s.website, quote=True)}" style="color:#a8705a;">'
                  f'{escape(s.website.replace("https://", "").replace("http://", "")[:48])}</a>')
        if s.looked_up and not s.verified:
            extras += _EXTRA.format(
                k="Heads up:", v="not found in map data - check this place exists.")

        if s.tip:
            extras += _EXTRA.format(k="Tip:", v=escape(s.tip))
        if s.booking:
            extras += _EXTRA.format(k="Booking:", v=escape(s.booking))
        if not s.indoor and s.fallback:
            extras += _EXTRA.format(k="If it rains:", v=escape(s.fallback))

        links = ""
        if s.book_url:
            links += _LINK.format(href=escape(s.book_url, quote=True), text=escape(affiliates.label(s)))
        if s.map_url and s.map_url != s.book_url:
            links += _LINK2.format(href=escape(s.map_url, quote=True), text="Map")

        blocks.append(_STOP.format(
            n=i,
            start=escape(s.start), end=escape(s.end),
            cost="Free" if s.cost <= 0 else escape(f"{prefs.currency} {s.cost:.0f}"),
            name=escape(s.name), why=escape(s.why),
            extras=extras, links=links,
            travel=_TRAVEL.format(t=escape(s.travel_next)) if s.travel_next else "",
        ))

    warnings = ""
    if plan.warnings:
        items = "".join(
            f'<li style="margin-bottom:5px;">{escape(w)}</li>' for w in plan.warnings
        )
        warnings = (
            '<div style="margin:18px 0 0;padding:14px 18px;background:#fff6ed;'
            'border:1px solid #f0d9c2;border-radius:12px;font-size:13.5px;line-height:1.55;color:#7a5533;">'
            '<strong style="display:block;margin-bottom:6px;">Check before you commit</strong>'
            f'<ul style="margin:0;padding-left:18px;">{items}</ul></div>'
        )

    notes = "".join(
        _EXTRA.format(k=k, v=escape(v))
        for k, v in (
            ("Wear:", plan.wear),
            ("Getting around:", plan.transport_note),
            ("Weather:", plan.weather_call),
            ("If it breaks:", plan.backup),
        ) if v
    )

    sources = ""
    if plan.sources:
        items = "".join(
            f'<li style="margin-bottom:4px;">'
            f'<a href="{escape(src.get("url", ""), quote=True)}" style="color:#6b605a;">'
            f'{escape((src.get("title") or src.get("url", ""))[:70])}</a></li>'
            for src in plan.sources[:12]
        )
        sources = (
            '<div style="margin-top:18px;padding:16px 18px;background:#fff;border:1px solid #ebe1da;'
            'border-radius:12px;font-size:13.5px;line-height:1.6;color:#5a4f49;">'
            '<strong style="display:block;margin-bottom:8px;color:#a8705a;">'
            f'Checked {len(plan.sources)} source{"s" if len(plan.sources) != 1 else ""} just now'
            f'</strong><ol style="margin:0;padding-left:18px;">{items}</ol></div>'
        )

    footer = (
        "Planned offline - venue names are types and areas, not real places. Set ANTHROPIC_API_KEY for the real thing."
        if plan.generated_by == "offline"
        else "Booking links may earn a commission. Prices and hours are estimates - check before you go."
    )
    if any(s.rating is not None for s in plan.stops):
        footer += " Ratings and place details from Google Maps."
    elif any(s.verified for s in plan.stops):
        footer += " Place details from OpenStreetMap contributors."

    return _PAGE.format(
        title=escape(plan.title), meta=meta, pitch=escape(plan.pitch),
        arc=escape(plan.arc()), stops="".join(blocks),
        warnings=warnings + sources, notes=notes, footer=footer,
    )
