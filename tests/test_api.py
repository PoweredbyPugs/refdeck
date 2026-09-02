from fastapi.testclient import TestClient

from app.main import create_app


def make_client(tmp_path, monkeypatch, tree=True):
    media = tmp_path / "media"
    (media / "sub").mkdir(parents=True)
    if tree:
        (media / "top.jpg").write_bytes(b"fake")
        (media / "sub" / "nested.png").write_bytes(b"fake")
    monkeypatch.setenv("REFDECK_ROOTS", f"Media={media}")
    monkeypatch.setenv("REFDECK_DATA_DIR", str(tmp_path / "data"))
    app = create_app()
    client = TestClient(app)
    # TestClient only runs startup events as a context manager, so trigger the scan directly
    app.state.scanner.start("Media")
    app.state.scanner.wait("Media")
    return client, media


def test_roots_online_and_counts(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch)
    roots = {r["name"]: r for r in client.get("/api/roots").json()}
    assert set(roots) == {"Media"}  # depth maps are served via /api/depth, not a root
    assert roots["Media"]["online"] is True and roots["Media"]["media_count"] == 2


def test_missing_root_is_offline_not_home(tmp_path, monkeypatch):
    monkeypatch.setenv("REFDECK_ROOTS", f"Gone={tmp_path / 'nope'}")
    monkeypatch.setenv("REFDECK_DATA_DIR", str(tmp_path / "data"))
    roots = {r["name"]: r for r in TestClient(create_app()).get("/api/roots").json()}
    assert roots["Gone"]["online"] is False


def test_browse_dirs_only_with_recursive_count(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch)
    listing = client.get("/api/browse", params={"root": "Media", "path": ""}).json()
    assert listing["dirs"] == [{"name": "sub", "path": "sub"}]
    assert "files" not in listing
    assert listing["media_count"] == 2
    assert client.get("/api/browse", params={"root": "Media", "path": "../"}).status_code == 400


def test_browse_tolerates_unstatable_entries(tmp_path, monkeypatch):
    # Docker bind mounts refuse to stat macOS system dirs like .TemporaryItems —
    # one bad entry must not 500 the whole listing (it broke the sidebar tree).
    from pathlib import Path
    client, media = make_client(tmp_path, monkeypatch)
    (media / ".TemporaryItems").mkdir()
    (media / "locked").mkdir()
    real_is_dir = Path.is_dir

    def guarded(self, **kwargs):
        if self.name in (".TemporaryItems", "locked"):
            raise PermissionError(13, "Permission denied", str(self))
        return real_is_dir(self, **kwargs)

    monkeypatch.setattr(Path, "is_dir", guarded)
    listing = client.get("/api/browse", params={"root": "Media", "path": ""}).json()
    assert [d["name"] for d in listing["dirs"]] == ["sub"]


