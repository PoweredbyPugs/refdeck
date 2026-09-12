from PIL import Image

from app.thumbs import make_preview, make_thumb, needs_conversion


def make_image(path, size=(3000, 2000), fmt=None):
    Image.new("RGB", size, "#336699").save(path, fmt)


def test_make_thumb_and_cache(tmp_path):
    src = tmp_path / "big.png"
    make_image(src)
    cache = tmp_path / "cache"
    thumb = make_thumb(src, cache)
    assert thumb.exists()
    with Image.open(thumb) as img:
        assert max(img.size) <= 360
    assert make_thumb(src, cache) == thumb


def test_thumb_failure_yields_labeled_placeholder(tmp_path):
    bad = tmp_path / "broken.tif"
    bad.write_bytes(b"not an image")
    thumb = make_thumb(bad, tmp_path / "cache")
    with Image.open(thumb) as img:
        colors = {c for _, c in img.convert("RGB").getcolors(maxcolors=100000)}
    assert len(colors) > 1  # text was drawn, not a flat box


def test_needs_conversion():
    from pathlib import Path
    assert needs_conversion(Path("a.psd"))
    assert needs_conversion(Path("a.HEIC"))
    assert not needs_conversion(Path("a.jpg"))
    assert not needs_conversion(Path("a.webp"))


def test_make_preview_converts_tiff(tmp_path):
    src = tmp_path / "deep.tif"
    make_image(src, size=(4000, 1000), fmt="TIFF")
    out = make_preview(src, tmp_path / "cache")
    with Image.open(out) as img:
        assert img.format == "JPEG"
        assert max(img.size) <= 2048


def test_cache_hit_refreshes_thumb_age(tmp_path):
    # Serving a cached thumb must bump its mtime so the staleness sweep
    # only ever removes thumbs nobody has needed for the whole TTL.
    import os
    src = tmp_path / "pic.png"
    make_image(src, size=(100, 100))
    cache = tmp_path / "cache"
    thumb = make_thumb(src, cache)
    os.utime(thumb, (1, 1))
    make_thumb(src, cache)
    assert thumb.stat().st_mtime > 1


def test_sweep_cache_deletes_only_stale(tmp_path):
    import os
    from app.thumbs import sweep_cache
    cache = tmp_path / "cache"
    cache.mkdir()
    old = cache / "old.jpg"
    old.write_bytes(b"x")
    os.utime(old, (1, 1))
    fresh = cache / "fresh.jpg"
    fresh.write_bytes(b"x")
    assert sweep_cache(cache, ttl_days=90) == 1
    assert not old.exists() and fresh.exists()
