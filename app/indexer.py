from __future__ import annotations

import os
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


BATCH_SIZE = 250

# dirs-table sentinel for a subdir discovered but not yet walked: never equals
# a real mtime_ns, so the next quick scan always descends into it
QUICK_NEVER = -1


def walk_media(base: Path, dirs_out: list[dict] | None = None):
    stack = [base]
    while stack:
        folder = stack.pop()
        try:
            mtime = folder.stat().st_mtime_ns
            if (folder / IGNORE_MARKER).exists():
                # deliberately recorded: a later quick scan stats it and
                # notices the marker's removal (which bumps the dir mtime)
                if dirs_out is not None:
                    rel = folder.relative_to(base).as_posix()
                    dirs_out.append({"path": "" if rel == "." else rel, "mtime": mtime})
                continue
            children = list(folder.iterdir())
        except OSError:
            continue
        if dirs_out is not None:
            rel = folder.relative_to(base).as_posix()
            dirs_out.append({"path": "" if rel == "." else rel, "mtime": mtime})
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
            yield {
                "path": rel.as_posix(),
                "name": child.name,
                "dir": "" if parent == "." else parent,
                "media_type": media_type,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
            }


def walk_changes(base: Path, known: dict[str, int]):
    """Incremental walk: stat every known dir, re-read only changed ones.

    A dir whose mtime_ns matches the index has the exact same direct children,
    so we recurse straight into its known subdirs without reading it. Yields
    event tuples in an order that keeps the index consistent if the walk dies
    partway (a dir's own mtime commits only after its contents did):
      ("file", entry)         upsert one media file
      ("sync", (dir, seen))   prune direct files of dir not in seen
      ("rmdir", dir)          dir vanished/ignored: drop subtree + index rows
      ("dir", {path, mtime})  commit dir mtime
    """
    children: dict[str, list[str]] = {}
    for p in known:
        if p:
            parent = p.rsplit("/", 1)[0] if "/" in p else ""
            children.setdefault(parent, []).append(p)
    stack = [""]
    while stack:
        rel = stack.pop()
        folder = base / rel if rel else base
        try:
            mtime = folder.stat().st_mtime_ns
        except (FileNotFoundError, NotADirectoryError):
            if not rel:  # root itself gone (drive dropped): touch nothing
                return
            yield ("rmdir", rel)
            continue
        except OSError:
            continue  # transient (permissions, IO): keep index, skip
        if known.get(rel) == mtime:
            stack.extend(children.get(rel, ()))
            continue
        try:
            with os.scandir(folder) as it:
                found = list(it)
        except OSError:
            continue
        if any(e.name == IGNORE_MARKER for e in found):
            yield ("rmdir", rel)
            yield ("dir", {"path": rel, "mtime": mtime})
            continue
        subdirs: list[str] = []
        seen: set[str] = set()
        for entry in found:
            if entry.name.startswith("."):
                continue
            path = f"{rel}/{entry.name}" if rel else entry.name
            try:
                if entry.is_dir():
                    subdirs.append(path)
                    continue
                if not entry.is_file():
                    continue
                media_type = classify_media(Path(entry.path))
                if not media_type:
                    continue
                stat = entry.stat()
            except OSError:
                continue
            seen.add(path)
            yield ("file", {
                "path": path,
                "name": entry.name,
                "dir": rel,
                "media_type": media_type,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
            })
        yield ("sync", (rel, seen))
        present = set(subdirs)
        for child in children.get(rel, ()):
            if child not in present:
                yield ("rmdir", child)
        for child in subdirs:
            if child not in known:
                yield ("dir", {"path": child, "mtime": QUICK_NEVER})
        yield ("dir", {"path": rel, "mtime": mtime})
        stack.extend(subdirs)


