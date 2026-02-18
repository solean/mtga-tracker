# MTGData MVP

Local MTG Arena log parser + viewer.

This MVP includes:
- Go backend parser for `Player.log` / `Player-prev.log`
- SQLite storage for matches, decks, draft sessions, draft picks, and event runs
- Local HTTP API
- React/Vite frontend for overview, match history, decks, and drafts

## Project Layout

- `/Users/cschnabel/dev/mtgdata/cmd/mtgdata` - CLI entrypoint (`parse`, `tail`, `serve`)
- `/Users/cschnabel/dev/mtgdata/internal` - backend packages (db, ingest, api)
- `/Users/cschnabel/dev/mtgdata/web` - frontend app
- `/Users/cschnabel/dev/mtgdata/spec.md` - planning/spec document

## Backend Setup

Requirements:
- Go 1.22+

Commands:

```bash
cd /Users/cschnabel/dev/mtgdata
go mod tidy
go build ./...
```

## Parse a Log File

```bash
cd /Users/cschnabel/dev/mtgdata
go run ./cmd/mtgdata parse -db data/mtgdata.db -log data/Player-prev.log -resume=false
```

Use `-resume=true` for incremental ingestion:

```bash
go run ./cmd/mtgdata parse -db data/mtgdata.db -log data/Player-prev.log -resume=true
```

## Tail a Live Log

```bash
cd /Users/cschnabel/dev/mtgdata
go run ./cmd/mtgdata tail -db data/mtgdata.db -log data/Player.log -interval=2s
```

## Run API Server

```bash
cd /Users/cschnabel/dev/mtgdata
go run ./cmd/mtgdata serve -db data/mtgdata.db -addr :8080
```

API endpoints:
- `GET /api/health`
- `GET /api/overview`
- `GET /api/matches?limit=500`
- `GET /api/decks`
- `GET /api/decks/:id`
- `GET /api/drafts`
- `GET /api/drafts/:id/picks`

## Frontend Setup

Requirements:
- Node 18+

Commands:

```bash
cd /Users/cschnabel/dev/mtgdata/web
npm install
npm run dev
```

Vite dev server runs at `http://127.0.0.1:5173` and proxies `/api` to `http://127.0.0.1:8080`.

Production build:

```bash
cd /Users/cschnabel/dev/mtgdata/web
npm run build
```

When `web/dist` exists, backend `serve` will also host built assets from `/`.

## Notes

- Event aliasing is implemented for common Arena naming differences (e.g. `FIN_Quick_Draft` to `QuickDraft_FIN_...`).
- Draft parsing supports both `BotDraftDraftPick` and `EventPlayerDraftMakePick`.
- Card IDs are currently stored as Arena integer IDs (no card metadata join yet).
