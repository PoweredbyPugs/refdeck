from __future__ import annotations

from pathlib import Path
from typing import Dict

# Explicit sets only — a mimetypes fallback classifies differently per OS
# (macOS maps .ts TypeScript files to video/mp2t, indexing 60k+ source files).
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff",
              ".heic", ".heif", ".psd"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mts", ".m2ts"}


def _is_dir(path: Path) -> bool:
    # Bind mounts can refuse to stat entries (e.g. macOS .TemporaryItems) —
    # treat anything unstatable as not-a-folder instead of failing the listing.
    try:
        return path.is_dir()
    except OSError:
        return False


def classify_media(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTS:
        return "image"
    if suffix in VIDEO_EXTS:
        return "video"
    return None


class MediaRoots:
    def __init__(self, roots: Dict[str, Path]):
        self.roots = {name: Path(path).resolve() for name, path in roots.items()}

    def add(self, name: str, path) -> None:
        self.roots[name] = Path(path).resolve()

    def remove(self, name: str) -> None:
        self.roots.pop(name, None)

    def status(self) -> list[dict]:
        return [{"name": name, "path": str(path), "online": path.is_dir()}
                for name, path in sorted(self.roots.items())]

    def resolve(self, root: str, rel_path: str = "") -> Path:
        if root not in self.roots:
            raise ValueError(f"unknown root: {root}")
        base = self.roots[root]
        target = (base / rel_path).resolve()
        if target != base and base not in target.parents:
            raise ValueError(f"path escapes root: {rel_path}")
        return target

    def list_dirs(self, root: str, rel_path: str = "") -> dict:
        target = self.resolve(root, rel_path)
        if not target.is_dir():
            raise ValueError(f"not a folder: {rel_path}")
        dirs = [{"name": c.name, "path": c.relative_to(self.roots[root]).as_posix()}
                for c in sorted(target.iterdir(), key=lambda p: p.name.lower())
                if not c.name.startswith(".") and _is_dir(c)]
        return {"root": root, "path": rel_path, "dirs": dirs}

