# Icon vector fonts (.af)

PicoVector Alright Font (`.af`) icon fonts built from **nikoichu's 1-bit Pixel
Icons**: https://nikoichu.itch.io/pixel-icons

The sibling `../iconfont-ppf` packs these sprites as on-device **bitmap** fonts;
this tool packs the same sprites as **vector** `.af` fonts, the format the
PicoVector `font` module renders on device and `af.js` decodes in the browser.
The sprites are grouped into **one font per category** and each icon is mapped
onto a printable character the way Wingdings maps symbols onto the keyboard: type
`!` in `alchemy.af` and you get the first Alchemy icon, `"` the second, and so on.

Explore the fonts here: https://gadgetoid.github.io/iconfont-af

## How it works

`.af` stores vector contours, not pixels. Each 16x16 sprite is traced into
merged, pixel-accurate outlines (the same tracing as the web-font tool in
`../iconfont`), assembled into a per-category TrueType font, and run through the
official `python_alright_fonts` encoder used by
[`afinate`](../../badgeware/picovector-fonts/alright-fonts/afinate). That encoder
owns all of the `.af` coordinate, bounding-box and advance conventions, so the
output matches what the on-device renderer and `af.js` expect. Contour
coordinates are quantised to signed 8-bit, so the fonts are compact and scalable.

## Layout

Self-contained. The only external inputs are the sprite pack beside this
directory and the encoder beside the badge tooling; everything generated lands in
`dist/`:

```
../1-bit_Pixel_Icons/Sprites/     sprite source          (SPRITES env to override)
../1-bit_Pixel_Icons/Icons_*.png  category name source
build.py                          generator
build-demos.py                    writes demos/<category>.py from the manifest
requirements.txt                  Python deps (Pillow, fonttools, freetype-py, shapely)
af.js                             vendored PicoVector .af decoder (the target)
index.html                        browsable, searchable preview of every font
demos/<category>.py               on-badge grid demo, one per font
verify-af.mjs                     decodes every .af with af.js (structure check)
verify-fidelity.py                shape check vs the source sprites
verify-render.mjs                 real-browser render check via af.js -> canvas
dist/                             generated fonts        (ICONFONT_OUT env to override)
  <category>.af                   one vector font per category (19 fonts)
  fonts.js                        manifest, fonts embedded as base64, for index.html
```

The encoder lives at `~/Development/badgeware/picovector-fonts/alright-fonts` by
default; override with the `ALRIGHT_FONTS` environment variable.

## The font files

One `.af` per category, named after the top one or two tokens of the sprite names
(matching the pack's `Icons_<Category>.png` overview sheets), so most are one
token and two are two (`map_markers.af`, `tools_crafting.af`).

### Character mapping

Icons are assigned printable codepoints in filename order, starting at `!`
(U+0021) and running through the ASCII printable range, then the Latin-1
printable supplement for categories with more than the 94 icons ASCII can hold
(the largest, `software`, has 176). The device renderer decodes UTF-8, so the
Latin-1 codepoints resolve from ordinary strings. `dist/fonts.js` records the
character, codepoint, and a readable name for each glyph; names follow the
sibling tools (category tokens dropped, head noun plus the trailing tokens needed
to be unique).

## Rebuilding

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python build.py    # reads ../1-bit_Pixel_Icons, writes ./dist
```

Override the sprite source with `SPRITES`, the encoder location with
`ALRIGHT_FONTS`, and the output directory with `ICONFONT_OUT`.

## Previewing

`index.html` loads `af.js` as an ES module, so it needs to be served over HTTP
(module scripts do not load from `file://`):

```bash
python3 -m http.server        # then open http://localhost:8000/
```

It parses each embedded font with `af.js` and renders every glyph to a canvas via
`afRender`, with search across all fonts and a per-category filter.

### On the badge

`demos/<category>.py` is a standalone badge script that renders one font's icons
as an aligned grid on a Tufty in HIRES (320x240). Regenerate them from the
manifest with `./.venv/bin/python build-demos.py`. Each demo loads its `.af`
(place the font beside the script on the badge, or edit the `FONT` path), then
draws every icon by walking the same printable characters build.py assigned:

```python
badge.mode(HIRES)
screen.font = font.load("travel.af")
screen.antialias = image.X2
...
for i, ch in enumerate(chars):
    screen.text(ch, MARGIN + (i % COLS) * PITCH, MARGIN + (i // COLS) * PITCH, SIZE)
badge.update()
```

Because these are scalable vector fonts, raise `SIZE` for larger, smoother icons.

## Verifying

```bash
./.venv/bin/python verify-fidelity.py   # rendered shapes match the source sprites
npm install && npm run verify           # every .af decodes via the real af.js
npm run verify:render                   # renders in Chromium, writes proof.png
```

- `verify-af.mjs` parses each file with the vendored `af.js` and checks glyph
  count, that every assigned codepoint resolves, that every glyph has a drawable
  contour, and that the text measures to a positive width.
- `verify-fidelity.py` independently decodes each `.af`, fills its contours with
  the even-odd rule and compares the shape to the source sprite by IoU. `.af` is a
  lossy vector re-encoding, so thin outlines score around 0.75 (a vector fill
  never lands exactly on the pixels it came from) while the mean is ~0.95; the
  gate is a low floor that separates faithful glyphs from broken ones.
- `verify-render.mjs` loads `index.html` in a headless browser (Playwright) over a
  throwaway local server and confirms the glyphs paint distinct, non-empty pixels.

## Credit and licence

Icons are by **nikoichu** - https://nikoichu.itch.io/pixel-icons - and remain
subject to that pack's licence. This directory only contains tooling that
repackages them as fonts. `af.js` and the `python_alright_fonts` encoder are from
the badgeware / alright-fonts projects.
