#!/usr/bin/env python3
"""Confirm every .af glyph's vector shape matches its source sprite.

Unlike the bitmap .ppf, the .af format is a lossy vector re-encoding (contours
scaled to signed 8-bit coordinates), so an exact pixel round-trip is impossible.
Instead this independently decodes each .af (following the af.js layout), fills
its contours with the even-odd rule, and compares the rasterised shape to the
source sprite's pixels by intersection-over-union: the white fill for the default
set, the black linework for the outline set.

Both shapes are normalised to their own bounding boxes. A faithful glyph scores a
high IoU; thin outlines legitimately bottom out around 0.75 because a vector fill
sampled at cell centres never lands exactly on the pixel squares it came from,
while a genuinely wrong or empty contour scores near zero. The gate is therefore
a low floor that separates faithful from broken, and the mean is reported so the
overall agreement (high) is visible.

  ./.venv/bin/python verify-fidelity.py
"""

import sys
import struct
from pathlib import Path
from collections import defaultdict

from PIL import Image

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent
PACK = BASE / "1-bit_Pixel_Icons"
SRC = PACK / "Sprites"
DIST = ROOT / "dist"
GRID = 16
R = 48                 # rasterisation resolution for the comparison
THRESHOLD = 0.65       # low floor: separates faithful (min ~0.75) from broken (~0)
import re


def slugify(stem):
    s = re.sub(r"[^0-9a-z]+", "_", stem.lower()).strip("_")
    return re.sub(r"_+", "_", s)


def categories():
    names = [slugify(p.stem[len("Icons_"):]) for p in sorted(PACK.glob("Icons_*.png"))]
    names.sort(key=lambda c: (-len(c.split("_")), c))
    return names


def category_of(slug, cats):
    for c in cats:
        if slug == c or slug.startswith(c + "_"):
            return c
    return slug.split("_")[0]


def pixel_mask(path, ink):
    im = Image.open(path).convert("RGBA")
    if im.size != (GRID, GRID):
        im = im.resize((GRID, GRID), Image.NEAREST)
    px = im.load()
    mask = [[False] * GRID for _ in range(GRID)]
    for y in range(GRID):
        for x in range(GRID):
            r, g, b, a = px[x, y]
            if a <= 127:
                continue
            white = r > 200 and g > 200 and b > 200
            mask[y][x] = white if ink == "white" else not white
    return mask


# (filename suffix, which opaque tone the set keeps), matching build.py.
VARIANTS = [("", "white"), ("_outline", "black")]


def content_bounds(mask):
    xs = [x for y in range(GRID) for x in range(GRID) if mask[y][x]]
    ys = [y for y in range(GRID) for x in range(GRID) if mask[y][x]]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def decode_af(data):
    assert data[:4] == b"af!?", "bad magic"
    flags, n = struct.unpack(">H", data[4:6])[0], struct.unpack(">H", data[6:8])[0]
    off = 12
    glyphs = []
    for _ in range(n):
        cp, x, y, w, h, adv, npaths = struct.unpack(">HbbBBBB", data[off:off + 8])
        off += 8
        glyphs.append({"cp": cp, "npaths": npaths, "paths": []})
    u16 = bool(flags & 1)
    for g in glyphs:
        for _ in range(g["npaths"]):
            pc = struct.unpack(">H", data[off:off + 2])[0] if u16 else data[off]
            off += 2 if u16 else 1
            g["paths"].append(pc)
    rebuilt = []
    for g in glyphs:
        rings = []
        for pc in g["paths"]:
            pts = []
            for _ in range(pc):
                px, py = struct.unpack(">bb", data[off:off + 2])
                off += 2
                pts.append((px, py))
            rings.append(pts)
        rebuilt.append({"cp": g["cp"], "rings": rings})
    return rebuilt


def even_odd_inside(rings, x, y):
    """Even-odd crossing test over every edge of every ring."""
    crossings = 0
    for ring in rings:
        n = len(ring)
        for k in range(n):
            ax, ay = ring[k]
            bx, by = ring[(k + 1) % n]
            if (ay > y) != (by > y):
                tx = ax + (y - ay) / (by - ay) * (bx - ax)
                if tx > x:
                    crossings += 1
    return crossings & 1


def rasterise_af(rings):
    """Set of filled (i, j) raster cells for the glyph, normalised to its bbox."""
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    if not xs:
        return set()
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    sx = (maxx - minx) or 1
    sy = (maxy - miny) or 1
    cells = set()
    for j in range(R):
        py = miny + (j + 0.5) / R * sy
        for i in range(R):
            px = minx + (i + 0.5) / R * sx
            if even_odd_inside(rings, px, py):
                cells.add((i, j))
    return cells


def rasterise_mask(mask):
    """Set of filled (i, j) raster cells for the sprite, normalised to content."""
    minx, miny, maxx, maxy = content_bounds(mask)
    cw, ch = maxx - minx, maxy - miny
    cells = set()
    for j in range(R):
        py = miny + (j + 0.5) / R * ch
        for i in range(R):
            px = minx + (i + 0.5) / R * cw
            if mask[int(py)][int(px)]:
                cells.add((i, j))
    return cells


def iou(a, b):
    if not a and not b:
        return 1.0
    inter = len(a & b)
    union = len(a) + len(b) - inter
    return 1.0 if union == 0 else inter / union


def main():
    cats = categories()
    grouped = defaultdict(list)
    for path in sorted(SRC.glob("*.png")):
        grouped[category_of(slugify(path.stem), cats)].append(path)

    ok = True
    worst = (1.0, None)
    scores = []
    for category in sorted(grouped):
        files = grouped[category]
        for suffix, ink in VARIANTS:
            name = f"{category}{suffix}.af"
            glyphs = decode_af((DIST / name).read_bytes())
            cat_worst = 1.0
            for glyph, path in zip(glyphs, files):
                score = iou(rasterise_af(glyph["rings"]), rasterise_mask(pixel_mask(path, ink)))
                scores.append(score)
                cat_worst = min(cat_worst, score)
                if score < worst[0]:
                    worst = (score, f"{name} {path.name}")
                if score < THRESHOLD:
                    ok = False
                    print(f"FAIL  {name} {path.name}  IoU {score:.3f} < {THRESHOLD}")
            print(f"  {name:<24} worst IoU {cat_worst:.3f}")

    mean = sum(scores) / len(scores)
    print(f"\n{'ALL PASS' if ok else 'FAILURES'} - {len(scores)} glyphs, "
          f"mean IoU {mean:.3f}, worst {worst[0]:.3f} ({worst[1]})")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
