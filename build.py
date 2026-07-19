#!/usr/bin/env python3
"""Build PicoVector Alright Font (.af) icon fonts from the 1-bit pixel sprites.

The sibling `../iconfont-ppf` packs the sprites as on-device bitmap fonts; this
tool packs the same sprites as `.af` vector fonts, the format the PicoVector
`font` module renders on device and `af.js` decodes in the browser. Each sprite
category becomes one `.af` file and each icon is mapped onto a printable
character the way Wingdings maps symbols onto the keyboard.

The `.af` format stores vector contours, not pixels, so each 16x16 sprite is
traced into merged pixel-accurate outlines (identical tracing to the web-font
tool in `../iconfont`), assembled into a per-category TrueType font, and run
through the official `python_alright_fonts` encoder used by `afinate`. That
encoder owns all of the `.af` coordinate/bbox/advance conventions, so the output
matches what the on-device renderer expects.

Self-contained; reads sprites and writes everything under `dist/`:

  ../1-bit_Pixel_Icons/Sprites          sprite source        (SPRITES to override)
  ../1-bit_Pixel_Icons/Icons_*.png      category name source
  ./dist/<Category>.af                  one vector font per category
  ./dist/fonts.js                       manifest (fonts embedded as base64) for the demo

Icons by nikoichu: https://nikoichu.itch.io/pixel-icons
"""

import os
import re
import io
import sys
import json
import base64
import struct
import contextlib
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

# The official Alright Fonts encoder (freetype + shapely) lives beside the badge
# tooling; afinate imports it the same way.
AF_TOOLS = Path(os.environ.get(
    "ALRIGHT_FONTS",
    Path.home() / "Development/badgeware/picovector-fonts/alright-fonts"))
sys.path.insert(0, str(AF_TOOLS))
from python_alright_fonts import Encoder          # noqa: E402

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent
PACK = BASE / "1-bit_Pixel_Icons"
SRC = Path(os.environ["SPRITES"]) if os.environ.get("SPRITES") else PACK / "Sprites"
OUT = Path(os.environ["ICONFONT_OUT"]) if os.environ.get("ICONFONT_OUT") else ROOT / "dist"

GRID = 16          # sprites are 16x16
PX = 64            # font units per pixel
UPM = GRID * PX    # 1024 units per em
CREDIT = "Icons by nikoichu - https://nikoichu.itch.io/pixel-icons"

FLAG_16BIT_POINT_COUNT = 0b0000001
QUALITY = 1        # afinate "high": bezier/simplify tolerance (lines here, so exact)


def printable_codepoints():
    for cp in range(0x21, 0x7F):        # ! .. ~
        yield cp
    for cp in range(0xA1, 0x100):       # Latin-1 printable supplement
        if cp != 0xAD:
            yield cp


CODEPOINTS = list(printable_codepoints())


def slugify(stem):
    s = re.sub(r"[^0-9a-z]+", "_", stem.lower()).strip("_")
    return re.sub(r"_+", "_", s)


def categories():
    titles = {}
    for p in sorted(PACK.glob("Icons_*.png")):
        raw = p.stem[len("Icons_"):]
        titles[slugify(raw)] = raw.replace("_", " ")
    return titles


def ordered_categories(titles):
    return sorted(titles, key=lambda c: (-len(c.split("_")), c))


def category_of(slug, cats):
    for c in cats:
        if slug == c or slug.startswith(c + "_"):
            return c
    return slug.split("_")[0]


def white_mask(path):
    im = Image.open(path).convert("RGBA")
    if im.size != (GRID, GRID):
        im = im.resize((GRID, GRID), Image.NEAREST)
    px = im.load()
    return [[px[x, y][3] > 127 and px[x, y][0] > 200 and px[x, y][1] > 200 and px[x, y][2] > 200
             for x in range(GRID)] for y in range(GRID)]


# --- pixel tracing, shared with the web-font tool -----------------------------

