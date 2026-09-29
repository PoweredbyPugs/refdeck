import io

from fastapi.testclient import TestClient
from PIL import Image

from app import auth as auth_mod
from app.auth import Auth, hash_password, verify_password
from app.main import create_app

PASSWORD = "correct horse 42"


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 6), (200, 40, 90)).save(buf, "PNG")
    return buf.getvalue()


def make_client(tmp_path, monkeypatch, **env):
    media = tmp_path / "media"
    (media / "sub").mkdir(parents=True)
    (media / "top.jpg").write_bytes(b"fake")
    monkeypatch.setenv("REFDECK_ROOTS", f"Media={media}")
    monkeypatch.setenv("REFDECK_DATA_DIR", str(tmp_path / "data"))
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    app = create_app()
    app.state.scanner.start("Media")
    app.state.scanner.wait("Media")
    return TestClient(app), media


def auth_env(**extra):
    return {"REFDECK_AUTH_USER": "ava", "REFDECK_AUTH_HASH": hash_password(PASSWORD),
            "REFDECK_SECRET": "test-secret", "REFDECK_COOKIE_SECURE": "0",
            "REFDECK_BRAND": "Studio <One>", **extra}


def login(client, username="ava", password=PASSWORD):
    return client.post("/login", data={"username": username, "password": password},
                       follow_redirects=False)


# ---------- password hashing ----------

def test_hash_roundtrip_and_rejects():
    stored = hash_password(PASSWORD)
    assert "$" not in stored  # docker compose would interpolate it out of .env
    assert verify_password(PASSWORD, stored)
    assert not verify_password("wrong", stored)
    assert not verify_password(PASSWORD, "garbage")
    assert not verify_password(PASSWORD, "md5:00:00")


def test_session_token_tamper_and_expiry():
    now = [1_000_000.0]
    a = Auth("ava", hash_password(PASSWORD), "s", clock=lambda: now[0])
    token = a.issue()
    assert a.valid(token)
    assert not a.valid(token[:-1] + ("0" if token[-1] != "0" else "1"))
    assert not a.valid("")
    assert not a.valid("nonsense")
    # a different password hash invalidates every session
    assert not Auth("ava", hash_password("other"), "s", clock=lambda: now[0]).valid(token)
    now[0] += auth_mod.SESSION_TTL + 1
    assert not a.valid(token)


# ---------- login flow ----------

def test_auth_off_by_default(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch)
    assert client.get("/api/roots").status_code == 200
    assert client.get("/login", follow_redirects=False).status_code == 303
    config = client.get("/api/config").json()
    assert config == {"brand": "", "auth": False, "upload": False, "delete": True,
                      "mounts": True, "theme": "dark"}


def test_everything_locked_until_login(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, **auth_env())
    assert client.get("/api/roots").status_code == 401
    assert client.get("/api/media", params={"root": "Media", "path": "top.jpg"}).status_code == 401
    assert client.get("/app.js", follow_redirects=False).status_code == 303
    home = client.get("/", follow_redirects=False)
    assert home.status_code == 303 and home.headers["location"] == "/login"
    page = client.get("/login")
    assert page.status_code == 200
    assert "Studio &lt;One&gt;" in page.text and "<One>" not in page.text  # brand is escaped
    assert client.get("/apple-touch-icon.png").status_code == 200  # home-screen icon stays public


def test_login_logout(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, **auth_env())
    assert login(client, password="nope").status_code == 401
    assert login(client, username="someone").status_code == 401
    res = login(client, username=" AVA ")  # phones capitalise and pad usernames
    assert res.status_code == 303 and res.headers["location"] == "/"
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "max-age=2592000" in cookie
    assert client.get("/api/roots").status_code == 200
    assert client.get("/api/config").json()["auth"] is True
    client.post("/logout", follow_redirects=False)
    assert client.get("/api/roots").status_code == 401


def test_secure_cookie_by_default(tmp_path, monkeypatch):
    env = auth_env()
    del env["REFDECK_COOKIE_SECURE"]
    client, _ = make_client(tmp_path, monkeypatch, **env)
    assert "secure" in login(client).headers["set-cookie"].lower()


def test_forged_cookie_rejected(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, **auth_env())
    client.cookies.set("refdeck_session", "9999999999.deadbeef")
    assert client.get("/api/roots").status_code == 401


def test_login_throttle(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, **auth_env())
    for _ in range(auth_mod.FREE_FAILURES):
        assert login(client, password="bad").status_code == 401
    locked = login(client)  # even the right password waits out the backoff
    assert locked.status_code == 429 and int(locked.headers["retry-after"]) > 0
    # throttle is per client: a different forwarded address is unaffected
    other = client.post("/login", data={"username": "ava", "password": PASSWORD},
                        headers={"X-Forwarded-For": "203.0.113.9"}, follow_redirects=False)
    assert other.status_code == 303


