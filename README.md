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

## Root Scripts

From `/Users/cschnabel/dev/mtgdata`:

```bash
./scripts/start-web.sh
./scripts/start-backend.sh
./scripts/start-parse.sh
./scripts/start-tail.sh
```

Each script also forwards any additional CLI flags you pass through to the underlying command.

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

Default (recommended on macOS):
- Parses `~/Library/Logs/Wizards Of The Coast/MTGA/Player-prev.log`
- Then parses `~/Library/Logs/Wizards Of The Coast/MTGA/Player.log`

```bash
cd /Users/cschnabel/dev/mtgdata
go run ./cmd/mtgdata parse -db data/mtgdata.db -resume=false
```

Use `-resume=true` for incremental ingestion:

```bash
go run ./cmd/mtgdata parse -db data/mtgdata.db -resume=true
```

Optional explicit log path:

```bash
go run ./cmd/mtgdata parse -db data/mtgdata.db -log /absolute/path/to/Player.log -resume=true
```

## Tail a Live Log

Default (recommended on macOS): tails `~/Library/Logs/Wizards Of The Coast/MTGA/Player.log`

```bash
cd /Users/cschnabel/dev/mtgdata
go run ./cmd/mtgdata tail -db data/mtgdata.db -interval=2s
```

`tail` now logs activity summaries whenever new log lines are ingested (for example when matches/decks/events are picked up).

Enable idle heartbeat logs (every poll):

```bash
go run ./cmd/mtgdata tail -db data/mtgdata.db -interval=2s -verbose=true
```

Optional explicit log path:

```bash
go run ./cmd/mtgdata tail -db data/mtgdata.db -log /absolute/path/to/Player.log -interval=2s
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
- `GET /api/matches/:id`
- `GET /api/matches/:id/timeline`
- `GET /api/decks` (constructed decks only)
- `GET /api/decks?scope=draft`
- `GET /api/decks?scope=all`
- `GET /api/decks/:id`
- `GET /api/drafts`
- `GET /api/drafts/:id/picks`

## Frontend Setup

Requirements:
- Bun 1.3+

Commands:

```bash
cd /Users/cschnabel/dev/mtgdata/web
bun install
bun run dev
```

Vite dev server runs at `http://127.0.0.1:5173` and proxies `/api` to `http://127.0.0.1:8080`.

Production build:

```bash
cd /Users/cschnabel/dev/mtgdata/web
bun run build
```

When `web/dist` exists, backend `serve` will also host built assets from `/`.

## Notes

- Event aliasing is implemented for common Arena naming differences (e.g. `FIN_Quick_Draft` to `QuickDraft_FIN_...`).
- Draft parsing supports both `BotDraftDraftPick` and `EventPlayerDraftMakePick`.
- Deck card names are resolved on demand and cached in the local `card_catalog` table:
  - First from the local MTGA raw card DB (`Raw_CardDatabase*.mtga`) if found.
  - Then from Scryfall for any remaining unresolved IDs.
- Match detail (`GET /api/matches/:id`) includes a partial opponent list from public GRE game objects
  (cards seen on stack/battlefield/exile/graveyard/revealed zones).
- Match timeline (`GET /api/matches/:id/timeline`) includes first observed public card plays (both players)
  with turn/phase when available.
- You can override the raw card DB path with `MTGA_RAW_CARD_DB=/absolute/path/to/Raw_CardDatabase_*.mtga`.
