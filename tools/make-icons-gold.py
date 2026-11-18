"""Builds every GroundLink app icon from the gold artwork (tools/icon-source-gold.png).

2026-11-17: Jace didn't like the green Pine & Powder icon (tools/make-icons.py, build 943) and
asked for the old gold one back. The gold art is a raster from July with its own rounded card
drawn on it, so it is cropped inside the card first: phones cut their own shape, and a drawn
card would leave blank corners on the home screen.

Writes the web icons (192/512/1024 + Apple touch icon) and all Android launcher densities.
The iPhone app icon (Assets.xcassets/AppIcon.appiconset) already IS this gold art -- it was
never switched to green -- so it is left alone.
"""
import os
from PIL import Image, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'icon-source-gold.png')
WEB = os.path.join(HERE, '..', 'public', 'icons')
RES = os.path.join(HERE, '..', 'native-app', 'android', 'app', 'src', 'main', 'res')
CROP = 0.15          # trims the drawn card and its dark margin; checked by eye, no corner shows


def master():
    im = Image.open(SRC).convert('RGB')
    w, h = im.size
    c = int(w * CROP)
    return im.crop((c, c, w - c, h - c)).resize((1024, 1024), Image.LANCZOS)


def edge_color(im):
    """Average colour of the art's outer ring, to paint the adaptive layer's overscan."""
    w, h = im.size
    strip = Image.new('RGB', (w, 8))
    strip.paste(im.crop((0, 0, w, 4)), (0, 0)); strip.paste(im.crop((0, h - 4, w, h)), (0, 4))
    return tuple(int(v) for v in ImageStat.Stat(strip).mean)


def main():
    m = master()
    for name, size in [('icon-1024.png', 1024), ('icon-512.png', 512), ('icon-192.png', 192),
                       ('apple-touch-icon.png', 180)]:
        m.resize((size, size), Image.LANCZOS).save(os.path.join(WEB, name), 'PNG', optimize=True)
        print('wrote', name, size)

    # Android adaptive icon: the launcher shows only the middle 72 of 108 units of each layer.
    # The whole picture goes on the BACKGROUND layer, scaled into that middle 2/3, with the
    # overscan painted in the art's own edge colour (never blank). Foreground is empty.
    bgc = edge_color(m)
    big = Image.new('RGB', (1620, 1620), bgc)
    big.paste(m.resize((1080, 1080), Image.LANCZOS), (270, 270))
    empty = Image.new('RGBA', (1620, 1620), (0, 0, 0, 0))
    for dens, px in [('ldpi', 36), ('mdpi', 48), ('hdpi', 72),
                     ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        folder = os.path.join(RES, 'mipmap-' + dens)
        if not os.path.isdir(folder):
            continue
        sq = m.resize((px, px), Image.LANCZOS)
        sq.save(os.path.join(folder, 'ic_launcher.png'), 'PNG', optimize=True)
        sq.save(os.path.join(folder, 'ic_launcher_round.png'), 'PNG', optimize=True)
        lp = round(px * 1.5)                       # adaptive layers are 108dp vs 72dp legacy
        big.resize((lp, lp), Image.LANCZOS).save(os.path.join(folder, 'ic_launcher_background.png'), 'PNG', optimize=True)
        empty.resize((lp, lp)).save(os.path.join(folder, 'ic_launcher_foreground.png'), 'PNG', optimize=True)
        print('wrote mipmap-' + dens, px)


if __name__ == '__main__':
    main()
