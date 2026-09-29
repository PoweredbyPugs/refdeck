# RefDeck

**PureRef and Kyno had a baby.** RefDeck is a self-hosted media browser and
reference-board tool for your LAN: point it at your drives, and every image and
video becomes instantly browsable, searchable, and droppable onto an infinite
canvas — originals never move, never get copied, never get "imported."

Built with FastAPI + SQLite + dependency-free vanilla JS. Runs in Docker on a
Mac mini (or anything else), serves any browser on your network — and, with
the login and permission switches below, can safely hand one folder to a
client over the internet, phone-first.

## Features

### Explorer
- **Media index** — a background scanner walks each root into SQLite, so
  browsing, search, and sorting are instant even for tens of thousands of files
  on network drives.
- **Drive tree** — every root and its folders in one expandable sidebar tree;
  right-click any folder to open or drill it.
- **Drill down** — Kyno's signature move: flatten a whole folder tree into one
  grid. Folders with nothing directly inside them tell you how many images live
  beneath, one click away.
- **Three views** — masonry gallery (true aspect ratios, images only), cards,
  and a file list. Infinite scroll in pages of 200.
- **Filters** — All / Images / Videos, with per-format chips (jpg, png, psd,
  tiff, heic… / mp4, mov, mkv…). Server-side, spans the whole drill-down set.
- **Any format** — HEIC, PSD, and TIFF get real thumbnails and convert
  on-the-fly to browser-viewable previews. Video thumbs via ffmpeg.
- **Collections** — save any image to a named collection from the right-click
  menu, open collections as their own grid, remove with one click.
- **Command palette** — `/` or `⌘K` from anywhere: every command and view
  jump, fuzzy-matched.

### Preview
- Full-viewport, zero chrome. Everything is keyboard + right-click:
  `←`/`→` prev/next · `⌃↑`/`⌃↓` or `+`/`−` or ctrl-scroll to zoom (drag to pan)
  · `R`/`⇧R` rotate · `H`/`V` flip · `1` true 1:1 pixels · `0` reset view
  · `I` details panel (dimensions, size, dates, duration) · `Esc` closes and
  stops video playback.
- **Depth maps** — generate a depth map for any image with a bundled
  Depth Anything V2 model (runs locally on CPU, no cloud). `M` opens a
  side-by-side compare with a draggable split bar; copy or download the map
  from the right-click menu.

### Boards (the PureRef half)
- Frameless items at **true aspect ratio** — the image is the object.
- Drag from the explorer, pan the canvas, zoom **10%–1000%** at the cursor.
- **Marquee selection** with ctrl/⌘-drag, shift-click to extend.
- Right-click for the full toolkit: align edges/centers, distribute, and
  **Arrange (pack)** — a PureRef-style reorg into a tidy collage — plus
  layer order and notes.
- **Notes** (`N`) — markdown text cards saved with the board.
- **Undo/redo** (`⌘Z`/`⌘⇧Z`) through every move, and boards **autosave** —
  `⌘S` still works for the impatient.
- Boards and collections persist in SQLite across restarts.

### Chrome
- Slim instrument-rail header with Explore / Split / Canvas modes.
- **Zen mode** (`Z`) — every scrap of UI disappears; hover the top or left
  screen edge to summon the toolbar or folder tree.
- Sidebar toggle (`F`), responsive down to narrow windows.
- Full keyboard reference in Settings.

### Phone & touch
- **Phone layout** (≤700px): full-bleed gallery of the whole library with a
  floating ☰. The menu slides in behind the gallery, which springs aside as a
  rounded card (a physical spring via CSS `linear()`). It holds Upload, filters,
  sort, collections, boards, theme and log out.
- **Swipe preview** on any touch screen: ← → between files, ↓ back to the
  gallery, pinch or double-tap to zoom, tap for the close/counter overlay,
  long-press for the action menu. The back button closes the preview or menu.
- Boards open full-screen on phones for viewing: one finger pans, pinch zooms.
- **Light / dark / auto theme**: Settings, the palette, or the phone menu.
- **Profile photo**: tap the menu avatar (or Settings → Profile photo…) to
  upload one or pick from collections / all photos, frame it in a circular
  crop, save. Stored re-encoded (512px JPEG, no EXIF/GPS) in `data/profile/`,
  never in a media root.

### Storage & mounts
- Media roots are mounted **read-only**; RefDeck stores paths and a thumbnail
  cache, nothing else.
- **In-app SMB mounting** — add `//server/share` with credentials in Settings;
  it mounts inside the container, indexes, and re-mounts on restart.
- Drop a `.refdeck-ignore` file in any folder to exclude it from indexing.

## Running

```bash
docker compose up -d --build
# → http://<host>:8787
```

Edit `compose.yaml` to bind your drives:

