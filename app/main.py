from __future__ import annotations

import html
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .auth import COOKIE, SESSION_TTL, Auth
from .db import RefDeckDB
from .depth import generate_depth_map
from .indexer import ScanManager, walk_media
from .media import MediaRoots, classify_media
from .mounts import MountError, MountManager
from .thumbs import (MIME_OVERRIDES, drop_cached, make_preview, make_thumb,
                     needs_conversion, sweep_cache)


class CollectionIn(BaseModel):
    title: str


class CollectionItemIn(BaseModel):
    path: str
    media_type: str


class BoardIn(BaseModel):
    id: int | None = None
    title: str
    document: dict


class DeleteIn(BaseModel):
    root: str
    paths: list[str]


class HiddenIn(BaseModel):
    root: str
    paths: list[str]
    hidden: bool


class MoveIn(BaseModel):
    root: str
    paths: list[str]
    dest_root: str
    dest_dir: str = ""


class RestoreItem(BaseModel):
    path: str
    trash: str


class RestoreIn(BaseModel):
    root: str
    items: list[RestoreItem]


TRASH_DIR = ".refdeck-trash"
TRASH_TTL_SECONDS = 3600


def purge_trash(base: Path, ttl: float = 0) -> None:
    """Drop trash batches older than ttl seconds (ttl<=0: everything).

    Deletes are permanent from the user's point of view; the trash only
    exists to back the undo window."""
    trash = base / TRASH_DIR
    if not trash.is_dir():
        return
    if ttl <= 0:
        shutil.rmtree(trash, ignore_errors=True)
        return
    cutoff_ms = (time.time() - ttl) * 1000
    for batch in trash.iterdir():
        try:
            if batch.is_dir() and float(batch.name) < cutoff_ms:
                shutil.rmtree(batch, ignore_errors=True)
        except ValueError:
            continue


class MountIn(BaseModel):
    name: str
    server: str
    share: str
    subpath: str = ""
    username: str = ""
    password: str = ""


def parse_roots() -> dict[str, Path]:
    raw = os.environ.get("REFDECK_ROOTS", "")
    roots = {}
    for part in raw.split(";"):
        if not part.strip():
            continue
        name, path = part.split("=", 1)
        roots[name.strip()] = Path(path)
    return roots


def data_dir() -> Path:
    return Path(os.environ.get("REFDECK_DATA_DIR", str(Path.cwd() / "data")))


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    return default if not raw else raw not in ("0", "false", "no", "off")


THEMES = ("light", "dark", "auto")

# reachable without a session: the login page and what a home-screen icon needs
PUBLIC_PATHS = {"/login", "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png"}
UPLOAD_CHUNK = 1024 * 1024


