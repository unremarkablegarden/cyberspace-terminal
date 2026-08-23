#!/usr/bin/env python3
"""Icons: the site's globe mark, in P1 phosphor on an unlit tube.

Source is the site's favicon (cream on black); the beam colour is PHOSPHORS
.matrix at full intensity. Run by hand when either changes.
"""

import sys
from PIL import Image, ImageFilter

SRC = '../nuxt/public/favicon2.png'
OUT = 'app/public/icons'
GREEN = (46, 255, 92)  # [0.18, 1.00, 0.36] * 255
SIZES = {'icon-192': 192, 'icon-512': 512, 'apple-touch-icon': 180}
MASKABLE = 512
SAFE = 0.6  # maskable glyph inside the safe circle


def mask(path):
    """Glyph coverage, 0..255, from the cream-on-black source."""
    im = Image.open(path).convert('L')
    peak = max(im.getdata())
    return im.point(lambda v: min(255, round(v * 255 / peak)))


def tint(m, size, scale=1.0):
    inner = round(size * scale)
    m = m.resize((inner, inner), Image.LANCZOS)
    if scale != 1.0:
        m = m.filter(ImageFilter.UnsharpMask(radius=2, percent=120))
    glyph = Image.new('RGB', (inner, inner), GREEN)
    out = Image.new('RGB', (size, size), (0, 0, 0))
    off = (size - inner) // 2
    out.paste(glyph, (off, off), m)
    return out


def main():
    m = mask(SRC)
    for name, size in SIZES.items():
        tint(m, size).save(f'{OUT}/{name}.png')
    tint(m, MASKABLE, SAFE).save(f'{OUT}/maskable-512.png')
    print('wrote', len(SIZES) + 1, 'icons')


if __name__ == '__main__':
    sys.exit(main())
