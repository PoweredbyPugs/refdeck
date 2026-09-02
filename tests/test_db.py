from app.db import RefDeckDB


def test_db_bootstraps_roots_and_roundtrips_collections_and_boards(tmp_path):
    db = RefDeckDB(tmp_path / "refdeck.db")
    db.init([("Shirahoshi", "/media/Shirahoshi")])

    roots = db.roots()
    assert roots == [{"id": 1, "name": "Shirahoshi", "path": "/media/Shirahoshi"}]

    collection = db.create_collection("Kitchen")
    db.add_collection_item(collection["id"], "/media/Shirahoshi/a.jpg", "image")
    collections = db.collections()
    assert collections[0]["title"] == "Kitchen"
    assert collections[0]["items"][0]["path"] == "/media/Shirahoshi/a.jpg"

    board_doc = {"items": [{"path": "/media/Shirahoshi/a.jpg", "x": 10, "y": 20}]}
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
