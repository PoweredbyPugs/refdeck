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
