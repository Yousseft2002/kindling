#!/usr/bin/env python3
"""Generate the app icons.

    python tools/make_icons.py

Checked in as a script rather than as four opaque PNGs so the mark can be
changed without a design tool, and so nobody has to wonder where the binaries
came from. Pure stdlib - zlib and struct are all a PNG needs.

The mark is a sun sitting on a horizon: it is what the product is about
(the plan starts at golden hour), and it survives being 32 pixels wide, which
rules out anything with a glyph in it.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).parent.parent / "dateplanner" / "web" / "icons"

INK = (36, 31, 28)        # --ink, the page background in dark mode
SUN = (217, 154, 124)     # --accent
GLOW = (168, 112, 90)     # --accent, darker: the reflection below the horizon

# Every size the app asks for. 180 is Apple's touch icon, 192 and 512 are what
# the manifest declares, 32 is the favicon.
SIZES = (32, 180, 192, 512)

# Maskable icons get cropped to a circle on Android, so the mark has to sit
# inside the middle 80%. These fractions keep it well inside that.
SUN_CY = 0.50
SUN_R = 0.24
HORIZON = 0.58


def _png(width: int, height: int, rgb: bytes) -> bytes:
    """Encode raw RGB rows as a PNG."""
    raw = b"".join(
        b"\x00" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height)
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def _blend(a: tuple, b: tuple, t: float) -> tuple:
    """Linear blend, used for antialiasing the circle edge - a hard-edged
    circle at 32px looks broken."""
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size: int) -> bytes:
    cx, cy = size * 0.5, size * SUN_CY
    r = size * SUN_R
    horizon = size * HORIZON
    edge = max(1.0, size / 48)  # antialias width, in pixels

    rows = bytearray()
    for y in range(size):
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            dist = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5

            if py < horizon:
                # Above the horizon: the sun itself, softened at the rim.
                colour = _blend(SUN, INK, (dist - (r - edge)) / edge)
            else:
                # Below: reflection bars, only just under the horizon line.
                band = (py - horizon) / max(1.0, size - horizon)
                lit = dist < r * 1.25 and band < 0.55 and int(py / max(1.0, size / 22)) % 2 == 0
                colour = _blend(GLOW, INK, 0.55) if lit else INK

            rows += bytes(colour)
    return _png(size, size, bytes(rows))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon-{size}.png"
        path.write_bytes(render(size))
        print(f"wrote {path.relative_to(OUT.parent.parent.parent)} ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
