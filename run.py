#!/usr/bin/env python3
"""Date planner CLI.

    python run.py --location "Lisbon" --budget 120 --interests "jazz,photography"
    python run.py --location "Brooklyn" --stage first_date --dry-run
    python run.py --serve

`--dry-run` forces the offline planner, so it costs nothing and needs no key.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tomllib
import webbrowser
from datetime import date, time
from pathlib import Path

from dateplanner import affiliates, env, planner, render, weather as wx
from dateplanner.models import CLOTHING_STYLES, RELATIONSHIP_STAGES, TRANSPORT, Prefs

ROOT = Path(__file__).parent


def load_config() -> dict:
    path = ROOT / "config.toml"
    if not path.exists():
        return {}
    with open(path, "rb") as f:
        return tomllib.load(f)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Plan a date.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "stages:     " + ", ".join(RELATIONSHIP_STAGES) + "\n"
            "styles:     " + ", ".join(CLOTHING_STYLES) + "\n"
            "transport:  " + ", ".join(TRANSPORT)
        ),
    )
    p.add_argument("--location", "-l", help="City, neighbourhood, or address.")
    p.add_argument("--budget", "-b", type=float, help="Total for two people.")
    p.add_argument("--currency", help="Currency code, e.g. USD, EUR, GBP.")
    p.add_argument("--stage", choices=list(RELATIONSHIP_STAGES), help="Relationship stage.")
    p.add_argument("--style", choices=list(CLOTHING_STYLES), help="How you will be dressed.")
    p.add_argument("--transport", choices=list(TRANSPORT), help="How you will get around.")
    p.add_argument("--interests", help="Comma separated, e.g. 'jazz,film,natural wine'.")
    p.add_argument("--on", help="Date, YYYY-MM-DD. Defaults to the next Saturday.")
    p.add_argument("--at", help="Start time, HH:MM.")
    p.add_argument("--hours", type=float, help="Roughly how long it should run.")
    p.add_argument("--note", help="Dietary limits, mobility, allergies, hard noes.")
    p.add_argument("--weather", help="Override the forecast, e.g. 'cold and wet'.")

    p.add_argument("--dry-run", action="store_true", help="Offline planner only. No API call, no spend.")
    p.add_argument("--html", metavar="PATH", help="Write the plan to an HTML file.")
    p.add_argument("--open", action="store_true", help="Open the HTML file when done.")
    p.add_argument("--revenue", action="store_true", help="Show the affiliate commission estimate.")
    p.add_argument("--json", action="store_true", help="Print the plan as JSON instead of text.")

    p.add_argument("--serve", action="store_true", help="Run the web app instead.")
    p.add_argument("--port", type=int, help="Port for --serve.")
    p.add_argument("--lan", action="store_true",
                   help="Bind to the local network so you can open the app on your phone. "
                        "No authentication - only do this on a network you trust.")
    p.add_argument("--check-key", action="store_true",
                   help="Say whether the Anthropic API key is set and actually works, "
                        "then exit. Makes one tiny request.")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def check_key() -> int:
    """Is the key present, and does it work? Prints a verdict and a fix.

    Worth its own command because the failure it diagnoses is silent: without
    a key the app serves template itineraries that look like output rather
    than like an error.
    """
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        print("ANTHROPIC_API_KEY: not set.\n")
        print("The app still runs, but every plan will be a generic template")
        print("rather than real venues. To fix it, either:\n")
        print(f"  1. Put it in a .env file next to run.py  (works immediately)")
        print(f"     copy .env.example to .env and edit it\n")
        print(f"  2. Or set it for good:")
        print(f"     setx ANTHROPIC_API_KEY \"sk-ant-...\"")
        print(f"     then open a NEW terminal - setx does not affect this one\n")
        print("Get a key at https://console.anthropic.com/settings/keys")
        return 1

    # Never print the key. Its shape is enough to catch a truncated paste.
    print(f"ANTHROPIC_API_KEY: set ({len(key)} characters, starts {key[:7]}...)")
    if not key.startswith("sk-ant-"):
        print("  Warning: Anthropic keys normally start with 'sk-ant-'. Check the paste.")

    print("Testing it with one small request...")
    try:
        import anthropic
        client = anthropic.Anthropic()
        r = client.messages.create(
            model="claude-haiku-4-5",  # cheapest thing that proves the key
            max_tokens=4,
            messages=[{"role": "user", "content": "Say ok"}],
        )
        print(f"  Works. Model replied, {r.usage.output_tokens} output tokens.")
        print("\nRun  python run.py --serve  and plans will name real places.")
        return 0
    except Exception as e:
        name = type(e).__name__
        status = getattr(e, "status_code", None)
        if status == 401:
            print("  Rejected: the key is not valid (HTTP 401).")
            print("  Check for a truncated paste, or make a new key at")
            print("  https://console.anthropic.com/settings/keys")
        elif status == 429:
            print("  Rate limited (HTTP 429) - the key is valid but throttled.")
            return 0
        elif status == 400 and "credit" in str(e).lower():
            print("  The key is valid but the account has no credit.")
        else:
            print(f"  Failed: {name}: {e}")
        return 1


def build_prefs(args: argparse.Namespace, cfg: dict) -> Prefs:
    d = cfg.get("defaults", {})

    on = None
    if args.on:
        try:
            on = date.fromisoformat(args.on)
        except ValueError:
            sys.exit(f"--on must be YYYY-MM-DD, got {args.on!r}")

    raw_at = args.at or d.get("start_time")
    start = None
    if raw_at:
        try:
            start = time.fromisoformat(raw_at)
        except ValueError:
            sys.exit(f"--at must be HH:MM, got {raw_at!r}")

    return Prefs(
        location=args.location,
        budget=args.budget if args.budget is not None else d.get("budget", 150.0),
        currency=args.currency or d.get("currency", "USD"),
        relationship_stage=args.stage or d.get("relationship_stage", "getting_to_know"),
        clothing_style=args.style or d.get("clothing_style", "smart_casual"),
        transportation=args.transport or d.get("transportation", "walking"),
        interests=[x.strip() for x in (args.interests or "").split(",") if x.strip()],
        on=on,
        start_time=start,
        hours=args.hours if args.hours is not None else d.get("hours", 5.0),
        party_note=args.note or "",
        weather=wx.parse_override(args.weather) if args.weather else None,
    )


def main(argv: list[str] | None = None) -> int:
    # Windows consoles still default to cp1252, and an itinerary is full of
    # things it cannot encode: the arrow between stops, and every accented
    # venue name in Europe. Without this, printing a good plan raises.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    args = parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    # Before anything reads os.environ. A real environment variable still
    # wins; this only fills gaps.
    loaded = env.load(ROOT / ".env")
    if loaded:
        print(f"loaded {', '.join(loaded)} from .env", file=sys.stderr)

    if args.check_key:
        return check_key()

    cfg = load_config()

    if args.serve:
        from dateplanner import server
        s = cfg.get("server", {})
        host = "0.0.0.0" if args.lan else s.get("host", "127.0.0.1")
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("note: ANTHROPIC_API_KEY is not set - the app will serve offline "
                  "template plans.\n", file=sys.stderr)
        server.serve(cfg, host, args.port or s.get("port", 8765))
        return 0

    if not args.location:
        sys.exit("--location is required (or use --serve). Try: run.py -l 'Lisbon' -b 120")

    if args.dry_run:
        # Belt and braces: the planner also checks `llm.enabled`.
        cfg.setdefault("llm", {})["enabled"] = False
    elif not os.environ.get("ANTHROPIC_API_KEY"):
        print("note: ANTHROPIC_API_KEY is not set - falling back to the offline planner.\n",
              file=sys.stderr)

    prefs = build_prefs(args, cfg)
    plan = planner.plan(prefs, cfg)

    if args.json:
        import json
        print(json.dumps({
            "plan": plan.model_dump(mode="json"),
            "prefs": prefs.model_dump(mode="json"),
            "revenue": affiliates.revenue_estimate(plan),
        }, indent=2))
    else:
        print(render.to_text(plan, prefs))

    if args.revenue:
        rev = affiliates.revenue_estimate(plan)
        print("Affiliate estimate (ceiling - assumes every link converts)")
        for line in rev["lines"]:
            print(f"  {line['stop'][:44]:<46} {line['provider']:<13} "
                  f"{prefs.currency} {line['commission']:.2f}")
        print(f"  {'':<46} {'total':<13} {prefs.currency} {rev['total']:.2f} "
              f"on {prefs.currency} {rev['booked_spend']:.0f} of bookable spend")

        # The other half of the unit economics. A plan that earns 7.50 at a 3%
        # attach rate is worth 0.22 in expectation; printing what it cost to
        # produce next to that is the only honest way to read the first number.
        u = plan.usage
        if u.calls:
            print(f"  {'':<46} {'cost':<13} USD {u.cost_usd:.4f} to generate")
            print(f"  {'':<46} {'':<13} {u.brief()}")
        else:
            print(f"  {'':<46} {'cost':<13} USD 0 (offline planner, no API call)")
        print()

    if args.html:
        out = Path(args.html)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render.to_html(plan, prefs), encoding="utf-8")
        print(f"wrote {out}")
        if args.open:
            webbrowser.open(out.resolve().as_uri())

    # A plan with warnings is still a plan, but the exit code should let a
    # script notice that something needs a human.
    return 1 if plan.warnings else 0


if __name__ == "__main__":
    sys.exit(main())
