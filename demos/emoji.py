# Emoji icons - 24 glyphs from emoji.af
#
# Renders every icon in the font as an aligned grid. Each icon is mapped to a
# printable character (Wingdings style) from "!" upward; see ../dist/fonts.js
# for the character-to-name mapping. Place emoji.af alongside this script on the
# badge, or adjust the load path below.
#
# These are scalable vector fonts, so raise SIZE for larger, smoother icons.

FONT = "emoji.af"
COUNT = 24

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
