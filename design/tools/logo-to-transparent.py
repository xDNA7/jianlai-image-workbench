"""Turn the white-background brand logo (JPG) into a transparent PNG.

Every pixel is modelled as `foreground * alpha + white * (1 - alpha)` where the
foreground is one of the logo's solid colours. For each pixel we pick the colour
that explains it best, solve alpha, and keep the pure colour, so anti-aliased
edges stay crisp instead of turning grey.

Usage: python3 logo-to-transparent.py SRC.jpg OUT.png [OUT_WIDTH]
"""
import sys

import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
width = int(sys.argv[3]) if len(sys.argv) > 3 else 800

img = np.asarray(Image.open(src).convert("RGB")).astype(float)
h, w, _ = img.shape
flat = img.reshape(-1, 3)
non_white = (flat < 235).any(axis=1)


def solid(mask_fn):
    """Median colour of the pixels selected by mask_fn among non-white pixels."""
    px = flat[non_white]
    return np.median(px[mask_fn(px)], axis=0)


lum = lambda p: p.mean(axis=1)
sat = lambda p: p.max(axis=1) - p.min(axis=1)
orange = solid(lambda p: (sat(p) > 120) & (p[:, 0] > 200))
gray = solid(lambda p: (sat(p) < 20) & (lum(p) > 45) & (lum(p) < 80))
black = solid(lambda p: (sat(p) < 20) & (lum(p) < 30))
palette = np.stack([gray, black, orange])
print("palette:", palette.round().astype(int).tolist())

white = np.array([255.0, 255.0, 255.0])


def unmix(color):
    d = color - white
    alpha = np.clip(((flat - white) @ d) / (d @ d), 0, 1)
    recon = white + alpha[:, None] * d
    return alpha, ((flat - recon) ** 2).sum(axis=1)


alphas, errs = zip(*(unmix(c) for c in palette))
alphas, errs = np.stack(alphas), np.stack(errs)
first = errs.argmin(axis=0)

# Edge pixels are ambiguous (a grey edge also fits "black at low alpha"), so let
# every pixel take the colour of the nearest solid pixel instead.
solid_mask = (np.take_along_axis(alphas, first[None], 0)[0] > 0.9) & (
    np.take_along_axis(errs, first[None], 0)[0] < 300
)
labels = np.where(solid_mask, first, -1).reshape(h, w)
# Grow the solid regions outwards a few pixels (anti-aliased edges are 1-3 px).
for _ in range(6):
    padded = np.pad(labels, 1, constant_values=-1)
    grown = labels.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            neighbour = padded[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w]
            take = (grown < 0) & (neighbour >= 0)
            grown[take] = neighbour[take]
    labels = grown
cls = labels.reshape(-1)
known = cls >= 0
cls = np.where(known, cls, 0)
best_alpha = np.take_along_axis(alphas, cls[None], 0)[0] * known
best_color = palette[cls]

# JPEG noise on the white background leaves tiny alphas; drop them.
best_alpha[best_alpha < 0.05] = 0
best_alpha[best_alpha > 0.96] = 1

rgba = np.concatenate([best_color, best_alpha[:, None] * 255], axis=1)
rgba = rgba.reshape(h, w, 4).round().astype(np.uint8)
im = Image.fromarray(rgba, "RGBA")
bbox = im.getchannel("A").point(lambda v: 255 if v > 0 else 0).getbbox()
pad = 12
im = im.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(w, bbox[2] + pad), min(h, bbox[3] + pad)))
im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
im.save(out, optimize=True)
a = np.asarray(im.getchannel("A"))
print(f"{out}: {im.size[0]}x{im.size[1]}, transparent {round((a == 0).mean() * 100)}%, opaque {round((a == 255).mean() * 100)}%")
