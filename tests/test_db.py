from app.db import RefDeckDB


def test_db_bootstraps_roots_and_roundtrips_collections_and_boards(tmp_path):
    db = RefDeckDB(tmp_path / "refdeck.db")
    db.init([("Drive", "/media/Drive")])

    roots = db.roots()
    assert roots == [{"id": 1, "name": "Drive", "path": "/media/Drive"}]

    collection = db.create_collection("Kitchen")
    db.add_collection_item(collection["id"], "/media/Drive/a.jpg", "image")
    collections = db.collections()
    assert collections[0]["title"] == "Kitchen"
    assert collections[0]["items"][0]["path"] == "/media/Drive/a.jpg"

    board_doc = {"items": [{"path": "/media/Drive/a.jpg", "x": 10, "y": 20}]}
    board = db.save_board(None, "Moodboard", board_doc)
    loaded = db.board(board["id"])
    assert loaded["title"] == "Moodboard"
    assert loaded["document"]["items"][0]["x"] == 10

    updated = db.save_board(board["id"], "Moodboard 2", {"items": []})
    assert updated["id"] == board["id"]
    assert db.board(board["id"])["title"] == "Moodboard 2"


def test_delete_collection_cascades_items(tmp_path):
    db = RefDeckDB(tmp_path / "t.db")
    db.init([("Media", "/tmp/media")])
    col = db.create_collection("Refs")
    db.add_collection_item(col["id"], "Media/a.jpg", "image")
    db.delete_collection(col["id"])
    assert db.collections() == []
    with db.connect() as con:
        assert con.execute("select count(*) from collection_items").fetchone()[0] == 0


def test_delete_board(tmp_path):
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    board = db.save_board(None, "B", {"items": []})
    db.delete_board(board["id"])
    assert db.boards() == []


def _entry(path, size=10, mtime=100, media_type="image"):
    from pathlib import PurePosixPath
    p = PurePosixPath(path)
    return {"path": path, "name": p.name, "dir": "" if str(p.parent) == "." else str(p.parent),
            "media_type": media_type, "size": size, "mtime": mtime}


def test_upsert_and_remove_missing(tmp_path):
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    db.upsert_files("R", [_entry("a.jpg"), _entry("sub/b.jpg")])
    assert db.media_count("R") == 2
    db.upsert_files("R", [_entry("a.jpg", size=99), _entry("sub/c.jpg")])
    assert db.media_count("R") == 3  # upsert alone never removes
    assert db.query_files("R", query="a.jpg")["files"][0]["size"] == 99
    removed = db.remove_missing("R", {"a.jpg", "sub/c.jpg"})
    assert removed == 1 and db.media_count("R") == 2


def test_hidden_flag_filters_and_survives_rescan(tmp_path):
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    db.upsert_files("R", [_entry("a.jpg"), _entry("b.jpg")])
    assert db.set_hidden("R", ["a.jpg"], True) == 1
    assert [f["name"] for f in db.query_files("R")["files"]] == ["b.jpg"]
    both = db.query_files("R", include_hidden=True)
    assert both["total"] == 2
    assert {f["name"]: f["hidden"] for f in both["files"]} == {"a.jpg": 1, "b.jpg": 0}
    assert db.media_count("R") == 1  # hidden files don't count
    db.upsert_files("R", [_entry("a.jpg", size=99)])  # rescan must not unhide
    assert db.query_files("R")["total"] == 1
    db.set_hidden("R", ["a.jpg"], False)
    assert db.query_files("R")["total"] == 2


def test_query_files_recursive_search_sort(tmp_path):
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    db.upsert_files("R", [_entry("z.jpg", mtime=1), _entry("sub/a.jpg", mtime=9),
                        _entry("sub/deep/b.png", mtime=5)])
    flat = db.query_files("R", dir="")
    assert [f["name"] for f in flat["files"]] == ["z.jpg"] and flat["total"] == 1
    drill = db.query_files("R", dir="", recursive=True, sort="date")
    assert [f["name"] for f in drill["files"]] == ["a.jpg", "b.png", "z.jpg"]
    sub = db.query_files("R", dir="sub", recursive=True)
    assert sub["total"] == 2
    hit = db.query_files("R", recursive=True, query="deep")
    assert [f["name"] for f in hit["files"]] == ["b.png"]
    page = db.query_files("R", recursive=True, limit=2, offset=2, sort="name")
    assert page["total"] == 3 and len(page["files"]) == 1
    assert db.media_count("R", "sub") == 2


