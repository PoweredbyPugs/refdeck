from __future__ import annotations

import hashlib
import os
import subprocess
import time
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


def touch(out: Path) -> Path:
    # cache hits refresh the thumb's age: sweep_cache then only ever removes
    # thumbs nothing has needed for the whole TTL (orphans of deleted/changed
    # files), never ones still being served
    try:
        os.utime(out)
    except OSError:
        pass
    return out


def sweep_cache(cache: Path, ttl_days: int = 90) -> int:
    cutoff = time.time() - ttl_days * 86400
    removed = 0
    for f in cache.glob("*.jpg"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def drop_cached(path: Path, cache: Path) -> None:
    """Remove a file's thumb+preview NOW (privacy: deletes must not leave
    thumbnails behind). Needs the file still statable — call before moving."""
    try:
        key = cache_key(path)
    except OSError:
        return
    for name in (f"{key}.jpg", f"{key}_preview.jpg"):
        try:
            (cache / name).unlink(missing_ok=True)
        except OSError:
            pass


def make_thumb(path: Path, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f"{cache_key(path)}.jpg"
    if out.exists():
        return touch(out)
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
        return touch(out)
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        img.thumbnail((2048, 2048))
        img.convert("RGB").save(out, "JPEG", quality=88)
    return out
