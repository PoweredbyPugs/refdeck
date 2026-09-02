from pathlib import Path

from app.db import RefDeckDB
from app.indexer import ScanManager, walk_media
from app.media import MediaRoots


def make_tree(base: Path):
    (base / "sub/deep").mkdir(parents=True)
    (base / "top.jpg").write_bytes(b"x")
    (base / "sub/mid.png").write_bytes(b"xx")
    (base / "sub/deep/low.jpg").write_bytes(b"xxx")
    (base / "sub/notes.txt").write_bytes(b"skip")
    (base / ".hidden.jpg").write_bytes(b"skip")


def test_walk_media_skips_ignore_marker(tmp_path):
    make_tree(tmp_path)
    (tmp_path / "app-home").mkdir()
    (tmp_path / "app-home" / "cached.jpg").write_bytes(b"skip")
    (tmp_path / "app-home" / ".refdeck-ignore").write_bytes(b"")
    entries = walk_media(tmp_path)
    assert "app-home/cached.jpg" not in {e["path"] for e in entries}


def test_walk_media(tmp_path):
    make_tree(tmp_path)
    entries = {e["path"]: e for e in walk_media(tmp_path)}
    assert set(entries) == {"top.jpg", "sub/mid.png", "sub/deep/low.jpg"}
    assert entries["top.jpg"]["dir"] == ""
    assert entries["sub/deep/low.jpg"]["dir"] == "sub/deep"
    assert entries["sub/mid.png"]["media_type"] == "image"


def test_scan_skips_thumbnails_when_disk_low(tmp_path, monkeypatch):
    import app.indexer as indexer
    monkeypatch.setattr(indexer, "free_bytes", lambda p: 0)
    base = tmp_path / "media"
    base.mkdir()
    make_tree(base)
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    thumbed = []
    scanner = ScanManager(MediaRoots({"R": base}), db, thumb_fn=thumbed.append)
    scanner.start("R")
    scanner.wait("R")
    assert db.media_count("R") == 3  # index still complete
    assert thumbed == []  # thumbnails skipped
    assert scanner.status()["R"]["thumbs_paused"] == "low disk space"


def test_interrupted_walk_keeps_committed_batches_and_skips_prune(tmp_path, monkeypatch):
    # A container restart (or CIFS drop) mid-walk must not lose progress or
    # prune rows it never got to see — pruning is only safe after a FULL walk.
    import app.indexer as indexer
    monkeypatch.setattr(indexer, "free_bytes", lambda p: 10 * 1024 ** 3)
    monkeypatch.setattr(indexer, "BATCH_SIZE", 1)
    base = tmp_path / "media"
    base.mkdir()
    make_tree(base)
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    # a file indexed on a previous run that is gone from disk now
    db.upsert_files("R", [{"path": "stale.jpg", "name": "stale.jpg", "dir": "",
                           "media_type": "image", "size": 1, "mtime": 1}])

    real_walk = indexer.walk_media

    def dying_walk(b):
        for i, entry in enumerate(real_walk(b)):
            if i == 1:
                raise OSError("network dropped")
            yield entry

    monkeypatch.setattr(indexer, "walk_media", dying_walk)
    scanner = ScanManager(MediaRoots({"R": base}), db)
    scanner.start("R")
    scanner.wait("R")
    assert db.media_count("R") == 2  # 1 walked file committed + stale row kept
    assert scanner.status()["R"]["state"] == "idle"

    monkeypatch.setattr(indexer, "walk_media", real_walk)
    scanner.start("R")
    scanner.wait("R")
    assert db.media_count("R") == 3  # full walk indexes everything, prunes stale


def test_scan_manager_indexes_and_reports(tmp_path, monkeypatch):
    import app.indexer as indexer
    monkeypatch.setattr(indexer, "free_bytes", lambda p: 10 * 1024 ** 3)
    base = tmp_path / "media"
    base.mkdir()
    make_tree(base)
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    thumbed = []
    scanner = ScanManager(MediaRoots({"R": base}), db, thumb_fn=thumbed.append)
    assert scanner.start("R") is True
    scanner.wait("R")
    assert scanner.status()["R"]["state"] == "idle"
    assert db.media_count("R") == 3
    assert len(thumbed) == 3
