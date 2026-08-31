# RefDeck

**PureRef and Kyno had a baby.** RefDeck is a self-hosted media browser and
reference-board tool for your LAN: point it at your drives, and every image and
video becomes instantly browsable, searchable, and droppable onto an infinite
canvas — originals never move, never get copied, never get "imported."

Built with FastAPI + SQLite + dependency-free vanilla JS. Runs in Docker on a
Mac mini (or anything else), serves any browser on your network.

## Features

### Explorer
- **Media index** — a background scanner walks each root into SQLite, so
  browsing, search, and sorting are instant even for tens of thousands of files
  on network drives.
- **Drill down** — Kyno's signature move: flatten a whole folder tree into one
  grid. Folders with nothing directly inside them tell you how many images live
  beneath, one click away.
- **Three views** — masonry gallery (true aspect ratios, images only), cards,
  and a file list. Infinite scroll in pages of 200.
- **Filters** — All / Images / Videos, with per-format chips (jpg, png, psd,
  tiff, heic… / mp4, mov, mkv…). Server-side, spans the whole drill-down set.
- **Any format** — HEIC, PSD, and TIFF get real thumbnails and convert
  on-the-fly to browser-viewable previews. Video thumbs via ffmpeg.

### Preview
- Full-viewport, zero chrome. Everything is keyboard + right-click:
  `←`/`→` prev/next · `⌃↑`/`⌃↓` or `+`/`−` or ctrl-scroll to zoom (drag to pan)
  · `0` reset · `I` details panel (dimensions, size, dates, duration) · `Esc`
  closes and stops video playback.

### Boards (the PureRef half)
- Frameless items at **true aspect ratio** — the image is the object.
- Drag from the explorer, pan the canvas, zoom **10%–1000%** at the cursor.
- **Marquee selection** with ctrl/⌘-drag, shift-click to extend.
- Right-click for the full toolkit: align edges/centers, distribute, and
  **Arrange (pack)** — a PureRef-style reorg into a tidy collage — plus
  layer order and notes.
- **Notes** (`N`) — editable text cards saved with the board.
- Boards and collections persist in SQLite across restarts.

### Chrome
- Slim instrument-rail header with Explore / Split / Canvas modes.
- **Zen mode** (`Z`) — every scrap of UI disappears; hover the top or left
  screen edge to summon the toolbar or folder tree.
- Sidebar toggle (`F`), responsive down to narrow windows.

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

First start triggers a full index scan with background thumbnail
pre-generation (it pauses below 2 GB free disk and resumes on demand).

## Development

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest tests/ -q          # 28 tests
REFDECK_ROOTS="Media=/path/to/media" .venv/bin/uvicorn app.main:app --port 8788
```

Layout: `app/media.py` (roots + traversal safety) · `app/indexer.py` (scanner)
· `app/db.py` (SQLite) · `app/thumbs.py` (thumbnails/previews) ·
`app/mounts.py` (SMB) · `app/main.py` (API) · `app/static/` (UI).
Design docs live in `docs/superpowers/`.

## API sketch

`GET /api/roots` · `GET /api/browse?root&path` (dirs + recursive count) ·
`GET /api/files?root&path&recursive&query&sort&type&exts&limit&offset` ·
`GET /api/thumb|preview|media?root&path` · `POST /api/scan/{root}` ·
`GET /api/scan/status` · CRUD on `/api/collections`, `/api/boards`,
`/api/mounts`.

## Notes

- LAN tool, no auth — don't expose port 8787 to the internet.
- SMB credentials are stored plaintext in `data/refdeck.db`; `data/` is
  gitignored for exactly that reason.
- Media classification is an explicit extension whitelist (a `mimetypes`
  fallback once indexed 60k TypeScript files as video — never again).
