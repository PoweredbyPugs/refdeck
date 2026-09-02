from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .db import RefDeckDB
from .depth import generate_depth_map
from .indexer import ScanManager
from .media import MediaRoots, classify_media
from .mounts import MountError, MountManager
from .thumbs import MIME_OVERRIDES, make_preview, make_thumb, needs_conversion


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

    @app.on_event("startup")
    def startup():
        mounts.restore_all()
        scanner.start_all()

    @app.get("/api/roots")
    def api_roots():
        return [s | {"media_count": db.media_count(s["name"])} for s in roots.status()]

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
                  type: str = "", exts: str = ""):
        if root not in roots.roots:
            raise HTTPException(status_code=400, detail=f"unknown root: {root}")
        ext_list = [e.strip().lstrip(".").lower() for e in exts.split(",") if e.strip()]
        return db.query_files(root, dir=path, recursive=bool(recursive), query=query,
                              sort=sort, limit=min(limit, 500), offset=max(offset, 0),
                              media_type=type, exts=ext_list)

    @app.post("/api/scan/{root}")
    def api_scan(root: str):
        if root not in roots.roots:
            raise HTTPException(status_code=400, detail=f"unknown root: {root}")
        return {"started": scanner.start(root)}

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
        if payload.root not in roots.roots:
            raise HTTPException(status_code=400, detail=f"unknown root: {payload.root}")
        # soft delete: rename into <root>/.refdeck-trash (indexer skips dot-folders)
        trash = Path(roots.roots[payload.root]) / ".refdeck-trash"
        deleted: list[str] = []
        errors: dict[str, str] = {}
        for rel in payload.paths:
            try:
                target = roots.resolve(payload.root, rel)
                if not target.is_file():
                    raise ValueError("file not found")
                dest = trash / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                base, n = dest, 1
                while dest.exists():
                    dest = base.with_name(f"{base.stem}-{n}{base.suffix}")
                    n += 1
                shutil.move(str(target), str(dest))
                deleted.append(rel)
            except (ValueError, OSError) as exc:
                errors[rel] = str(exc)
        if deleted:
            db.remove_files(payload.root, deleted)
        return {"deleted": deleted, "errors": errors}

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
        try:
            return mounts.add(payload.name.strip(), payload.server.strip(), payload.share.strip(),
                              payload.subpath.strip(), payload.username, payload.password)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except MountError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.delete("/api/mounts/{mount_id}")
    def api_remove_mount(mount_id: int):
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

    static = Path(__file__).parent / "static"
    app.mount("/", StaticFiles(directory=static, html=True), name="static")
    return app


app = create_app()
