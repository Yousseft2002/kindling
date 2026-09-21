"""Read a local `.env` file into the environment.

This exists because of one specific papercut: on Windows, `setx` writes the
variable but does not touch the terminal you are already in, so the obvious
sequence - set the key, run the server - leaves the server without it, and the
app quietly serves template plans instead. That failure is invisible unless
you read the log, and it costs an hour.

A `.env` file next to `run.py` is picked up immediately, with no terminal
restart and no shell profile editing.

Rules kept deliberately tight:

- A real environment variable always wins. The file is a fallback, never an
  override, so `ANTHROPIC_API_KEY=... python run.py` behaves as expected.
- No interpolation, no `export`, no multi-line values. This parses one shape,
  `KEY=value`, because anything cleverer is a dependency pretending to be
  fifteen lines of code.
- The file is never printed, logged, or echoed. `load()` returns the names it
  set, never the values.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

# Values that mean "nobody filled this in yet". A copied-but-unedited
# .env.example would otherwise load a placeholder over a perfectly good
# environment variable's absence, turning a clear "not set" message into a
# confusing 401 from the API.
PLACEHOLDERS = ("your-key-here", "sk-ant-your", "changeme", "xxx", "<your")


def load(path: str | Path = ".env") -> list[str]:
    """Set any variables in `path` that are not already in the environment.

    Returns the names that were set, for logging. Never returns a value.
    Missing or unreadable files are not an error - the environment may well
    be configured properly already.
    """
    p = Path(path)
    if not p.is_file():
        return []

    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        log.warning("env: could not read %s: %s", p, e)
        return []

    loaded = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            log.warning("env: %s line %d is not KEY=value, ignored", p, lineno)
            continue

        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # Strip one layer of matching quotes, so both KEY=abc and KEY="abc" work.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]

        if not key:
            continue
        if key in os.environ:
            continue  # the real environment wins
        if not value or any(ph in value.lower() for ph in PLACEHOLDERS):
            log.warning("env: %s is still a placeholder in %s - ignoring it", key, p)
            continue

        os.environ[key] = value
        loaded.append(key)

    return loaded