def test_query_files_type_and_ext_filters(tmp_path):
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    db.upsert_files("R", [_entry("a.jpg"), _entry("b.PNG"), _entry("c.mov", media_type="video"),
                        _entry("sub/d.jpeg")])
    videos = db.query_files("R", recursive=True, media_type="video")
    assert [f["name"] for f in videos["files"]] == ["c.mov"]
    jpgs = db.query_files("R", recursive=True, exts=["jpg", "jpeg"])
    assert {f["name"] for f in jpgs["files"]} == {"a.jpg", "d.jpeg"}
    pngs = db.query_files("R", recursive=True, media_type="image", exts=["png"])
    assert [f["name"] for f in pngs["files"]] == ["b.PNG"]


def test_backup_snapshots_and_prunes(tmp_path):
    db = RefDeckDB(tmp_path / "refdeck.db")
    db.init([])
    db.create_collection("Kitchen")
    dest = tmp_path / "backups"

    made = db.backup(dest, stamp="2026-09-11")
    copy = RefDeckDB(made)
    assert [c["title"] for c in copy.collections()] == ["Kitchen"]

    # same-day backup overwrites, doesn't accumulate
    db.backup(dest, stamp="2026-09-11")
    assert len(list(dest.glob("refdeck-*.db"))) == 1

    # only the newest `keep` snapshots survive
    for day in range(1, 9):
        db.backup(dest, stamp=f"2026-09-0{day}")
    names = sorted(p.name for p in dest.glob("refdeck-*.db"))
    assert len(names) == 7
    assert names[0] == "refdeck-2026-09-03.db"  # oldest pruned as each backup ran
    assert names[-1] == "refdeck-2026-09-11.db"


ENTRY_A = {"path": "a.jpg", "name": "a.jpg", "dir": "", "media_type": "image", "size": 1, "mtime": 1}
ENTRY_B = {"path": "b.jpg", "name": "b.jpg", "dir": "", "media_type": "image", "size": 2, "mtime": 2}


def test_hidden_marks_survive_index_wipe_and_rescan(tmp_path):
    # Hidden choices are user data; the index is disposable. Losing every
    # files row (the dead-mount wipe) must not lose what's hidden.
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    db.upsert_files("R", [ENTRY_A, ENTRY_B])
    db.set_hidden("R", ["a.jpg"], True)
    db.remove_missing("R", set())  # index wiped
    db.upsert_files("R", [ENTRY_A, ENTRY_B])  # rescan rebuilds
    flags = {f["path"]: f["hidden"] for f in db.query_files("R", include_hidden=True)["files"]}
    assert flags == {"a.jpg": 1, "b.jpg": 0}


def test_unhide_forgets_the_mark(tmp_path):
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    db.upsert_files("R", [ENTRY_A])
    db.set_hidden("R", ["a.jpg"], True)
    db.set_hidden("R", ["a.jpg"], False)
    db.remove_missing("R", set())
    db.upsert_files("R", [ENTRY_A])
    assert db.query_files("R", include_hidden=True)["files"][0]["hidden"] == 0


def test_legacy_hidden_flags_seed_marks_on_init(tmp_path):
    # Pre-marks DBs only have files.hidden=1 rows; init() must seed the
    # durable marks from them so existing hidden choices become permanent.
    db = RefDeckDB(tmp_path / "t.db")
    db.init([])
    db.upsert_files("R", [ENTRY_A])
    with db.connect() as con:  # legacy-style flag, no mark
        con.execute("update files set hidden=1 where path='a.jpg'")
    db.init([])  # next boot migrates
    db.remove_missing("R", set())
    db.upsert_files("R", [ENTRY_A])
    assert db.query_files("R", include_hidden=True)["files"][0]["hidden"] == 1