def trace_contours(mask):
    """Trace merged boundary contours of the white region (see ../iconfont)."""
    filled = lambda x, y: 0 <= x < GRID and 0 <= y < GRID and mask[y][x]
    starts = {}
    edges = []

    def add(a, b):
        edges.append((a, b))

    for y in range(GRID):
        for x in range(GRID):
            if not mask[y][x]:
                continue
            if not filled(x, y - 1):
                add((x, y), (x + 1, y))
            if not filled(x + 1, y):
                add((x + 1, y), (x + 1, y + 1))
            if not filled(x, y + 1):
                add((x + 1, y + 1), (x, y + 1))
            if not filled(x - 1, y):
                add((x, y + 1), (x, y))

    for i, (a, b) in enumerate(edges):
        starts.setdefault(a, []).append(i)

    used = [False] * len(edges)
    contours = []
    for i in range(len(edges)):
        if used[i]:
            continue
        contour = []
        cur = i
        while not used[cur]:
            used[cur] = True
            a, b = edges[cur]
            contour.append(a)
            candidates = [j for j in starts.get(b, []) if not used[j]]
            if not candidates:
                break
            if len(candidates) == 1:
                cur = candidates[0]
                continue
            din = (b[0] - a[0], b[1] - a[1])

            def rightness(j):
                c, d = edges[j]
                dout = (d[0] - c[0], d[1] - c[1])
                cross = din[0] * dout[1] - din[1] * dout[0]
                dot = din[0] * dout[0] + din[1] * dout[1]
                if cross > 0:
                    return 0
                if cross == 0 and dot > 0:
                    return 1
                if cross < 0:
                    return 2
                return 3
            cur = min(candidates, key=rightness)
        if len(contour) >= 3:
            contours.append(contour)
    return contours


def winding_inside(contours, x, y):
    w = 0
    for contour in contours:
        n = len(contour)
        for k in range(n):
            ax, ay = contour[k]
            bx, by = contour[(k + 1) % n]
            if ax != bx:
                continue
            if ax <= x:
                continue
            lo, hi = (ay, by) if ay < by else (by, ay)
            if lo <= y < hi:
                w += 1 if by > ay else -1
    return w != 0


def verify(mask, contours):
    for y in range(GRID):
        for x in range(GRID):
            if winding_inside(contours, x + 0.5, y + 0.5) != mask[y][x]:
                return False
    return True


def square_contours(mask):
    out = []
    for y in range(GRID):
        for x in range(GRID):
            if mask[y][x]:
                out.append([(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1)])
    return out


def content_width(mask):
    """Rightmost set column + 1, for a tight horizontal advance."""
    w = 0
    for y in range(GRID):
        for x in range(GRID):
            if mask[y][x]:
                w = max(w, x + 1)
    return w


def to_glyph(contours):
    pen = TTGlyphPen(None)
    for contour in contours:
        pts = [(x * PX, (GRID - y) * PX) for x, y in contour]
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
    return pen.glyph()


# --- naming, shared with the sibling tools ------------------------------------

def short_candidates(body):
    if not body:
        return [""]
    head = body[0]
    cands = [head]
    for k in range(1, len(body)):
        cands.append("_".join([head] + body[-k:]))
    cands.append("_".join(body))
    seen, out = set(), []
    for c in cands:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def assign_canonicals(candidates):
    n = len(candidates)
    chosen = [None] * n
    remaining = set(range(n))
    depth = max(len(c) for c in candidates)
    for level in range(depth):
        want = Counter(candidates[i][level] for i in remaining if level < len(candidates[i]))
        taken = {c for c in chosen if c}
        for i in list(remaining):
            if level < len(candidates[i]):
                c = candidates[i][level]
                if want[c] == 1 and c not in taken:
                    chosen[i] = c
                    remaining.discard(i)
    for i in remaining:
        chosen[i] = candidates[i][-1]
    return chosen


def build_aliases(bodies, canonicals):
    owner = set(canonicals)
    word_icons = defaultdict(set)
    for i, body in enumerate(bodies):
        for tok in set(body):
            word_icons[tok].add(i)
    aliases = [[] for _ in bodies]
    for i, body in enumerate(bodies):
        for tok in body:
            if len(word_icons[tok]) == 1 and tok != canonicals[i] and tok not in owner:
                aliases[i].append(tok)
        aliases[i] = sorted(set(aliases[i]), key=lambda s: (len(s), s))
    return aliases


# --- TTF + AF assembly --------------------------------------------------------

