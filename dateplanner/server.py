"""A local web front end, on the standard library only.

One page and a handful of endpoints. No framework, because adding one would be
the largest dependency in the project and would buy nothing.

Planning runs as a background job rather than inside the request: a full plan
is a web search, two model calls and a rate-limited venue lookup per stop, and
holding a request open that long is how a working app comes to look broken.
`POST /api/plan` starts the work and returns a job id; the page polls
`GET /api/plan?job=...` and shows the phase it has reached.

Binds to 127.0.0.1 by default. This holds no accounts and no secrets beyond
the API key already in the environment, but it also has no auth, so do not
put it on a public interface without putting something in front of it.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time as time_module
import uuid
from datetime import date, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from pydantic import ValidationError

from . import affiliates, geo, planner, render, weather as wx
from .models import CLOTHING_STYLES, RELATIONSHIP_STAGES, TRANSPORT, Prefs, Weather

log = logging.getLogger(__name__)

WEB = Path(__file__).parent / "web"

# A plan request is a few hundred bytes. Anything larger is a mistake or an
# attack; either way there is no reason to read it into memory.
MAX_BODY = 16 * 1024

# Everything the app shell is allowed to serve. An allowlist rather than a
# "serve whatever is in the folder" handler: this process runs with the user's
# API key in its environment and may be bound to a LAN address.
STATIC = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def _json_default(o):
    if isinstance(o, (date, time)):
        return o.isoformat()
    raise TypeError(f"not JSON serialisable: {type(o)}")


class Handler(BaseHTTPRequestHandler):
    server_version = "DateNight/0.1"

    # HTTP/1.1 rather than the 1.0 default, so connections are reused. The app
    # shell is a dozen small files and a phone on wifi feels the difference.
    # Safe because every response goes through `_send`, which always sets
    # Content-Length - without that, keep-alive would hang the browser.
    protocol_version = "HTTP/1.1"

    cfg: dict = {}

    # --- plumbing ------------------------------------------------------
    def log_message(self, fmt, *args):  # quieter than the default
        log.info("%s %s", self.address_string(), fmt % args)

    def _send(self, code: int, body: bytes, ctype: str, cache: str | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if cache:
            self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload, default=_json_default).encode("utf-8"),
                   "application/json; charset=utf-8")

    # --- routes --------------------------------------------------------
    def do_GET(self) -> None:
        split = urlsplit(self.path)
        path = split.path
        query = parse_qs(split.query)

        if path in ("/", "/index.html"):
            return self._static("index.html")

        if path == "/api/options":
            # The form builds its dropdowns from the vocabularies in models.py,
            # so adding an option in one place is enough.
            return self._json(200, {
                "relationship_stage": RELATIONSHIP_STAGES,
                "clothing_style": CLOTHING_STYLES,
                "transportation": TRANSPORT,
                # Whether real plans are possible at all. The page warns up
                # front rather than letting someone plan a date, read four
                # generic stops, and conclude the app is broken. Presence
                # only - the key itself never leaves this process.
                "has_key": bool(os.environ.get("ANTHROPIC_API_KEY")),
            })

        # Location autocomplete. Typing "brook" should offer Brooklyn with its
        # coordinates attached, so the plan is anchored on a point the moment
        # the user picks one.
        if path == "/api/places":
            q = (query.get("q") or [""])[0]
            return self._json(200, {"places": [p.as_dict() for p in geo.search(q)]})

        # Poll a running plan. The page asks about once a second and shows the
        # phase, so a two-minute wait reads as progress rather than a hang.
        if path == "/api/plan":
            jid = (query.get("job") or [""])[0]
            with _jobs_lock:
                job = JOBS.get(jid)
            if job is None:
                return self._json(404, {"error": "no such job - it may have expired"})
            return self._json(200, job.status())

        # "Use my location": the phone hands over coordinates, and this turns
        # them into a neighbourhood name the model can reason about.
        if path == "/api/where":
            try:
                lat = float((query.get("lat") or [""])[0])
                lon = float((query.get("lon") or [""])[0])
            except ValueError:
                return self._json(400, {"error": "lat and lon must be numbers"})
            place = geo.reverse(lat, lon)
            if place is None:
                # Still useful: the coordinates alone anchor the plan, even
                # without a name to show.
                return self._json(200, {"place": {"label": "", "lat": lat, "lon": lon, "detail": ""},
                                        "named": False})
            return self._json(200, {"place": place.as_dict(), "named": True})

        return self._static(path.lstrip("/"))

    def _static(self, rel: str) -> None:
        """Serve one file from web/. Allowlisted by extension, and resolved
        inside WEB so a crafted path cannot climb out of it."""
        if not rel:
            return self._send(404, b"not found", "text/plain; charset=utf-8")

        target = (WEB / rel).resolve()
        try:
            target.relative_to(WEB.resolve())
        except ValueError:
            log.warning("static: refused path outside web/: %r", rel)
            return self._send(403, b"forbidden", "text/plain; charset=utf-8")

        ctype = STATIC.get(target.suffix.lower())
        if ctype is None:
            return self._send(404, b"not found", "text/plain; charset=utf-8")

        try:
            body = target.read_bytes()
        except OSError:
            return self._send(404, b"not found", "text/plain; charset=utf-8")

        # The service worker must never be served stale or the app cannot be
        # updated; icons are content-addressed by name and can be cached hard.
        cache = "no-cache" if target.name in ("sw.js", "index.html") else "max-age=86400"
        self._send(200, body, ctype, cache)

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/api/plan":
            return self._send(404, b"not found", "text/plain; charset=utf-8")

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(400, {"error": "empty or oversized request body"})

        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, OSError):
            return self._json(400, {"error": "request body was not valid JSON"})

        try:
            prefs = _prefs_from(payload)
        except ValidationError as e:
            return self._json(400, {"error": "those preferences do not make sense",
                                    "detail": e.errors(include_url=False)[:5]})

        job = _start(prefs, self.cfg)
        # 202: the work is running, come back for it. A full plan is a web
        # search plus two model calls plus a rate-limited lookup per stop -
        # well past the point where a browser, or a person, will wait on one
        # open request without being told anything.
        self._json(202, {"job": job.id, "state": job.state, "phase": job.phase,
                         "label": planner.PHASES.get(job.phase, "Working")})


# --- background planning ---------------------------------------------------
#
# Planning is slow and getting slower - every feature that makes the itinerary
# better adds a round trip. Rather than hold a request open for two minutes and
# hope nothing between here and the browser gives up, each plan runs on its own
# thread and the page polls for the phase it has reached.

JOBS: dict[str, "Job"] = {}
_jobs_lock = threading.Lock()

# How long a finished job stays collectable, and how long a running one may
# take before it is considered wedged.
JOB_TTL = 15 * 60
JOB_TIMEOUT = 5 * 60


class Job:
    __slots__ = ("id", "state", "phase", "result", "error", "started", "finished")

    def __init__(self, job_id: str) -> None:
        self.id = job_id
        self.state = "running"      # running | done | error
        self.phase = "locating"
        self.result: dict | None = None
        self.error = ""
        self.started = time_module.monotonic()
        self.finished = 0.0

    def status(self) -> dict:
        out = {"job": self.id, "state": self.state, "phase": self.phase,
               "label": planner.PHASES.get(self.phase, "Working"),
               "elapsed": round(time_module.monotonic() - self.started, 1)}
        if self.state == "done" and self.result is not None:
            out.update(self.result)
        elif self.state == "error":
            out["error"] = self.error
        return out


def _reap() -> None:
    """Drop old jobs. Caller holds the lock.

    This process is long-lived and JOBS is keyed on user input, so without
    this it is a slow memory leak wearing a hat.
    """
    now = time_module.monotonic()
    for jid, job in list(JOBS.items()):
        age = now - (job.finished or job.started)
        if (job.state != "running" and age > JOB_TTL) or \
           (job.state == "running" and now - job.started > JOB_TIMEOUT):
            del JOBS[jid]


def _start(prefs: Prefs, cfg: dict) -> Job:
    job = Job(uuid.uuid4().hex[:16])

    def run() -> None:
        try:
            plan = planner.plan(prefs, cfg, progress=lambda ph: setattr(job, "phase", ph))
            job.result = _payload(plan, prefs)
            job.state = "done"
        except Exception:
            # A planning failure must not take the server down, and must not
            # leave the page polling a job that will never finish.
            log.exception("plan failed")
            job.state = "error"
            job.error = "the planner fell over - check the server log"
        finally:
            job.finished = time_module.monotonic()

    with _jobs_lock:
        _reap()
        JOBS[job.id] = job
    threading.Thread(target=run, name=f"plan-{job.id}", daemon=True).start()
    return job


def _payload(plan, prefs: Prefs) -> dict:
    return {
        "plan": plan.model_dump(mode="json"),
        "prefs": prefs.model_dump(mode="json"),
        "arc": plan.arc(),
        "weather": (prefs.weather or Weather()).model_dump(mode="json"),
        "weather_brief": (prefs.weather or Weather()).brief(),
        "revenue": affiliates.revenue_estimate(plan),
        "usage": plan.usage.model_dump(mode="json"),
        "html": render.to_html(plan, prefs),
    }


def _prefs_from(payload: dict) -> Prefs:
    """Build Prefs from the form's JSON, tolerating the shapes a browser sends:
    interests as a comma-separated string, empty strings for unset dates."""
    data = dict(payload)

    interests = data.get("interests")
    if isinstance(interests, str):
        data["interests"] = [x.strip() for x in interests.split(",") if x.strip()]

    # Browsers send "" for anything untouched; pydantic would reject that for
    # a date, a time or a float, so drop them and let the defaults apply.
    for key in ("on", "start_time", "weather", "lat", "lon"):
        if data.get(key) in ("", None):
            data.pop(key, None)

    # Coordinates only mean anything as a pair. Half of one is worse than
    # neither, because it would silently anchor the plan on the equator.
    if ("lat" in data) != ("lon" in data):
        data.pop("lat", None)
        data.pop("lon", None)

    typed = data.get("weather")
    if isinstance(typed, str):  # a typed override like "probably raining"
        data["weather"] = wx.parse_override(typed).model_dump(mode="json")

    return Prefs.model_validate(data)


def lan_address() -> str | None:
    """This machine's address on the local network, for opening the app on a
    phone. No packet is actually sent - connect() on a UDP socket just picks
    the interface the OS would route through."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def serve(cfg: dict, host: str = "127.0.0.1", port: int = 8765) -> None:
    Handler.cfg = cfg
    httpd = ThreadingHTTPServer((host, port), Handler)

    print(f"Date planner on http://127.0.0.1:{port}  (ctrl-c to stop)")
    if host not in ("127.0.0.1", "localhost"):
        ip = lan_address()
        if ip:
            print(f"On your phone (same wifi): http://{ip}:{port}")
        # Worth saying plainly: this process has the API key in its
        # environment and no authentication in front of it.
        print("Bound to the local network - anyone on this wifi can use it.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()
