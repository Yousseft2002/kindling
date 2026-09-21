"""Shared HTTP session.

`truststore` must be injected before `requests` is imported. Machines running
TLS-inspecting antivirus (this one does) otherwise fail certificate
verification on every outbound call. Keep this import order.
"""

from __future__ import annotations

import logging

import truststore

truststore.inject_into_ssl()

import requests  # noqa: E402  (must follow inject_into_ssl)
from requests.adapters import HTTPAdapter  # noqa: E402
from urllib3.util.retry import Retry  # noqa: E402

log = logging.getLogger(__name__)

# Nominatim's usage policy asks for a User-Agent that identifies the app, and
# Overpass's front end rejects some shapes outright - a parenthetical
# `(+https://example.com)` placeholder here returned HTTP 406 from Apache
# before the query was even parsed. Keep this plain and honest; if you deploy
# this publicly, put a real contact in it.
USER_AGENT = "DatePlanner/0.1 (open-source date planner)"

_session: requests.Session | None = None


def session() -> requests.Session:
    global _session
    if _session is not None:
        return _session
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"})
    retry = Retry(
        total=2,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_maxsize=4)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    _session = s
    return s


def post_json(url: str, payload: dict, headers: dict | None = None,
              timeout: int = 15) -> dict | None:
    """POST JSON, parse JSON back. Returns None on any failure.

    Same contract as `get_json`: nothing here raises. A place lookup that
    fails should cost the plan its rating, not the whole request.
    """
    try:
        r = session().post(url, json=payload, headers=headers or {}, timeout=timeout)
    except requests.RequestException as e:
        log.warning("POST %s failed: %s", url, e)
        return None
    if not r.ok:
        # The body carries Google's actual complaint (bad key, billing off,
        # malformed field mask), and without it this is unguessable.
        log.warning("POST %s -> HTTP %s: %s", url, r.status_code, r.text[:300])
        return None
    try:
        return r.json()
    except ValueError:
        log.warning("POST %s returned non-JSON", url)
        return None


def get_json(url: str, params: dict | None = None, timeout: int = 15) -> dict | None:
    """GET and parse JSON. Returns None on any failure.

    Nothing here is allowed to raise: a missing forecast should degrade the
    plan, never kill the request.
    """
    try:
        r = session().get(url, params=params, timeout=timeout)
    except requests.RequestException as e:
        log.warning("GET %s failed: %s", url, e)
        return None
    if not r.ok:
        log.warning("GET %s -> HTTP %s", url, r.status_code)
        return None
    try:
        return r.json()
    except ValueError:
        log.warning("GET %s returned non-JSON", url)
        return None
