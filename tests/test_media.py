from pathlib import Path

from app.media import MediaRoots, classify_media


def test_classify_media_knows_images_and_videos():
    assert classify_media(Path("cat.JPG")) == "image"
    assert classify_media(Path("clip.mov")) == "video"
    assert classify_media(Path("art.psd")) == "image"
    assert classify_media(Path("notes.txt")) is None
    assert classify_media(Path("code.ts")) is None  # TypeScript, not MPEG transport stream


def test_media_roots_blocks_path_traversal(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    outside = tmp_path / "secret"
    outside.mkdir()
    roots = MediaRoots({"media": root})

    try:
        roots.resolve("media", "../secret")
    except ValueError as exc:
        assert "escapes" in str(exc)
    else:
        raise AssertionError("expected traversal to be blocked")


def test_dynamic_roots_and_status(tmp_path):
    good = tmp_path / "good"
    good.mkdir()
    roots = MediaRoots({})
    roots.add("Good", good)
    roots.add("Gone", tmp_path / "missing")
    status = {s["name"]: s["online"] for s in roots.status()}
    assert status == {"Good": True, "Gone": False}
    roots.remove("Gone")
    assert [s["name"] for s in roots.status()] == ["Good"]


def test_list_dirs_only(tmp_path):
    base = tmp_path / "base"
    (base / "sub").mkdir(parents=True)
    (base / "a.jpg").write_bytes(b"x")
    roots = MediaRoots({"R": base})
    listing = roots.list_dirs("R")
    assert listing["dirs"] == [{"name": "sub", "path": "sub"}]
    assert "files" not in listing