def test_files_flat_vs_drill_and_rescan(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    flat = client.get("/api/files", params={"root": "Media"}).json()
    assert [f["name"] for f in flat["files"]] == ["top.jpg"]
    drill = client.get("/api/files", params={"root": "Media", "recursive": 1}).json()
    assert drill["total"] == 2
    (media / "new.png").write_bytes(b"fake")
    assert client.post("/api/scan/Media").json()["started"] is True
    client.app.state.scanner.wait("Media")
    assert client.get("/api/files", params={"root": "Media", "recursive": 1}).json()["total"] == 3
    assert client.get("/api/scan/status").json()["Media"]["state"] == "idle"


def test_media_thumb_preview_404_when_gone(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch)
    for endpoint in ("/api/media", "/api/thumb", "/api/preview"):
        r = client.get(endpoint, params={"root": "Media", "path": "ghost.jpg"})
        assert r.status_code == 404, endpoint


def test_collection_board_roundtrip_and_delete(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, tree=False)
    col = client.post("/api/collections", json={"title": "Refs"}).json()
    client.post(f"/api/collections/{col['id']}/items",
                json={"path": "Media/a.jpg", "media_type": "image"})
    assert client.get("/api/collections").json()[0]["items"][0]["media_type"] == "image"
    assert client.delete(f"/api/collections/{col['id']}").json() == {"ok": True}
    assert client.get("/api/collections").json() == []

    board = client.post("/api/boards", json={"title": "B", "document": {"items": []}}).json()
    assert client.get(f"/api/boards/{board['id']}").json()["title"] == "B"
    assert client.delete(f"/api/boards/{board['id']}").json() == {"ok": True}
    assert client.get("/api/boards").json() == []


def test_files_type_and_ext_filters(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    (media / "clip.mov").write_bytes(b"fake")
    client.post("/api/scan/Media")
    client.app.state.scanner.wait("Media")
    videos = client.get("/api/files", params={"root": "Media", "recursive": 1, "type": "video"}).json()
    assert [f["name"] for f in videos["files"]] == ["clip.mov"]
    pngs = client.get("/api/files", params={"root": "Media", "recursive": 1, "exts": "png"}).json()
    assert [f["name"] for f in pngs["files"]] == ["nested.png"]


def test_depth_endpoint_guards(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    (media / "clip.mov").write_bytes(b"fake")
    client.post("/api/scan/Media")
    client.app.state.scanner.wait("Media")
    assert client.get("/api/depth", params={"root": "Media", "path": "ghost.jpg"}).status_code == 404
    resp = client.get("/api/depth", params={"root": "Media", "path": "clip.mov"})
    assert resp.status_code == 400 and "images only" in resp.json()["detail"]


def test_delete_moves_files_to_trash_and_deindexes(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    resp = client.post("/api/files/delete",
                       json={"root": "Media", "paths": ["top.jpg", "sub/nested.png"]})
    assert resp.status_code == 200
    body = resp.json()
    assert sorted(d["path"] for d in body["deleted"]) == ["sub/nested.png", "top.jpg"]
    assert body["errors"] == {}
    assert not (media / "top.jpg").exists()
    for d in body["deleted"]:
        assert (media / ".refdeck-trash" / d["trash"]).is_file()
    assert client.get("/api/files", params={"root": "Media", "recursive": 1}).json()["total"] == 0

    # same name deleted again must not clobber what's already in the trash
    (media / "top.jpg").write_bytes(b"take2")
    client.post("/api/scan/Media")
    client.app.state.scanner.wait("Media")
    again = client.post("/api/files/delete", json={"root": "Media", "paths": ["top.jpg"]}).json()
    trashed = [p for p in (media / ".refdeck-trash").rglob("*") if p.is_file()]
    assert len(trashed) == 3
    assert (media / ".refdeck-trash" / again["deleted"][0]["trash"]).read_bytes() == b"take2"


def test_delete_undo_restores_files_and_index(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    deleted = client.post("/api/files/delete",
                          json={"root": "Media", "paths": ["top.jpg", "sub/nested.png"]}).json()["deleted"]
    resp = client.post("/api/files/restore", json={"root": "Media", "items": deleted})
    assert resp.status_code == 200
    body = resp.json()
    assert sorted(body["restored"]) == ["sub/nested.png", "top.jpg"]
    assert body["errors"] == {}
    assert (media / "top.jpg").read_bytes() == b"fake"
    assert (media / "sub" / "nested.png").is_file()
    assert client.get("/api/files", params={"root": "Media", "recursive": 1}).json()["total"] == 2
    assert not any(p.is_file() for p in (media / ".refdeck-trash").rglob("*"))


def test_delete_and_restore_directory(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    body = client.post("/api/files/delete", json={"root": "Media", "paths": ["sub"]}).json()
    assert [d["path"] for d in body["deleted"]] == ["sub"]
    assert body["errors"] == {}
    assert not (media / "sub").exists()
    assert client.get("/api/files", params={"root": "Media", "recursive": 1}).json()["total"] == 1
    assert client.get("/api/browse", params={"root": "Media", "path": ""}).json()["dirs"] == []

    resp = client.post("/api/files/restore", json={"root": "Media", "items": body["deleted"]}).json()
    assert resp["restored"] == ["sub"] and resp["errors"] == {}
    assert (media / "sub" / "nested.png").read_bytes() == b"fake"
    files = client.get("/api/files", params={"root": "Media", "recursive": 1}).json()
    assert files["total"] == 2
    assert {f["dir"] for f in files["files"]} == {"", "sub"}


def test_delete_refuses_root_and_hidden(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    (media / ".stuff").mkdir()
    body = client.post("/api/files/delete",
                       json={"root": "Media", "paths": ["", ".", ".stuff"]}).json()
    assert body["deleted"] == []
    assert len(body["errors"]) == 3
    assert (media / ".stuff").is_dir()


def test_restore_guards_traversal_and_missing(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    body = client.post("/api/files/restore", json={"root": "Media", "items": [
        {"path": "x.jpg", "trash": "../../evil.jpg"},
        {"path": "y.jpg", "trash": "12345/y.jpg"},
    ]}).json()
    assert body["restored"] == []
    assert set(body["errors"]) == {"x.jpg", "y.jpg"}


def test_stale_trash_batches_purged_on_delete(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    old = media / ".refdeck-trash" / "1000"  # epoch-ms batch from long ago
    old.mkdir(parents=True)
    (old / "old.jpg").write_bytes(b"x")
    fresh = client.post("/api/files/delete", json={"root": "Media", "paths": ["top.jpg"]}).json()
    assert not old.exists()
    assert (media / ".refdeck-trash" / fresh["deleted"][0]["trash"]).is_file()


def test_trash_emptied_on_startup(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    (media / ".refdeck-trash" / "999").mkdir(parents=True)
    (media / ".refdeck-trash" / "999" / "gone.jpg").write_bytes(b"x")
    monkeypatch.setenv("REFDECK_ROOTS", f"Media={media}")
    monkeypatch.setenv("REFDECK_DATA_DIR", str(tmp_path / "data"))
    with TestClient(create_app()):  # context manager runs startup events
        pass
    assert not (media / ".refdeck-trash").exists()


def test_delete_guards_bad_root_traversal_and_missing(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch)
    assert client.post("/api/files/delete",
                       json={"root": "Nope", "paths": ["x.jpg"]}).status_code == 400
    body = client.post("/api/files/delete",
                       json={"root": "Media", "paths": ["../evil.jpg", "ghost.jpg", "top.jpg"]}).json()
    assert [d["path"] for d in body["deleted"]] == ["top.jpg"]
    assert set(body["errors"]) == {"../evil.jpg", "ghost.jpg"}
    assert (media / "sub" / "nested.png").exists()  # untouched


def test_insp_indexed_and_served_as_full_res_jpeg(tmp_path, monkeypatch):
    # Insta360 .insp panoramas are JPEG bytes under another name; they must be
    # indexed as images and served untouched (full res, explicit image/jpeg)
    # so the 360 viewer isn't fed a 2048px converted preview.
    client, media = make_client(tmp_path, monkeypatch)
    (media / "pano.insp").write_bytes(b"\xff\xd8fakejpeg")
    client.post("/api/scan/Media")
    client.app.state.scanner.wait("Media")
    files = client.get("/api/files", params={"root": "Media", "recursive": 1, "type": "image"}).json()
    assert "pano.insp" in [f["name"] for f in files["files"]]
    for endpoint in ("/api/preview", "/api/media"):
        resp = client.get(endpoint, params={"root": "Media", "path": "pano.insp"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/jpeg"
        assert resp.content == b"\xff\xd8fakejpeg"