def create_app(mount_runner=None) -> FastAPI:
    app = FastAPI(title="RefDeck")
    roots = MediaRoots(parse_roots())
    data = data_dir()
    cache = data / "thumbs"
    depth_dir = data / "depth"
    depth_dir.mkdir(parents=True, exist_ok=True)
    db = RefDeckDB(data / "refdeck.db")
    db.init([(s["name"], s["path"]) for s in roots.status()])
    scanner = ScanManager(roots, db, thumb_fn=lambda p: make_thumb(p, cache))
    mount_base = Path(os.environ.get("REFDECK_MOUNT_BASE", "/mnt/refdeck"))
    mounts = MountManager(db, roots, scanner, base=mount_base,
                          runner=mount_runner or subprocess.run)

    app.state.roots = roots
    app.state.db = db
    app.state.cache = cache
    app.state.scanner = scanner
    app.state.mounts = mounts

    # per-instance switches — defaults are the private LAN instance, unchanged
    auth = Auth.from_env()
    brand = os.environ.get("REFDECK_BRAND", "").strip()
    theme = os.environ.get("REFDECK_THEME", "dark").strip().lower()
    theme = theme if theme in THEMES else "dark"
    allow_upload = env_flag("REFDECK_ALLOW_UPLOAD", False)
    allow_delete = env_flag("REFDECK_ALLOW_DELETE", True)
    allow_mounts = env_flag("REFDECK_ALLOW_MOUNTS", True)
    upload_max = int(float(os.environ.get("REFDECK_UPLOAD_MAX_MB", "2048")) * 1024 * 1024)
    app.state.auth = auth
    static = Path(__file__).parent / "static"

    def require(flag: bool, what: str) -> None:
        if not flag:
            raise HTTPException(status_code=403, detail=f"{what} is turned off on this RefDeck")

    if auth:
        @app.middleware("http")
        async def require_login(request: Request, call_next):
            if request.url.path in PUBLIC_PATHS or auth.valid(request.cookies.get(COOKIE)):
                return await call_next(request)
            if request.url.path.startswith("/api/"):
                return JSONResponse({"detail": "login required"}, status_code=401)
            return RedirectResponse("/login", status_code=303)

    def client_key(request: Request) -> str:
        # the last X-Forwarded-For hop is the one our own proxy appended
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[-1].strip()
        return request.client.host if request.client else "?"

    def login_page(error: str = "", status: int = 200) -> HTMLResponse:
        page = (static / "login.html").read_text()
        page = page.replace("{{brand}}", html.escape(brand or "RefDeck"))
        page = page.replace("{{theme}}", theme)
        page = page.replace("{{error}}", html.escape(error))
        return HTMLResponse(page, status_code=status)

    @app.get("/login")
    def get_login(request: Request):
        if not auth or auth.valid(request.cookies.get(COOKIE)):
            return RedirectResponse("/", status_code=303)
        return login_page()

    @app.post("/login")
    def post_login(request: Request, username: str = Form(""), password: str = Form("")):
        if not auth:
            return RedirectResponse("/", status_code=303)
        client = client_key(request)
        wait = auth.retry_after(client)
        if wait:
            response = login_page(f"Too many tries — wait {wait} seconds and try again.", 429)
            response.headers["Retry-After"] = str(wait)
            return response
        if not auth.attempt(client, username, password):
            return login_page("That username or password didn't match.", 401)
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(COOKIE, auth.issue(), max_age=SESSION_TTL, httponly=True,
                            secure=auth.secure_cookie, samesite="lax")
        return response

    @app.post("/logout")
    def post_logout():
        response = RedirectResponse("/login" if auth else "/", status_code=303)
        response.delete_cookie(COOKIE)
        return response

    @app.get("/api/config")
    def api_config():
        return {"brand": brand, "auth": bool(auth), "upload": allow_upload,
                "delete": allow_delete, "mounts": allow_mounts, "theme": theme}

    # the instance's default theme goes into the page itself, so the first
    # paint is already the right colours (a stored per-device choice still wins)
    @app.get("/")
    @app.get("/index.html")
    def index_page():
        page = (static / "index.html").read_text().replace("{{theme}}", theme)
        return HTMLResponse(page, headers={"Cache-Control": "no-cache"})

    @app.on_event("startup")
    def startup():
        # snapshot BEFORE anything can touch the DB — boards/collections/
        # hidden-flags have no other safety net, and a scan against a broken
        # mount once pruned a root's whole index at startup
        try:
            db.backup(data / "backups")
        except Exception:
            pass  # a backup failure must never block startup
        mounts.restore_all()
        for base in roots.roots.values():
            try:
                if Path(base).is_dir():
                    purge_trash(Path(base))  # undo doesn't survive a restart; deletes are final
            except OSError:
                pass  # dead network mount — nothing to purge
        # a failed mount is a bare empty dir; scanning it is at best useless
        for name in roots.roots:
            if name not in mounts.errors:
                scanner.start(name)
        def daily_maintenance():  # long-running containers still get dailies
            while True:
                try:
                    sweep_cache(cache)  # thumbs unused for 90d = orphans
                except Exception:
                    pass
                time.sleep(24 * 3600)
                try:
                    db.backup(data / "backups")
                except Exception:
                    pass
        threading.Thread(target=daily_maintenance, daemon=True).start()

        def mount_watch():  # dead drives grey out; returning ones self-restore
            while True:
                time.sleep(60)
                try:
                    for name in mounts.check_health():
                        scanner.start(name, quick=True)
                except Exception:
                    pass
        threading.Thread(target=mount_watch, daemon=True).start()

    @app.get("/api/roots")
    def api_roots():
        # a failed mount leaves an is_dir()-able empty dir — mount errors win
        return [s | {"media_count": db.media_count(s["name"]),
                     "online": s["online"] and s["name"] not in mounts.errors}
                for s in roots.status()]

    @app.get("/api/browse")
    def api_browse(root: str = Query(...), path: str = ""):
        try:
            listing = roots.list_dirs(root, path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        listing["media_count"] = db.media_count(root, path)
        return listing

    @app.get("/api/files")
    def api_files(root: str, path: str = "", recursive: int = 0, query: str = "",
                  sort: str = "name", limit: int = 200, offset: int = 0,
                  type: str = "", exts: str = "", hidden: int = 0, direction: str = ""):
        if root not in roots.roots:
            raise HTTPException(status_code=400, detail=f"unknown root: {root}")
        ext_list = [e.strip().lstrip(".").lower() for e in exts.split(",") if e.strip()]
        # hidden: 0 = exclude hidden files, 1 = include them, 2 = only hidden
        return db.query_files(root, dir=path, recursive=bool(recursive), query=query,
                              sort=sort, limit=min(limit, 500), offset=max(offset, 0),
                              media_type=type, exts=ext_list,
                              include_hidden=hidden == 1, only_hidden=hidden == 2,
                              direction=direction)

    @app.post("/api/files/hidden")
    def api_set_hidden(payload: HiddenIn):
        if payload.root not in roots.roots:
            raise HTTPException(status_code=400, detail=f"unknown root: {payload.root}")
        return {"updated": db.set_hidden(payload.root, payload.paths, payload.hidden),
                "hidden": payload.hidden}

    @app.post("/api/scan/{root}")
    def api_scan(root: str, quick: bool = False):
        if root not in roots.roots:
            raise HTTPException(status_code=400, detail=f"unknown root: {root}")
        if root in mounts.errors and not mounts.retry(root):
            return {"started": False, "offline": True}
        return {"started": scanner.start(root, quick=quick)}

    @app.get("/api/scan/status")
    def api_scan_status():
        return scanner.status()

    def resolve_file(root: str, path: str) -> Path:
        try:
            target = roots.resolve(root, path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not target.is_file():
            raise HTTPException(status_code=404, detail=f"file not found: {path}")
        return target

    @app.get("/api/media")
    def api_media(root: str, path: str):
        target = resolve_file(root, path)
        return FileResponse(target, media_type=MIME_OVERRIDES.get(target.suffix.lower()))

    @app.post("/api/files/delete")
    def api_delete_files(payload: DeleteIn):
        require(allow_delete, "deleting")
        if payload.root not in roots.roots:
            raise HTTPException(status_code=400, detail=f"unknown root: {payload.root}")
        # files land in a timestamped trash batch (invisible to the indexer)
        # purely to back ⌘Z; batches are purged after TRASH_TTL_SECONDS
        root_base = Path(roots.roots[payload.root])
        trash = root_base / TRASH_DIR
        batch_dir = trash / str(int(time.time() * 1000))
        deleted: list[dict] = []
        errors: dict[str, str] = {}
        deleted_files: list[str] = []
        for rel in payload.paths:
            try:
                target = roots.resolve(payload.root, rel)
                if target == roots.resolve(payload.root):
                    raise ValueError("cannot delete the drive root")
                if target.name.startswith("."):
                    raise ValueError("hidden files are not managed by RefDeck")
                is_dir = target.is_dir()
                if not is_dir and not target.is_file():
                    raise ValueError("file not found")
                if not is_dir:
                    # privacy: a deleted file's thumbnails go with it, now —
                    # key needs the stat, so this must precede the move
                    drop_cached(target, cache)
                dest = batch_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                base, n = dest, 1
                while dest.exists():
                    dest = base.with_name(f"{base.stem}-{n}{base.suffix}")
                    n += 1
                shutil.move(str(target), str(dest))
                deleted.append({"path": rel, "trash": dest.relative_to(trash).as_posix()})
                if is_dir:
                    db.remove_dir_files(payload.root, rel)
                else:
                    deleted_files.append(rel)
            except (ValueError, OSError) as exc:
                errors[rel] = str(exc)
        if deleted_files:
            db.remove_files(payload.root, deleted_files)
        purge_trash(root_base, TRASH_TTL_SECONDS)
        return {"deleted": deleted, "errors": errors}

    @app.post("/api/files/move")
    def api_move_files(payload: MoveIn):
        require(allow_delete, "moving files")
        for r in (payload.root, payload.dest_root):
            if r not in roots.roots:
                raise HTTPException(status_code=400, detail=f"unknown root: {r}")
        try:
            dest_base = roots.resolve(payload.dest_root, payload.dest_dir)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        was_hidden = db.hidden_paths(payload.root, payload.paths)
        moved: list[dict] = []
        errors: dict[str, str] = {}
        entries: list[dict] = []
        removed: list[str] = []
        renames: dict[str, str] = {}
        hidden_dest: list[str] = []
        for rel in payload.paths:
            try:
                target = roots.resolve(payload.root, rel)
                if not target.is_file():
                    raise ValueError("file not found")
                dest = dest_base / target.name
                if dest == target:
                    raise ValueError("already there")
                dest_base.mkdir(parents=True, exist_ok=True)
                base, n = dest, 1
                while dest.exists():
                    dest = base.with_name(f"{base.stem}-{n}{base.suffix}")
                    n += 1
                shutil.move(str(target), str(dest))
                new_rel = dest.relative_to(roots.resolve(payload.dest_root)).as_posix()
                stat = dest.stat()
                entries.append({
                    "path": new_rel,
                    "name": dest.name,
                    "dir": new_rel.rsplit("/", 1)[0] if "/" in new_rel else "",
                    "media_type": classify_media(dest) or "",
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                })
                removed.append(rel)
                renames[f"{payload.root}/{rel}"] = f"{payload.dest_root}/{new_rel}"
                if rel in was_hidden:
                    hidden_dest.append(new_rel)
                moved.append({"path": rel, "to": new_rel})
            except (ValueError, OSError) as exc:
                errors[rel] = str(exc)
        if removed:
            db.remove_files(payload.root, removed)
            # durable hidden marks follow the file: drop at source, set at dest
            gone_hidden = [r for r in removed if r in was_hidden]
            if gone_hidden:
                db.set_hidden(payload.root, gone_hidden, False)
        media_entries = [e for e in entries if e["media_type"]]
        if media_entries:
            db.upsert_files(payload.dest_root, media_entries)
        if hidden_dest:
            db.set_hidden(payload.dest_root, hidden_dest, True)
        if renames:
            db.rewrite_collection_paths(renames)  # collections must follow moved files
        return {"moved": moved, "errors": errors}

    @app.post("/api/files/restore")
    def api_restore_files(payload: RestoreIn):
        require(allow_delete, "restoring")
        if payload.root not in roots.roots:
            raise HTTPException(status_code=400, detail=f"unknown root: {payload.root}")
        root_base = Path(roots.roots[payload.root])
        trash = (root_base / TRASH_DIR).resolve()
        restored: list[str] = []
        errors: dict[str, str] = {}
        entries: list[dict] = []
        for it in payload.items:
            try:
                src = (trash / it.trash).resolve()
                if trash not in src.parents:
                    raise ValueError(f"trash path escapes trash: {it.trash}")
                if not src.exists():
                    raise ValueError("no longer in trash")
                dest = roots.resolve(payload.root, it.path)
                if dest.exists():
                    raise ValueError("a file already exists there")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dest))
                if dest.is_dir():
                    for e in walk_media(dest):
                        entries.append(e | {
                            "path": f"{it.path}/{e['path']}",
                            "dir": f"{it.path}/{e['dir']}" if e["dir"] else it.path,
                        })
                else:
                    stat = dest.stat()
                    entries.append({
                        "path": it.path,
                        "name": it.path.split("/")[-1],
                        "dir": it.path.rsplit("/", 1)[0] if "/" in it.path else "",
                        "media_type": classify_media(dest) or "",
                        "size": stat.st_size,
                        "mtime": int(stat.st_mtime),
                    })
                restored.append(it.path)
            except (ValueError, OSError) as exc:
                errors[it.path] = str(exc)
        media_entries = [e for e in entries if e["media_type"]]
        if media_entries:
            db.upsert_files(payload.root, media_entries)
        if trash.is_dir():  # drop batch dirs that are now empty shells
            for b in list(trash.iterdir()):
                if b.is_dir() and not any(p.is_file() for p in b.rglob("*")):
                    shutil.rmtree(b, ignore_errors=True)
        return {"restored": restored, "errors": errors}

    @app.post("/api/upload")
    def api_upload(root: str, path: str = "", files: list[UploadFile] = File(...)):
        require(allow_upload, "uploading")
        try:
            dest_dir = roots.resolve(root, path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not dest_dir.is_dir():
            raise HTTPException(status_code=400, detail=f"not a folder: {path}")
        base = roots.resolve(root)
        uploaded: list[str] = []
        errors: dict[str, str] = {}
        entries: list[dict] = []
        for upload in files:
            name = Path(upload.filename or "").name.strip()
            tmp = None
            try:
                if not name or name.startswith("."):
                    raise ValueError("unusable file name")
                if not classify_media(Path(name)):
                    raise ValueError("only photos and videos can be uploaded")
                dest = dest_dir / name
                stem, n = dest, 1
                while dest.exists():
                    dest = stem.with_name(f"{stem.stem}-{n}{stem.suffix}")
                    n += 1
                # dot-prefixed while in flight: the indexer skips it, and a
                # failed upload never leaves a half-file under the real name
                tmp = dest.with_name(f".{dest.name}.uploading")
                size = 0
                with open(tmp, "xb") as out:
                    while chunk := upload.file.read(UPLOAD_CHUNK):
                        size += len(chunk)
                        if size > upload_max:
                            raise ValueError(f"larger than the {upload_max // (1024 * 1024)} MB limit")
                        out.write(chunk)
                os.replace(tmp, dest)
                tmp = None
                rel = dest.relative_to(base).as_posix()
                stat = dest.stat()
                entries.append({
                    "path": rel,
                    "name": dest.name,
                    "dir": rel.rsplit("/", 1)[0] if "/" in rel else "",
                    "media_type": classify_media(dest),
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                })
                uploaded.append(rel)
            except (ValueError, OSError) as exc:
                errors[name or "(unnamed)"] = str(exc)
            finally:
                if tmp is not None:
                    tmp.unlink(missing_ok=True)
        if entries:
            db.upsert_files(root, entries)  # visible now — no rescan needed
        return {"uploaded": uploaded, "errors": errors}

    @app.get("/api/thumb")
    def api_thumb(root: str, path: str):
        return FileResponse(make_thumb(resolve_file(root, path), cache))

    @app.get("/api/depth")
    def api_depth(root: str, path: str):
        target = resolve_file(root, path)
        if classify_media(target) != "image":
            raise HTTPException(status_code=400, detail="depth maps are generated for images only")
        try:
            out = generate_depth_map(target, depth_dir, data / "models")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"depth generation failed: {exc}") from exc
        return FileResponse(out, media_type="image/png", headers={"X-Depth-Name": out.name})

    @app.get("/api/preview")
    def api_preview(root: str, path: str):
        target = resolve_file(root, path)
        if classify_media(target) == "video" or not needs_conversion(target):
            return FileResponse(target, media_type=MIME_OVERRIDES.get(target.suffix.lower()))
        try:
            return FileResponse(make_preview(target, cache), media_type="image/jpeg")
        except Exception as exc:
            raise HTTPException(status_code=415, detail=f"cannot preview: {exc}") from exc

    @app.get("/api/mounts")
    def api_mounts():
        return mounts.listing()

    @app.post("/api/mounts")
    def api_add_mount(payload: MountIn):
        require(allow_mounts, "mounting shares")
        try:
            return mounts.add(payload.name.strip(), payload.server.strip(), payload.share.strip(),
                              payload.subpath.strip(), payload.username, payload.password)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except MountError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.delete("/api/mounts/{mount_id}")
    def api_remove_mount(mount_id: int):
        require(allow_mounts, "mounting shares")
        try:
            mounts.remove(mount_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="mount not found") from exc
        return {"ok": True}

    @app.get("/api/collections")
    def api_collections():
        return db.collections()

    @app.post("/api/collections")
    def api_create_collection(payload: CollectionIn):
        return db.create_collection(payload.title.strip() or "Untitled")

    @app.delete("/api/collections/{collection_id}")
    def api_delete_collection(collection_id: int):
        db.delete_collection(collection_id)
        return {"ok": True}

    @app.post("/api/collections/{collection_id}/items")
    def api_add_collection_item(collection_id: int, payload: CollectionItemIn):
        return db.add_collection_item(collection_id, payload.path, payload.media_type)

    @app.delete("/api/collections/items/{item_id}")
    def api_remove_collection_item(item_id: int):
        db.remove_collection_item(item_id)
        return {"ok": True}

    @app.post("/api/collections/{collection_id}/hidden")
    def api_toggle_collection_hidden(collection_id: int):
        col = next((c for c in db.collections() if c["id"] == collection_id), None)
        if col is None:
            raise HTTPException(status_code=404, detail="collection not found")
        by_root: dict[str, list[str]] = {}
        for it in col["items"]:
            r, _, rel = it["path"].partition("/")
            if r in roots.roots and rel:
                by_root.setdefault(r, []).append(rel)
        matched = already_hidden = 0
        for r, paths in by_root.items():
            m, hid = db.count_hidden(r, paths)
            matched += m
            already_hidden += hid
        # toggle: hide, unless every indexed member is already hidden
        target = not (matched > 0 and already_hidden == matched)
        updated = sum(db.set_hidden(r, paths, target) for r, paths in by_root.items())
        return {"hidden": target, "updated": updated}

    @app.get("/api/boards")
    def api_boards():
        return db.boards()

    @app.get("/api/boards/{board_id}")
    def api_board(board_id: int):
        try:
            return db.board(board_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="board not found") from exc

    @app.post("/api/boards")
    def api_save_board(payload: BoardIn):
        return db.save_board(payload.id, payload.title.strip() or "Untitled", payload.document)

    @app.delete("/api/boards/{board_id}")
    def api_delete_board(board_id: int):
        db.delete_board(board_id)
        return {"ok": True}

    app.mount("/", StaticFiles(directory=static, html=True), name="static")
    return app


app = create_app()
