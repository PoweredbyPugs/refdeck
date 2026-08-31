from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path
from typing import Callable

from .db import RefDeckDB
from .media import MediaRoots, classify_media

MIN_FREE_BYTES = 2 * 1024 ** 3  # stop pre-generating thumbnails below 2 GB free


def free_bytes(path: Path) -> int:
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return MIN_FREE_BYTES


IGNORE_MARKER = ".refdeck-ignore"


def walk_media(base: Path) -> list[dict]:
    entries = []
    stack = [base]
    while stack:
        folder = stack.pop()
        try:
            if (folder / IGNORE_MARKER).exists():
                continue
            children = list(folder.iterdir())
        except OSError:
            continue
        for child in children:
            if child.name.startswith("."):
                continue
            try:
                if child.is_dir():
                    stack.append(child)
                    continue
                if not child.is_file():
                    continue
                media_type = classify_media(child)
                if not media_type:
                    continue
                stat = child.stat()
            except OSError:
                continue
            rel = child.relative_to(base)
            parent = rel.parent.as_posix()
            entries.append({
                "path": rel.as_posix(),
                "name": child.name,
                "dir": "" if parent == "." else parent,
                "media_type": media_type,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
            })
    return entries


class ScanManager:
    def __init__(self, roots: MediaRoots, db: RefDeckDB,
                 thumb_fn: Callable[[Path], object] | None = None):
        self.roots = roots
        self.db = db
        self.thumb_fn = thumb_fn
        self._lock = threading.Lock()
        self._status: dict[str, dict] = {}
        self._threads: dict[str, threading.Thread] = {}

    def start(self, root: str) -> bool:
        with self._lock:
            if self._status.get(root, {}).get("state") in ("scanning", "thumbnails"):
                return False
            self._status[root] = {"state": "scanning", "files": 0, "started_at": time.time()}
        thread = threading.Thread(target=self._run, args=(root,), daemon=True)
        self._threads[root] = thread
        thread.start()
        return True

    def start_all(self) -> None:
        for name in list(self.roots.roots):
            self.start(name)

    def wait(self, root: str, timeout: float = 15) -> None:
        thread = self._threads.get(root)
        if thread:
            thread.join(timeout)

    def status(self) -> dict:
        with self._lock:
            return {k: dict(v) for k, v in self._status.items()}

    def _run(self, root: str) -> None:
        try:
            base = self.roots.roots.get(root)
            if base is None or not base.is_dir():
                return
            entries = walk_media(base)
            stats = self.db.sync_files(root, entries)
            with self._lock:
                self._status[root].update(state="thumbnails", files=len(entries), **stats)
            if self.thumb_fn:
                for i, e in enumerate(sorted(entries, key=lambda x: -x["mtime"])):
                    if i % 50 == 0 and free_bytes(Path.cwd()) < MIN_FREE_BYTES:
                        with self._lock:
                            self._status[root]["thumbs_paused"] = "low disk space"
                        break
                    try:
                        self.thumb_fn(base / e["path"])
                    except Exception:
                        pass
        finally:
            with self._lock:
                self._status[root]["state"] = "idle"
