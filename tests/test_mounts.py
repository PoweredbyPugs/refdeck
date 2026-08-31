from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.main import create_app


class FakeRunner:
    def __init__(self, returncode=0, stderr=""):
        self.calls = []
        self.returncode = returncode
        self.stderr = stderr

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        return SimpleNamespace(returncode=self.returncode, stdout="", stderr=self.stderr)


def make_client(tmp_path, monkeypatch, runner):
    media = tmp_path / "media"
    media.mkdir()
    monkeypatch.setenv("REFDECK_ROOTS", f"Media={media}")
    monkeypatch.setenv("REFDECK_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("REFDECK_MOUNT_BASE", str(tmp_path / "mnt"))
    return TestClient(create_app(mount_runner=runner))


def test_add_list_remove_mount(tmp_path, monkeypatch):
    runner = FakeRunner()
    client = make_client(tmp_path, monkeypatch, runner)
    created = client.post("/api/mounts", json={
        "name": "NAS", "server": "othermac.local", "share": "Art",
        "username": "cj", "password": "secret"}).json()
    assert created["name"] == "NAS" and "password" not in created
    assert runner.calls[0][:3] == ["mount", "-t", "cifs"]
    assert "//othermac.local/Art" in runner.calls[0]
    assert any(r["name"] == "NAS" for r in client.get("/api/roots").json())
    listed = client.get("/api/mounts").json()
    assert listed[0]["online"] is True and "password" not in listed[0]

    mount_id = created["id"]
    assert client.delete(f"/api/mounts/{mount_id}").json() == {"ok": True}
    assert client.get("/api/mounts").json() == []
    assert not any(r["name"] == "NAS" for r in client.get("/api/roots").json())


def test_mount_failure_surfaces_stderr(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch,
                         FakeRunner(returncode=32, stderr="mount error(13): Permission denied"))
    resp = client.post("/api/mounts", json={"name": "Bad", "server": "x", "share": "y"})
    assert resp.status_code == 502
    assert "Permission denied" in resp.json()["detail"]
    assert client.get("/api/mounts").json() == []


def test_bad_mount_name_rejected(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch, FakeRunner())
    resp = client.post("/api/mounts", json={"name": "../evil", "server": "x", "share": "y"})
    assert resp.status_code == 400
