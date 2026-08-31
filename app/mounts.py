from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .db import RefDeckDB
from .indexer import ScanManager
from .media import MediaRoots

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$")


class MountError(RuntimeError):
    pass


class MountManager:
    def __init__(self, db: RefDeckDB, roots: MediaRoots, scanner: ScanManager,
                 base: Path, runner=subprocess.run):
        self.db = db
        self.roots = roots
        self.scanner = scanner
        self.base = Path(base)
        self.runner = runner
        self.errors: dict[str, str] = {}

    @staticmethod
    def public(record: dict) -> dict:
        return {k: v for k, v in record.items() if k != "password"}

    def _mount(self, record: dict) -> Path:
        target = self.base / record["name"]
        target.mkdir(parents=True, exist_ok=True)
        source = f"//{record['server']}/{record['share']}"
        opts = "ro,iocharset=utf8"
        if record.get("username"):
            opts += f",username={record['username']},password={record.get('password', '')}"
        else:
            opts += ",guest"
        result = self.runner(["mount", "-t", "cifs", source, str(target), "-o", opts],
                             capture_output=True, text=True)
        if result.returncode != 0:
            raise MountError(result.stderr.strip() or f"mount failed ({result.returncode})")
        return target / record["subpath"] if record.get("subpath") else target

    def add(self, name, server, share, subpath="", username="", password="") -> dict:
        if not NAME_RE.match(name or ""):
            raise ValueError("mount name must be letters, numbers, spaces, - or _")
        if name in self.roots.roots:
            raise ValueError(f"root already exists: {name}")
        record = {"name": name, "server": server, "share": share,
                  "subpath": subpath, "username": username, "password": password}
        root_path = self._mount(record)
        saved = self.db.create_mount(name, server, share, subpath, username, password)
        self.roots.add(name, root_path)
        self.errors.pop(name, None)
        self.scanner.start(name)
        return saved

    def remove(self, mount_id: int) -> None:
        record = self.db.get_mount(mount_id)
        self.runner(["umount", str(self.base / record["name"])], capture_output=True, text=True)
        self.roots.remove(record["name"])
        self.db.delete_mount(mount_id)
        self.db.delete_root_files(record["name"])
        self.errors.pop(record["name"], None)

    def restore_all(self) -> None:
        for record in self.db.list_mounts():
            try:
                root_path = self._mount(record)
                self.errors.pop(record["name"], None)
            except MountError as exc:
                self.errors[record["name"]] = str(exc)
                root_path = self.base / record["name"]
            self.roots.add(record["name"], root_path)

    def listing(self) -> list[dict]:
        out = []
        for record in self.db.list_mounts():
            path = self.roots.roots.get(record["name"])
            out.append(self.public(record) | {
                "online": bool(path and path.is_dir() and record["name"] not in self.errors),
                "error": self.errors.get(record["name"]),
            })
        return out
