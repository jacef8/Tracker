#!/usr/bin/env python3
"""
GroundLink app icon — Pine & Powder.

Regenerates every launcher icon from one definition. Run from the repo root:

    python tools/make-icons.py

WHY THIS EXISTS AS CODE AND NOT AS A DRAWING
The old icons were a hand-exported PNG with no source, so "change the accent colour" meant
re-drawing it. The palette now lives in the app's CSS and is going to move again; this file
reads from the same three numbers and re-exports every size in one go.

TWO RULES THIS FILE IS BUILT AROUND (both were broken by the icon it replaces):
 1. FULL BLEED, OPAQUE. The old icon drew its own rounded square on a transparent canvas, so
    Android and iOS masked it a second time and the corners came out blank. Phones cut their
    own shape -- the art has to reach every edge and carry no alpha.
 2. SYMBOL INSIDE THE MIDDLE ~66%. Whatever shape the mask takes, nothing that matters gets
    clipped.

Everything is drawn at 4x and downsampled, which is what gives clean edges without any
vector rasteriser installed.
"""
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'icons')

# ── The palette, straight from body.ui-v2 in index.html ──────────────────────────────────
PINE_HI   = (20, 27, 30)      # --surface #141B1E — top of the ground gradient
PINE_LO   = (8, 12, 14)       # a shade under --bg #0d1117 — bottom
TOPO      = (30, 45, 50)      # contour lines: present, never competing with the mark
MOSS      = (168, 214, 106)   # --accent  #A8D66A
MOSS_DIM  = (118, 158, 68)    # the mark's own shadow side, so it reads as a solid object
AMBER     = (224, 160, 90)    # --accent2 #E0A05A — the needle's north, the one warm note
INK       = (10, 14, 16)      # cut-outs inside the mark

S = 2048                      # working size; every final icon is a downsample of this


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def ground():
    """Opaque pine gradient with topographic contours. Reaches all four edges by construction."""
    img = Image.new('RGB', (S, S), PINE_LO)
    d = ImageDraw.Draw(img)
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(PINE_HI, PINE_LO, y / (S - 1)))

    # Contour rings: a circle whose radius wobbles with angle. Cheap, and it reads as terrain
    # rather than as a pattern because no two rings share a phase.
    # The hill is centred well OFF the canvas, so what crosses the art is a set of long sweeping
    # arcs -- which is what a contour map looks like. Rings centred ON the icon read as a
    # scribble instead, and fight the mark for the middle of the frame.
    ov = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    cx, cy = -S * 0.34, -S * 0.20
    ring = 0
    r = S * 0.46
    while r < S * 2.1:
        ring += 1
        amp = r * 0.055
        ph = ring * 1.37
        pts = []
        for i in range(0, 121):                      # only the quadrant that can reach the art
            th = math.radians(i * 0.75)
            rr = r + amp * math.sin(3 * th + ph) + amp * 0.4 * math.sin(5 * th - ph * 1.7)
            pts.append((cx + rr * math.cos(th), cy + rr * math.sin(th)))
        od.line(pts, fill=TOPO + (255,), width=max(2, int(S * 0.0032)), joint='curve')
        r *= 1.135
    return Image.alpha_composite(img.convert('RGBA'), ov)


def grid(d, cx, cy, w, h, n=5):
    """The ground plane the pin stands on — a quad in perspective, drawn as lines only."""
    def corner(u, v):
        # v: 0 at the far edge, 1 at the near edge. The far edge is narrower, which is the
        # whole of the perspective here.
        k = 0.70 + 0.30 * v          # a gentle taper; more than this and it reads as a pyramid
        return (cx + (u - 0.5) * w * k, cy + (v - 0.5) * h)
    wdt = max(2, int(S * 0.0060))
    for i in range(n + 1):
        t = i / n
        d.line([corner(t, 0.0), corner(t, 1.0)], fill=MOSS + (120,), width=wdt)
        d.line([corner(0.0, t), corner(1.0, t)], fill=MOSS + (120,), width=wdt)


