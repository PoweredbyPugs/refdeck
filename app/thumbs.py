from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .media import VIDEO_EXTS

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

BROWSER_SAFE = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".insp"}
# extensions whose real content type mimetypes can't guess (.insp = Insta360 JPEG)
MIME_OVERRIDES = {".insp": "image/jpeg"}


def cache_key(path: Path) -> str:
    stat = path.stat()
    return hashlib.sha1(f"{path}:{stat.st_mtime}:{stat.st_size}".encode()).hexdigest()


def needs_conversion(path: Path) -> bool:
    return path.suffix.lower() not in BROWSER_SAFE


def make_thumb(path: Path, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f"{cache_key(path)}.jpg"
    if out.exists():
        return out
    if path.suffix.lower() in VIDEO_EXTS:
        try:
            subprocess.run([
                "ffmpeg", "-y", "-i", str(path), "-ss", "00:00:01",
                "-frames:v", "1", "-vf", "scale=360:-1", str(out),
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            return out
        except Exception:
            make_placeholder(out, "VIDEO")
            return out
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            img.thumbnail((360, 360))
            canvas = Image.new("RGB", img.size, "#111")
            if img.mode in ("RGBA", "LA"):
                canvas.paste(img, mask=img.getchannel("A"))
            else:
                canvas.paste(img.convert("RGB"))
            canvas.save(out, "JPEG", quality=82)
    except Exception:
        make_placeholder(out, path.suffix.upper().lstrip(".") or "FILE")
    return out


def make_placeholder(out: Path, text: str) -> None:
    img = Image.new("RGB", (360, 220), "#24262d")
    draw = ImageDraw.Draw(img)
    draw.text((180, 110), text[:12], fill="#9da3b2", anchor="mm")
    img.save(out, "JPEG", quality=80)


def make_preview(path: Path, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f"{cache_key(path)}_preview.jpg"
    if out.exists():
        return out
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        img.thumbnail((2048, 2048))
        img.convert("RGB").save(out, "JPEG", quality=88)
    return out
