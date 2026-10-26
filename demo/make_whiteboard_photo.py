"""
Makes demo/whiteboard-photo.jpg: the sample whiteboard (whiteboard.png) as a quick phone snapshot would
look (dim office light, a warm grey cast, low contrast, slightly soft, a darker edge, JPEG noise), so the
demo shows what Cloudinary's e_improve and e_sharpen actually change. The text stays readable.

    python demo/make_whiteboard_photo.py
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

HERE = Path(__file__).parent
src = Image.open(HERE / "whiteboard.png").convert("RGB")
w, h = src.size

photo = src.rotate(-1.5, resample=Image.BICUBIC, expand=False, fillcolor=(128, 128, 124))  # held slightly crooked
photo = ImageEnhance.Contrast(photo).enhance(0.55)          # flat office light
photo = ImageEnhance.Brightness(photo).enhance(0.80)        # a bit dim
photo = ImageChops.multiply(photo, Image.new("RGB", (w, h), (236, 226, 204)))  # warm grey cast
photo = photo.filter(ImageFilter.GaussianBlur(1.4))         # slightly out of focus

# Darker towards the edges, as with a phone camera.
vignette = Image.new("L", (w, h), 0)
ImageDraw.Draw(vignette).ellipse((-w * 0.15, -h * 0.2, w * 1.15, h * 1.2), fill=255)
vignette = vignette.filter(ImageFilter.GaussianBlur(min(w, h) // 6))
photo = Image.composite(photo, ImageEnhance.Brightness(photo).enhance(0.7), vignette)

out = HERE / "whiteboard-photo.jpg"
photo.save(out, quality=72)
print(f"wrote {out} ({out.stat().st_size // 1024} KB, {w}x{h})")