def pin(d, cx, cy, r):
    """Teardrop: a disc with a tapered point below, plus a compass rose cut into it."""
    # Body. The point is built from the two tangent lines of the disc so the join is smooth
    # instead of a triangle stuck on a circle.
    tip = (cx, cy + r * 2.05)      # the point lands ON the grid, not through it
    a = math.asin(min(1.0, r / math.hypot(tip[0] - cx, tip[1] - cy)))
    base = math.atan2(tip[1] - cy, tip[0] - cx)
    p1 = (cx + r * math.cos(base + a + math.pi / 2 - math.pi / 2), cy + r * math.sin(base + a))
    p1 = (cx + r * math.cos(base - (math.pi / 2 - a)), cy + r * math.sin(base - (math.pi / 2 - a)))
    p2 = (cx + r * math.cos(base + (math.pi / 2 - a)), cy + r * math.sin(base + (math.pi / 2 - a)))
    d.polygon([p1, tip, p2], fill=MOSS + (255,))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=MOSS + (255,))

    # Dial: a cut-out back to the ground, so the pin reads as a ring rather than a blob.
    ri = r * 0.62
    d.ellipse([cx - ri, cy - ri, cx + ri, cy + ri], fill=INK + (255,))

    # Tick marks at the quarters — enough to say "compass", few enough to survive at 48px.
    tl, tw = r * 0.17, max(3, int(S * 0.009))
    for k in range(4):
        th = math.radians(90 * k)
        x0, y0 = cx + (ri - tl) * math.cos(th), cy + (ri - tl) * math.sin(th)
        x1, y1 = cx + (ri - tl * 0.18) * math.cos(th), cy + (ri - tl * 0.18) * math.sin(th)
        d.line([(x0, y0), (x1, y1)], fill=MOSS + (255,), width=tw)

    # Needle, tilted off the axis so it looks like a reading and not a decoration.
    th = math.radians(-58)
    nl = ri * 0.80
    nx, ny = math.cos(th), math.sin(th)
    px, py = -ny, nx
    half = ri * 0.22
    d.polygon([(cx + nx * nl, cy + ny * nl),
               (cx + px * half, cy + py * half),
               (cx - px * half, cy - py * half)], fill=AMBER + (255,))      # north
    d.polygon([(cx - nx * nl, cy - ny * nl),
               (cx + px * half, cy + py * half),
               (cx - px * half, cy - py * half)], fill=MOSS_DIM + (255,))   # south


# SMALL SIZES ARE THE HARD CASE. A notification banner draws this at about 20px and a
# Settings row at 29px. At 20px the grid collapses into noise and the needle disappears --
# only the pin silhouette survives, so the pin has to carry the whole icon on its own. The
# grid is therefore lighter and narrower than looks ideal at 1024px, and the pin bigger: the
# icon is tuned for the size it is read at, not the size it is drawn at.
def mark(d, scale=1.0):
    """The pin and its ground plane, centred. `scale` exists for the Android foreground layer,
    which is drawn big and then inset by the launcher."""
    cx, cy = S * 0.50, S * 0.50
    grid(d, cx, cy + S * 0.150 * scale, S * 0.54 * scale, S * 0.19 * scale)
    pin(d, cx, cy - S * 0.085 * scale, S * 0.175 * scale)


def build():
    img = ground()
    d = ImageDraw.Draw(img, 'RGBA')
    # Sits inside the middle 66% — see rule 2 at the top of this file.
    mark(d, 1.0)
    return img.convert('RGB')


def build_foreground():
    """Android adaptive foreground: the mark alone on transparent, drawn large because
    ic_launcher.xml insets this layer by 16.7% before the launcher masks it."""
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    mark(ImageDraw.Draw(img, 'RGBA'), 1.42)
    return img


def main():
    master = build()
    os.makedirs(OUT, exist_ok=True)
    # Maskable and "any" are the SAME art here. That is the point of full bleed: there is no
    # separate padded version to keep in sync, and no safe-zone variant to get wrong.
    # No separate -maskable files. The art is full bleed, so the same PNG serves purpose
    # "any maskable" -- a padded variant is one more thing to keep in sync and get wrong.
    for name, size in [('icon-1024.png', 1024), ('icon-512.png', 512), ('icon-192.png', 192),
                       ('apple-touch-icon.png', 180)]:
        p = os.path.abspath(os.path.join(OUT, name))
        master.resize((size, size), Image.LANCZOS).save(p, 'PNG', optimize=True)
        print('wrote', os.path.relpath(p, os.path.join(OUT, '..', '..')), size)

    # ── Android launcher icons ──────────────────────────────────────────────────────────
    # Three files per density: the legacy square (full bleed, opaque), and the two adaptive
    # layers. The background layer is the ground with NOTHING else on it, so the launcher can
    # mask any shape out of it and still have paint in every corner.
    res = os.path.abspath(os.path.join(OUT, '..', '..', 'native-app', 'android', 'app',
                                       'src', 'main', 'res'))
    if not os.path.isdir(res):
        print('(android res/ not found — skipped native icons)')
        return
    bg = ground().convert('RGB')
    fg = build_foreground()
    for dens, px in [('ldpi', 36), ('mdpi', 48), ('hdpi', 72),
                     ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        folder = os.path.join(res, 'mipmap-' + dens)
        if not os.path.isdir(folder):
            continue
        sq = master.resize((px, px), Image.LANCZOS)
        sq.save(os.path.join(folder, 'ic_launcher.png'), 'PNG', optimize=True)
        sq.save(os.path.join(folder, 'ic_launcher_round.png'), 'PNG', optimize=True)
        bg.resize((px, px), Image.LANCZOS).save(
            os.path.join(folder, 'ic_launcher_background.png'), 'PNG', optimize=True)
        fg.resize((px, px), Image.LANCZOS).save(
            os.path.join(folder, 'ic_launcher_foreground.png'), 'PNG', optimize=True)
        print('wrote mipmap-' + dens, px)


if __name__ == '__main__':
    main()
