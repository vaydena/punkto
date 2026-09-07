#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Punkto Icon-Generator -> erzeugt alle PWA-Icons (Marke: grünes, abgerundetes
Quadrat mit amberfarbenem Punkt in der Mitte). Kein icon-source.png nötig.

    icon-192.png          (purpose "any")
    icon-512.png          (purpose "any")
    icon-maskable-512.png (purpose "maskable" — vollflächig grün + Safe-Zone)
    apple-touch-icon.png  (180x180, opak)

Aufruf:  python gen_icons.py   (Voraussetzung: pip install pillow)
Hinweis (Hostinger-CDN 'hcdn' re-komprimiert PNGs): Live-Icons NICHT per Byte-Größe
prüfen, sondern per Pixel-Diff.
"""
import os
from PIL import Image, ImageDraw

GREEN   = (15, 169, 88)      # #0fa958  Markenprimär
AMBER   = (255, 197, 85)     # #ffc555  Punkt
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SS      = 4                  # Supersampling für saubere Kanten
DOT_R   = 0.194             # Punktradius relativ zur Kantenlänge (6.6/34 wie im Logo)


def rounded_bg(size, radius_frac=0.294, fill=GREEN):
    """Abgerundetes, vollflächiges Quadrat (rx 10 / 34 ≈ 0.294 wie im Logo)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_frac)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=fill + (255,))
    return img


def dot(draw, size, r_frac=DOT_R, fill=AMBER):
    """Amber-Punkt exakt in der Mitte."""
    c = size / 2.0
    r = size * r_frac
    draw.ellipse([c - r, c - r, c + r, c + r], fill=fill + (255,))


def make_any(size):
    big = size * SS
    img = rounded_bg(big)
    dot(ImageDraw.Draw(img), big)
    return img.resize((size, size), Image.LANCZOS)


def make_maskable(size=512):
    """Vollflächig grün (kein Rundung, füllt die ganze Fläche) + Punkt in Safe-Zone."""
    big = size * SS
    img = Image.new("RGBA", (big, big), GREEN + (255,))
    # Punkt etwas kleiner, damit er sicher in der maskable Safe-Zone (80%) liegt
    dot(ImageDraw.Draw(img), big, r_frac=DOT_R * 0.82)
    return img.resize((size, size), Image.LANCZOS)


def make_apple(size=180):
    """Opak (weiß unterlegt) — iOS mag keine Transparenz."""
    icon = make_any(size)
    flat = Image.new("RGB", (size, size), (255, 255, 255))
    flat.paste(icon, (0, 0), icon)
    return flat


def save(img, name):
    p = os.path.join(OUT_DIR, name)
    img.save(p, "PNG")
    print("  geschrieben:", name, img.size)


if __name__ == "__main__":
    save(make_any(192), "icon-192.png")
    save(make_any(512), "icon-512.png")
    save(make_maskable(512), "icon-maskable-512.png")
    save(make_apple(180), "apple-touch-icon.png")
    print("Fertig — vier Icons erzeugt.")