def build_ttf(codepoints, files, masks, fallbacks):
    """Assemble a per-category TTF the AF encoder can read by codepoint."""
    glyph_order = [".notdef"]
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    advances = {".notdef": UPM}
    cmap = {}
    for cp, path, mask in zip(codepoints, files, masks):
        contours = trace_contours(mask)
        if not verify(mask, contours):
            contours = square_contours(mask)
            fallbacks.append(path.name)
        name = f"g{cp:04x}"
        glyph_order.append(name)
        glyphs[name] = to_glyph(contours)
        advances[name] = max(1, content_width(mask)) * PX
        cmap[cp] = name

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (advances[n], 0) for n in glyph_order})
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({"familyName": "Icons", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0)
    fb.setupPost()
    buf = io.BytesIO()
    fb.font.save(buf)
    buf.seek(0)
    return buf


def encode_af(ttf_buf, codepoints):
    """Run the official encoder and serialise an .af file (afinate's layout)."""
    with contextlib.redirect_stdout(io.StringIO()):
        encoder = Encoder(ttf_buf, None, quality=QUALITY)
        for cp in codepoints:
            encoder.get_glyph(cp)

        header = bytearray()
        header += b"af!?"
        header += struct.pack(">H", FLAG_16BIT_POINT_COUNT)
        header += struct.pack(">H", len(encoder.glyphs))
        header += struct.pack(">H", encoder.total_path_count())
        header += struct.pack(">H", encoder.total_point_count())

        body = bytearray()
        for _, glyph in encoder.glyphs.items():
            body += encoder.get_packed_glyph(glyph)
        for _, glyph in encoder.glyphs.items():
            body += encoder.get_packed_glyph_paths(glyph)
        for _, glyph in encoder.glyphs.items():
            body += encoder.get_packed_glyph_path_points(glyph)

    data = bytes(header + body)
    max_points = max((len(c) for g in encoder.glyphs.values() for c in g.contours),
                     default=0)
    return data, list(encoder.glyphs.keys()), max_points


def main():
    if not SRC.is_dir():
        raise SystemExit(f"sprite directory not found: {SRC}")
    OUT.mkdir(parents=True, exist_ok=True)

    titles = categories()
    cats = ordered_categories(titles)
    grouped = defaultdict(list)
    for path in sorted(SRC.glob("*.png")):
        grouped[category_of(slugify(path.stem), cats)].append(path)

    manifest = []
    all_fallbacks, worst_points = [], 0
    for category in sorted(grouped):
        files = grouped[category]
        if len(files) > len(CODEPOINTS):
            raise SystemExit(
                f"{category}: {len(files)} icons exceeds {len(CODEPOINTS)} printable slots")

        drop = len(category.split("_"))
        bodies = [slugify(p.stem).split("_")[drop:] or [slugify(p.stem)] for p in files]
        canonicals = assign_canonicals([short_candidates(b) for b in bodies])
        aliases = build_aliases(bodies, canonicals)

        masks = [white_mask(p) for p in files]
        codepoints = CODEPOINTS[:len(files)]

        fallbacks = []
        ttf_buf = build_ttf(codepoints, files, masks, fallbacks)
        data, kept_codepoints, max_points = encode_af(ttf_buf, codepoints)
        all_fallbacks += fallbacks
        worst_points = max(worst_points, max_points)

        if kept_codepoints != codepoints:
            missing = sorted(set(codepoints) - set(kept_codepoints))
            raise SystemExit(f"{category}: encoder dropped codepoints {missing}")

        (OUT / f"{category}.af").write_bytes(data)

        glyphs = []
        for cp, canonical, alias, path in zip(codepoints, canonicals, aliases, files):
            glyphs.append({
                "char": chr(cp),
                "code": f"{cp:04x}",
                "name": canonical,
                "full": slugify(path.stem),
                "aliases": alias,
            })
        manifest.append({
            "category": category,
            "title": titles.get(category, category.replace("_", " ")),
            "file": f"{category}.af",
            "count": len(glyphs),
            "b64": base64.b64encode(data).decode("ascii"),
            "glyphs": glyphs,
        })
        print(f"  {category:<14} {len(glyphs):>3} icons  max {max_points:>3} pts/path"
              f"  {len(data):>5} B  -> {category}.af")

    payload = "window.AF_FONTS = " + json.dumps(manifest, separators=(",", ":")) + ";\n"
    (OUT / "fonts.js").write_text(payload, encoding="utf-8")

    total = sum(m["count"] for m in manifest)
    print(f"{len(manifest)} fonts, {total} glyphs -> {OUT}/*.af + fonts.js")
    if worst_points > 256:
        print(f"WARNING: worst path has {worst_points} points; the device renderer "
              f"skips paths over 256")
    if all_fallbacks:
        print(f"note: {len(all_fallbacks)} sprites used the square-pixel fallback")


if __name__ == "__main__":
    main()
