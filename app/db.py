from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterable


class RefDeckDB:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self):
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        con.execute("pragma foreign_keys = on")
        return con

    def init(self, roots: Iterable[tuple[str, str]]):
        with self.connect() as con:
            con.executescript("""
            create table if not exists roots (
                id integer primary key autoincrement,
                name text unique not null,
                path text not null
            );
            create table if not exists collections (
                id integer primary key autoincrement,
                title text not null,
                created_at text default current_timestamp,
                updated_at text default current_timestamp
            );
            create table if not exists collection_items (
                id integer primary key autoincrement,
                collection_id integer not null references collections(id) on delete cascade,
                path text not null,
                media_type text not null,
                added_at text default current_timestamp
            );
            create table if not exists boards (
                id integer primary key autoincrement,
                title text not null,
                document_json text not null,
                created_at text default current_timestamp,
                updated_at text default current_timestamp
            );
            create table if not exists files (
                id integer primary key autoincrement,
                root text not null,
                path text not null,
                name text not null,
                dir text not null,
                media_type text not null,
                size integer not null,
                mtime integer not null,
                hidden integer not null default 0,
                unique(root, path)
            );
            create index if not exists idx_files_root_dir on files(root, dir);
            create table if not exists mounts (
                id integer primary key autoincrement,
                name text unique not null,
                server text not null,
                share text not null,
                subpath text not null default '',
                username text not null default '',
                password text not null default '',
                created_at text default current_timestamp
            );
            """)
            if "hidden" not in {r["name"] for r in con.execute("pragma table_info(files)")}:
                con.execute("alter table files add column hidden integer not null default 0")
            current_names = []
            for name, path in roots:
                current_names.append(name)
                con.execute(
                    "insert into roots(name, path) values(?, ?) on conflict(name) do update set path=excluded.path",
                    (name, path),
                )
            if current_names:
                placeholders = ",".join("?" for _ in current_names)
                con.execute(f"delete from roots where name not in ({placeholders})", current_names)

    def roots(self) -> list[dict]:
        with self.connect() as con:
            return [dict(r) for r in con.execute("select id, name, path from roots order by name")]

    def create_collection(self, title: str) -> dict:
        with self.connect() as con:
            cur = con.execute("insert into collections(title) values(?)", (title,))
            return {"id": cur.lastrowid, "title": title, "items": []}

    def add_collection_item(self, collection_id: int, path: str, media_type: str) -> dict:
        with self.connect() as con:
            cur = con.execute(
                "insert into collection_items(collection_id, path, media_type) values(?, ?, ?)",
                (collection_id, path, media_type),
            )
            con.execute("update collections set updated_at=current_timestamp where id=?", (collection_id,))
            return {"id": cur.lastrowid, "collection_id": collection_id, "path": path, "media_type": media_type}

    def collections(self) -> list[dict]:
        with self.connect() as con:
            collections = [dict(r) | {"items": []} for r in con.execute("select id, title, created_at, updated_at from collections order by updated_at desc")]
            by_id = {c["id"]: c for c in collections}
            for row in con.execute("select id, collection_id, path, media_type, added_at from collection_items order by id"):
                if row["collection_id"] in by_id:
                    by_id[row["collection_id"]]["items"].append(dict(row))
            return collections

    def remove_collection_item(self, item_id: int) -> None:
        with self.connect() as con:
            con.execute("delete from collection_items where id=?", (item_id,))

    def delete_collection(self, collection_id: int) -> None:
        with self.connect() as con:
            con.execute("delete from collections where id=?", (collection_id,))

    def delete_board(self, board_id: int) -> None:
        with self.connect() as con:
            con.execute("delete from boards where id=?", (board_id,))

    def upsert_files(self, root: str, entries: list[dict]) -> None:
        with self.connect() as con:
            for e in entries:
                con.execute(
                    "insert into files(root, path, name, dir, media_type, size, mtime) values(?,?,?,?,?,?,?) "
                    "on conflict(root, path) do update set name=excluded.name, dir=excluded.dir, "
                    "media_type=excluded.media_type, size=excluded.size, mtime=excluded.mtime",
                    (root, e["path"], e["name"], e["dir"], e["media_type"], e["size"], e["mtime"]))

    def remove_dir_files(self, root: str, dirpath: str) -> None:
        with self.connect() as con:
            con.execute("delete from files where root=? and (dir=? or dir like ?)",
                        (root, dirpath, dirpath + "/%"))

    def remove_missing(self, root: str, seen: set[str]) -> int:
        with self.connect() as con:
            gone = [r["path"] for r in con.execute("select path from files where root=?", (root,))
                    if r["path"] not in seen]
            for i in range(0, len(gone), 500):
                chunk = gone[i:i + 500]
                marks = ",".join("?" for _ in chunk)
                con.execute(f"delete from files where root=? and path in ({marks})", [root, *chunk])
            return len(gone)

    def query_files(self, root: str, dir: str = "", recursive: bool = False, query: str = "",
                    sort: str = "name", limit: int = 200, offset: int = 0,
                    media_type: str = "", exts: list[str] | None = None,
                    include_hidden: bool = False) -> dict:
        where, params = ["root=?"], [root]
        if not include_hidden:
            where.append("hidden=0")
        if recursive:
            if dir:
                where.append("(dir=? or dir like ?)")
                params += [dir, dir + "/%"]
        else:
            where.append("dir=?")
            params.append(dir)
        if query:
            esc = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append("path like ? escape '\\'")
            params.append(f"%{esc}%")
        if media_type:
            where.append("media_type=?")
            params.append(media_type)
        if exts:
            where.append("(" + " or ".join("name like ?" for _ in exts) + ")")
            params += [f"%.{e}" for e in exts]
        order = {"name": "name collate nocase", "date": "mtime desc", "size": "size desc",
                 "type": "media_type, name collate nocase"}.get(sort, "name collate nocase")
        clause = " and ".join(where)
        with self.connect() as con:
            total = con.execute(f"select count(*) from files where {clause}", params).fetchone()[0]
            rows = [dict(r) for r in con.execute(
                f"select root, path, name, dir, media_type, size, mtime, hidden from files "
                f"where {clause} order by {order} limit ? offset ?", [*params, limit, offset])]
        return {"total": total, "files": rows}

    def media_count(self, root: str, dir: str = "") -> int:
        with self.connect() as con:
            if dir:
                return con.execute(
                    "select count(*) from files where root=? and hidden=0 and (dir=? or dir like ?)",
                    (root, dir, dir + "/%")).fetchone()[0]
            return con.execute("select count(*) from files where root=? and hidden=0",
                               (root,)).fetchone()[0]

    def set_hidden(self, root: str, paths: list[str], hidden: bool) -> int:
        updated = 0
        with self.connect() as con:
            for i in range(0, len(paths), 500):
                chunk = paths[i:i + 500]
                marks = ",".join("?" for _ in chunk)
                cur = con.execute(f"update files set hidden=? where root=? and path in ({marks})",
                                  [1 if hidden else 0, root, *chunk])
                updated += cur.rowcount
        return updated

    def count_hidden(self, root: str, paths: list[str]) -> tuple[int, int]:
        matched = hidden = 0
        with self.connect() as con:
            for i in range(0, len(paths), 500):
                chunk = paths[i:i + 500]
                marks = ",".join("?" for _ in chunk)
                row = con.execute(
                    f"select count(*), coalesce(sum(hidden), 0) from files "
                    f"where root=? and path in ({marks})", [root, *chunk]).fetchone()
                matched += row[0]
                hidden += row[1]
        return matched, hidden

    def remove_files(self, root: str, paths: list[str]) -> None:
        with self.connect() as con:
            for i in range(0, len(paths), 500):
                chunk = paths[i:i + 500]
                marks = ",".join("?" for _ in chunk)
                con.execute(f"delete from files where root=? and path in ({marks})", [root, *chunk])

    def delete_root_files(self, root: str) -> None:
        with self.connect() as con:
            con.execute("delete from files where root=?", (root,))

    def create_mount(self, name, server, share, subpath, username, password) -> dict:
        with self.connect() as con:
            cur = con.execute(
                "insert into mounts(name, server, share, subpath, username, password) values(?,?,?,?,?,?)",
                (name, server, share, subpath, username, password))
            return {"id": cur.lastrowid, "name": name, "server": server,
                    "share": share, "subpath": subpath, "username": username}

    def list_mounts(self) -> list[dict]:
        with self.connect() as con:
            return [dict(r) for r in con.execute("select * from mounts order by name")]

    def get_mount(self, mount_id: int) -> dict:
        with self.connect() as con:
            row = con.execute("select * from mounts where id=?", (mount_id,)).fetchone()
            if not row:
                raise KeyError(mount_id)
            return dict(row)

    def delete_mount(self, mount_id: int) -> None:
        with self.connect() as con:
            con.execute("delete from mounts where id=?", (mount_id,))

    def boards(self) -> list[dict]:
        with self.connect() as con:
            return [dict(r) for r in con.execute("select id, title, created_at, updated_at from boards order by updated_at desc")]

    def board(self, board_id: int) -> dict:
        with self.connect() as con:
            row = con.execute("select id, title, document_json, created_at, updated_at from boards where id=?", (board_id,)).fetchone()
            if not row:
                raise KeyError(board_id)
            data = dict(row)
            data["document"] = json.loads(data.pop("document_json"))
            return data

    def save_board(self, board_id: int | None, title: str, document: dict) -> dict:
        payload = json.dumps(document)
        with self.connect() as con:
            if board_id is None:
                cur = con.execute("insert into boards(title, document_json) values(?, ?)", (title, payload))
                board_id = cur.lastrowid
            else:
                con.execute("update boards set title=?, document_json=?, updated_at=current_timestamp where id=?", (title, payload, board_id))
        return self.board(board_id)