# ---------- uploads ----------

def upload(client, files, path="", root="Media"):
    return client.post("/api/upload", params={"root": root, "path": path}, files=files)


def test_upload_off_by_default(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch)
    assert upload(client, [("files", ("a.png", png_bytes(), "image/png"))]).status_code == 403


def test_upload_lands_and_is_indexed(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch, REFDECK_ALLOW_UPLOAD="1")
    res = upload(client, [("files", ("look.png", png_bytes(), "image/png")),
                          ("files", ("look.png", png_bytes(), "image/png")),
                          ("files", ("notes.txt", b"hi", "text/plain")),
                          ("files", (".sneaky.png", png_bytes(), "image/png"))], path="sub")
    body = res.json()
    assert res.status_code == 200
    assert body["uploaded"] == ["sub/look.png", "sub/look-1.png"]  # never overwrites
    assert set(body["errors"]) == {"notes.txt", ".sneaky.png"}
    assert (media / "sub" / "look.png").read_bytes() == png_bytes()
    assert not list((media / "sub").glob(".*uploading"))
    listed = client.get("/api/files", params={"root": "Media", "path": "sub"}).json()
    names = {f["name"] for f in (listed["files"] if isinstance(listed, dict) else listed)}
    assert {"look.png", "look-1.png"} <= names


def test_upload_strips_directories_from_names(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch, REFDECK_ALLOW_UPLOAD="1")
    res = upload(client, [("files", ("../../evil.png", png_bytes(), "image/png"))])
    assert res.json()["uploaded"] == ["evil.png"]
    assert (media / "evil.png").exists() and not (tmp_path / "evil.png").exists()


def test_upload_rejects_escaping_folder(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, REFDECK_ALLOW_UPLOAD="1")
    assert upload(client, [("files", ("a.png", png_bytes(), "image/png"))], path="../").status_code == 400
    assert upload(client, [("files", ("a.png", png_bytes(), "image/png"))], path="missing").status_code == 400


def test_upload_size_cap_leaves_nothing_behind(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch, REFDECK_ALLOW_UPLOAD="1",
                                REFDECK_UPLOAD_MAX_MB="0.00005")  # ~52 bytes
    res = upload(client, [("files", ("big.png", png_bytes(), "image/png"))])
    assert res.json()["uploaded"] == [] and "big.png" in res.json()["errors"]
    assert not (media / "big.png").exists()
    assert not list(media.glob(".*"))


def test_upload_requires_login_when_auth_on(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, **auth_env(REFDECK_ALLOW_UPLOAD="1"))
    assert upload(client, [("files", ("a.png", png_bytes(), "image/png"))]).status_code == 401
    login(client)
    assert upload(client, [("files", ("a.png", png_bytes(), "image/png"))]).json()["uploaded"] == ["a.png"]


# ---------- permission switches ----------

def test_delete_move_restore_off(tmp_path, monkeypatch):
    client, media = make_client(tmp_path, monkeypatch, REFDECK_ALLOW_DELETE="0")
    assert client.post("/api/files/delete", json={"root": "Media", "paths": ["top.jpg"]}).status_code == 403
    assert client.post("/api/files/move", json={"root": "Media", "paths": ["top.jpg"],
                                                "dest_root": "Media", "dest_dir": "sub"}).status_code == 403
    assert client.post("/api/files/restore", json={"root": "Media", "items": []}).status_code == 403
    assert (media / "top.jpg").exists()
    assert client.get("/api/config").json()["delete"] is False


def test_mounts_off(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, REFDECK_ALLOW_MOUNTS="0")
    res = client.post("/api/mounts", json={"name": "X", "server": "h", "share": "s"})
    assert res.status_code == 403
    assert client.delete("/api/mounts/1").status_code == 403


# ---------- theme ----------

def test_theme_default_injected(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, REFDECK_THEME="light")
    assert client.get("/api/config").json()["theme"] == "light"
    assert 'data-default-theme="light"' in client.get("/").text
    assert "{{theme}}" not in client.get("/index.html").text


def test_theme_rejects_junk(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, REFDECK_THEME="<script>")
    assert client.get("/api/config").json()["theme"] == "dark"
    assert 'data-default-theme="dark"' in client.get("/").text


def test_login_page_gets_theme(tmp_path, monkeypatch):
    client, _ = make_client(tmp_path, monkeypatch, **auth_env(REFDECK_THEME="light"))
    assert 'data-default-theme="light"' in client.get("/login").text
    assert client.get("/", follow_redirects=False).status_code == 303  # index still behind login
