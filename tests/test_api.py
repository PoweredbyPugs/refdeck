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
    roots = client.get("/api/roots").json()
    assert roots == [{"name": "Media", "path": str(tmp_path / "media"),
                      "online": True, "media_count": 2}]


def test_missing_root_is_offline_not_home(tmp_path, monkeypatch):
    monkeypatch.setenv("REFDECK_ROOTS", f"Gone={tmp_path / 'nope'}")
    monkeypatch.setenv("REFDECK_DATA_DIR", str(tmp_path / "data"))
    roots = TestClient(create_app()).get("/api/roots").json()
    assert roots[0]["name"] == "Gone" and roots[0]["online"] is False


def test_browse_dirs_only_with_recursive_count(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch)
    listing = client.get("/api/browse", params={"root": "Media", "path": ""}).json()
    assert listing["dirs"] == [{"name": "sub", "path": "sub"}]
    assert "files" not in listing
    assert listing["media_count"] == 2
    assert client.get("/api/browse", params={"root": "Media", "path": "../"}).status_code == 400


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