class ScanManager:
    def __init__(self, roots: MediaRoots, db: RefDeckDB,
                 thumb_fn: Callable[[Path], object] | None = None):
        self.roots = roots
        self.db = db
        self.thumb_fn = thumb_fn
        self._lock = threading.Lock()
        self._status: dict[str, dict] = {}
        self._threads: dict[str, threading.Thread] = {}

    def start(self, root: str, quick: bool = False) -> bool:
        with self._lock:
            if self._status.get(root, {}).get("state") in ("scanning", "thumbnails"):
                return False
            self._status[root] = {"state": "scanning", "files": 0, "started_at": time.time()}
        thread = threading.Thread(target=self._run, args=(root, quick), daemon=True)
        self._threads[root] = thread
        thread.start()
        return True

    def start_all(self, quick: bool = False) -> None:
        for name in list(self.roots.roots):
            self.start(name, quick=quick)

    def wait(self, root: str, timeout: float = 15) -> None:
        thread = self._threads.get(root)
        if thread:
            thread.join(timeout)

    def status(self) -> dict:
        with self._lock:
            return {k: dict(v) for k, v in self._status.items()}

    def _run(self, root: str, quick: bool = False) -> None:
        try:
            base = self.roots.roots.get(root)
            if base is None or not base.is_dir():
                return
            # quick scan needs a populated dir index; a pre-dirs DB (or first
            # run) falls back to the full walk, which builds it
            known = self.db.known_dirs(root) if quick else None
            entries = (self._quick_pass(root, base, known) if known
                       else self._full_pass(root, base))
            if entries is None:
                return  # walk errored; status already updated
            with self._lock:
                self._status[root]["state"] = "thumbnails"
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

    def _full_pass(self, root: str, base: Path) -> list[dict] | None:
        # commit as we walk so a restart or network drop keeps progress;
        # prune vanished files (and swap the dir index) only after a COMPLETE
        # walk (a partial one simply hasn't seen the rest yet)
        entries: list[dict] = []
        batch: list[dict] = []
        dirs: list[dict] = []

        def flush():
            if not batch:
                return
            self.db.upsert_files(root, batch)
            entries.extend(batch)
            batch.clear()
            with self._lock:
                self._status[root]["files"] = len(entries)

        try:
            for entry in walk_media(base, dirs_out=dirs):
                batch.append(entry)
                if len(batch) >= BATCH_SIZE:
                    flush()
        except OSError as exc:
            flush()
            with self._lock:
                self._status[root]["error"] = str(exc)
            return None
        flush()
        removed = self.db.remove_missing(root, {e["path"] for e in entries})
        self.db.replace_dirs(root, dirs)
        with self._lock:
            self._status[root].update(files=len(entries), removed=removed)
        return entries

    def _quick_pass(self, root: str, base: Path, known: dict[str, int]) -> list[dict] | None:
        # entries collects only genuinely new/changed files (vs the DB row),
        # so the thumbnail pass does zero work on an unchanged drive
        entries: list[dict] = []
        batch: list[dict] = []
        cur_dir: str | None = None
        cur_meta: dict[str, tuple[int, int]] = {}
        removed = 0

        def flush():
            if not batch:
                return
            self.db.upsert_files(root, batch)
            entries.extend(batch)
            batch.clear()
            with self._lock:
                self._status[root]["files"] = len(entries)

        try:
            for kind, payload in walk_changes(base, known):
                if kind == "file":
                    if payload["dir"] != cur_dir:
                        cur_dir = payload["dir"]
                        cur_meta = self.db.dir_file_meta(root, cur_dir)
                    if cur_meta.get(payload["path"]) == (payload["size"], payload["mtime"]):
                        continue
                    batch.append(payload)
                    if len(batch) >= BATCH_SIZE:
                        flush()
                elif kind == "sync":
                    flush()
                    removed += self.db.sync_dir_files(root, payload[0], payload[1])
                elif kind == "rmdir":
                    flush()
                    self.db.remove_dir_files(root, payload)
                    self.db.remove_dir_index(root, payload)
                elif kind == "dir":
                    flush()
                    self.db.upsert_dirs(root, [payload])
        except OSError as exc:
            flush()
            with self._lock:
                self._status[root]["error"] = str(exc)
            return None
        flush()
        with self._lock:
            self._status[root]["removed"] = removed
        return entries
