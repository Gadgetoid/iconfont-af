#!/usr/bin/env python3
"""Emit one standalone badge grid demo per .af font into demos/.

Reads dist/fonts.js for each font's glyph count and writes demos/<category>.py,
a badge script that renders every icon as a neat aligned grid. A loaded .af
exposes no glyph list on device, so each demo carries its count and rebuilds the
same printable codepoint sequence build.py assigned.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
DEMOS = ROOT / "demos"

TEMPLATE = '''\
# {title} icons - {count} glyphs from {file}
#
# Renders every icon in the font as an aligned grid. Each icon is mapped to a
# printable character (Wingdings style) from "!" upward; see ../dist/fonts.js
# for the character-to-name mapping. Place {file} alongside this script on the
# badge, or adjust the load path below.
#
# These are scalable vector fonts, so raise SIZE for larger, smoother icons.

FONT = "{file}"
COUNT = {count}

COLS = 20        # icons per row
PITCH = 16       # cell size in pixels
SIZE = 14        # glyph em-height in pixels
MARGIN = 2       # left/top inset

badge.mode(HIRES)

screen.font = font.load(FONT)
screen.antialias = image.X2


def icon_chars(count):
    # build.py assigns codepoints "!" (0x21) upward through ASCII printable,
    # then the Latin-1 printable supplement, skipping the C1 range and soft
    # hyphen. Rebuild that sequence to recover this font's characters.
    out, cp = [], 0x21
    while len(out) < count:
        if cp != 0xAD and not 0x7F <= cp <= 0xA0:
            out.append(chr(cp))
        cp += 1
    return out


chars = icon_chars(COUNT)

screen.pen = color.black
screen.clear()

screen.pen = color.white
for i, ch in enumerate(chars):
    x = MARGIN + (i % COLS) * PITCH
    y = MARGIN + (i // COLS) * PITCH
    screen.text(ch, x, y, SIZE)

badge.update()
'''


def main():
    src = (DIST / "fonts.js").read_text(encoding="utf-8")
    fonts = json.loads(src.split("=", 1)[1].strip().rstrip(";"))
    DEMOS.mkdir(parents=True, exist_ok=True)

    for font in fonts:
        out = DEMOS / f"{font['category']}.py"
        out.write_text(TEMPLATE.format(
            title=font["title"], count=font["count"], file=font["file"]),
            encoding="utf-8")
        print(f"  demos/{font['category']}.py  ({font['count']} icons)")

    print(f"{len(fonts)} demos -> {DEMOS}")


if __name__ == "__main__":
    main()