```yaml
environment:
  REFDECK_ROOTS: MyDrive=/media/MyDrive        # Name=path;Other=/media/Other
volumes:
  - /Volumes/MyDrive:/media/MyDrive:ro         # originals stay read-only
  - ./data:/app/data                           # index db + thumbnail cache
cap_add:                                       # required for in-app SMB mounts
  - SYS_ADMIN
  - DAC_READ_SEARCH
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `REFDECK_ROOTS` | *(none — required)* | `Name=path` pairs, `;`-separated |
| `REFDECK_DATA_DIR` | `./data` | SQLite DB + thumbnail cache |
| `REFDECK_MOUNT_BASE` | `/mnt/refdeck` | where SMB shares mount |
| `REFDECK_AUTH_USER` / `REFDECK_AUTH_HASH` | *(off)* | turn on the login page — hash from `python -m app.auth` |
| `REFDECK_SECRET` | *(random per start)* | signs session cookies; set it so logins survive restarts |
| `REFDECK_COOKIE_SECURE` | `1` | `0` only for plain-HTTP testing |
| `REFDECK_BRAND` | *(none)* | name shown on the login page and wordmark |
| `REFDECK_THEME` | `dark` | default theme, `light` / `dark` / `auto` (each device can override) |
| `REFDECK_ALLOW_UPLOAD` | `0` | upload button + drag-in from the desktop |
| `REFDECK_UPLOAD_MAX_MB` | `2048` | per-file upload cap |
| `REFDECK_ALLOW_DELETE` | `1` | delete / move / restore |
| `REFDECK_ALLOW_MOUNTS` | `1` | in-app SMB mounting |

First start triggers a full index scan with background thumbnail
pre-generation (it pauses below 2 GB free disk and resumes on demand).
The first depth-map request downloads the ~100 MB ONNX model into
`data/models`; generated maps are cached in `data/depth`.

## Sharing an instance beyond your LAN

Run a **second, separate instance** for anyone outside your network (a
client, a collaborator) instead of opening up your own:

- Its own compose project and `data/` folder (own index, boards, profile).
- `REFDECK_ROOTS` pointing at **only** the folder you're sharing; mount just
  that subfolder (e.g. a Docker `nfs` volume with a subpath `device`).
- Login on: `REFDECK_AUTH_USER`, `REFDECK_AUTH_HASH`
  (`python -m app.auth`), `REFDECK_SECRET`. The hash uses `:` separators,
  so it survives compose's `$` interpolation in `.env`.
- Least privilege: `REFDECK_ALLOW_UPLOAD=1` if they should add files,
  `REFDECK_ALLOW_DELETE=0`, `REFDECK_ALLOW_MOUNTS=0`; no `cap_add`, and
  `cap_drop: [ALL]` works. Set `TMPDIR` inside `data/` so large uploads
  don't spool onto a small system disk.
- **No published ports.** Serve it through an HTTPS tunnel instead — for
  example a Tailscale sidecar container with Funnel on 443 and RefDeck on
  `network_mode: service:<sidecar>`, or a Cloudflare Tunnel. The session
  cookie is `Secure`, so plain HTTP won't log in.
- **Lock down outbound traffic.** On Docker Desktop (macOS/Windows) a
  container's outbound traffic leaves through the host, so it can reach
  your LAN and any VPN the host is on — ACLs on a sidecar's own identity
  don't apply to it. Reject private, CGNAT and link-local ranges
  (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16`) in the
  shared network namespace, e.g. with `iptables` in the sidecar's
  entrypoint before it starts (`NET_ADMIN` on the sidecar only). Network
  volumes are mounted by the Docker VM, outside that namespace, so they
  keep working.
- `REFDECK_BRAND` and `REFDECK_THEME` make it feel like theirs.

## Development

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest tests/ -q          # 96 tests
REFDECK_ROOTS="Media=/path/to/media" .venv/bin/uvicorn app.main:app --port 8788
```

Layout: `app/media.py` (roots + traversal safety) · `app/indexer.py` (scanner)
· `app/auth.py` (optional login)
· `app/db.py` (SQLite) · `app/thumbs.py` (thumbnails/previews) ·
`app/depth.py` (depth maps) · `app/mounts.py` (SMB) · `app/main.py` (API) ·
`app/static/` (UI).

## API sketch

`GET /api/roots` · `GET /api/browse?root&path` (dirs + recursive count) ·
`GET /api/files?root&path&recursive&query&sort&type&exts&limit&offset` ·
`GET /api/thumb|preview|media|depth?root&path` · `POST /api/scan/{root}` ·
`GET /api/scan/status` · CRUD on `/api/collections`, `/api/boards`,
`/api/mounts` · `POST /api/upload?root&path` (multipart) ·
`GET|POST|DELETE /api/profile/avatar` · `GET /api/config` (which switches
are on) · `GET|POST /login`, `POST /logout`.

## Notes

- LAN tool by default, no auth. Before exposing it anywhere else, set
  `REFDECK_AUTH_USER`/`REFDECK_AUTH_HASH`/`REFDECK_SECRET` and serve it over
  HTTPS only (the session cookie is `Secure`). Logins back off after 5 misses.
- SMB credentials are stored plaintext in `data/refdeck.db`; `data/` is
  gitignored for exactly that reason.
- Media classification is an explicit extension whitelist (a `mimetypes`
  fallback once indexed 60k TypeScript files as video — never again).
