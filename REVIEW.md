# Ponder — Code & Design Review

*Reviewed June 2026. Covers architecture, code quality, design (UI screenshots), and a feature roadmap.*

Status markers reflect work completed since the review:
- ✅ done · 🔲 open

---

## TL;DR

A genuinely solid foundation — much further along than a typical MVP. The parser is well-tested, the schema is thoughtful, the replay feature is ambitious and working, and the visual identity is distinctive. The three biggest risks at review time:

1. **Replay storage did not scale** — 447MB for 73 matches (~6MB/match). ✅ *Fixed: zstd archive compaction, 447MB → 8.3MB (~54x).*
2. **The local API was wide open** — CORS `*` on a fixed localhost port meant any website could read match history. ✅ *Fixed: same-origin via Wails asset server, localhost-only CORS, Host-header check.*
3. **`MatchDetailPage.tsx` is ~4,100 lines** and will become the place features go to die. 🔲

On the desktop question: **stay with Wails.** Electron buys nothing here except a 150MB install and a second runtime; Tauri would mean rewriting the backend bridge in Rust for no benefit since the domain logic is Go.

---

## Desktop shell (Wails)

- ✅ **Wails bridge / hardcoded port** — was a localhost HTTP server on hardcoded `127.0.0.1:39123` (port collisions, silent failure on second instance). *Now the API is mounted on the Wails asset server as middleware — same-origin, no port. Dev builds (`wails dev`) additionally auto-start a localhost listener on 39123 for browser-based frontend dev (`PONDER_DEV_API` overrides).*
- ✅ **Security** — `withCORS` set `Access-Control-Allow-Origin: *` on an unauthenticated API serving match history and accepting config-changing POSTs. *Now CORS is only reflected for localhost dev origins, and the standalone listener rejects non-local Host headers (DNS-rebinding defense).*
- ✅ **Silent startup failures** — every error path in `startup()` just logged and returned, leaving an eternally-loading UI. *Now failures show a native error dialog and the API middleware returns 503 with the real error.*
- ✅ **Desktop niceties** — *added: single-instance lock (second launch focuses the window), hide-on-close (tailer keeps running; quit with Cmd+Q), launch-at-login via macOS LaunchAgent (Settings toggle), and a GitHub-releases update check with version display.*
- 🔲 **Tray icon** — needs Wails v3; hide-on-close is the v2 stand-in.
- 🔲 **Auto-update install** — currently check-only; actual download/install flow later.

## Replay storage ✅ (implemented)

The original design stored a **full denormalized board snapshot per frame** (row per frame + row per object per frame): ~500 frames and ~7,000 object rows per match, 264MB of `match_replay_frame_objects` + 139MB of `match_replay_frames` for 73 matches. At a few thousand matches/year that's a 10–20GB/year database, and `/api/matches/:id/replay` shipped it all as one pretty-printed JSON response.

Implemented fix:
- Frames still stream into row tables while a match is live (incremental parse/resume unchanged); on match completion they're serialized, zstd-compressed (consecutive frames are nearly identical), stored as one blob per match in `match_replay_archives`, and the rows are deleted.
- Reads merge archive + any live rows; API response shape unchanged.
- Startup compaction + `VACUUM` migrates existing databases; `ponder compact -db <path>` for manual runs.
- Dropped pretty-printed JSON and gzipped `/api/` responses (heaviest replay endpoint: 63.7MB → 3.9MB over the wire).
- Verified byte-identical output on real data; fixed nondeterministic `changes` ordering found during verification.

Still open:
- 🔲 **Schema migrations** — `schema.sql` is `CREATE TABLE IF NOT EXISTS` plus ad-hoc column checks; add a `schema_version` row and ordered migrations before real users have databases that can't be regenerated.
- 🔲 **Retention policy setting** ("keep full replays for 90 days, keep timelines forever").
- 🔲 **Paginate replay by game** so the replay tab loads game 1 instantly.

## Backend code quality

Mostly good news: idiomatic Go, real tests across parser/db/api, transactions used properly, resumable ingestion with byte offsets, and the event-alias/draft-repair logic shows attention to the messy reality of Arena logs.

- ✅ **Split the megafiles** — *done: `parser.go` (2,463 lines) → core `parser.go` (829) + `gre.go` / `match.go` / `rank.go` / `draft.go`; `store.go` (3,037 lines) → core `store.go` (221) + `store_matches.go` / `store_replay.go` / `store_drafts.go` / `store_decks.go` / `store_rank.go` / `store_events.go` / `store_cards.go`. Pure mechanical move, no behavior change.*
- 🔲 **Live updates are poll-only** — only the Settings page polls (3s). During a live match the Matches page and Overview are stale. Use `runtime.EventsEmit` from the tailer and a frontend hook that invalidates React Query caches. This is the difference between "feels live" and "feels like a database viewer."
- 🔲 **Parser does not auto-start** — live tracking state is in-memory only; on launch nothing ingests until the user presses Start. A tracker should catch up (incremental import) and start tailing on launch, with a persisted `liveEnabled` config flag.
- 🔲 **Extract card-name resolution** — half of `internal/api/server.go` is enrichment (MTGA raw card DB → Scryfall → cache). Move to an `internal/cards` package and pre-warm at ingest time (see `docs/todo-card-name-prewarm.md`).
- 🔲 **`events_raw` retention** — small now but grows forever; add pruning or a debug toggle.

## Frontend code quality

- 🔲 **`MatchDetailPage.tsx` (~4,100 lines)** — extract `lib/replay/` (pure functions: frame filtering, annotation parsing, game summaries — eminently unit-testable), and `components/replay/` (Board, ReplayControls, TurnGrid). The pure-function extraction is the highest-value refactor in the repo.
- 🔲 **Frontend testing** — one test file (`rankProgress.test.ts`), no test runner in package.json. Wire up vitest and point it at the extracted replay logic.
- ✅ **Matches table** — *done: row virtualization via `@tanstack/react-virtual`. Group headers and match rows flatten into one virtualized list (~22 DOM rows regardless of total), scoped to a `.data-table.is-virtual` flex-layout modifier so the 5 other pages using `.data-table` are untouched. Sticky opaque header, stable column widths from column sizes, click/keyboard nav preserved.*
- 🔲 **Local card database** — Scryfall previews are fetched per-card at hover time. Import Scryfall bulk data (`default_cards`) into SQLite at first run and cache images on disk: offline-friendly, instant previews, and it unlocks most analytics features below.
- 🔲 **Plasma background** — 60-iteration raymarch per pixel, every frame, forever; real battery drain. Pause when the window is unfocused; add a "reduce effects" setting.

## Design review (from screenshots)

**Working well:** the amber-on-black terminal aesthetic is distinctive and consistent; stat-card hierarchy on Overview; turn-chip grid with step indicators; WIN/LOSS pills; board view with real card images and tapped/summoning-sick badges.

Issues, roughly by severity:

1. ✅ **Mono-everything fights data density.** *Done: introduced a CSS type-system (`--font-sans`/`--font-mono`/`--font-display`/`--font-brand`) and switched the body/content layer from the wide squarish Chakra Petch to a humanist sans (Inter), so table body text and card names read denser. Mono (IBM Plex Mono) is kept for column headers, stats (metric numbers, quantities), and labels; Rajdhani stays for display headings; Chakra Petch is retained on the nav tabs and brand eyebrow.*
2. ✅ **Match history needs filtering and aggregation.** *Done: filter bar (opponent search, event, deck, result, your-deck color chips, date range), header summary with filtered record/win rate, and group-by-event session headers with running records ("QuickDraft_TMT — 7-2 — 9 matches"), toggleable.*
3. 🔲 **"G1: Play/Draw" reads as a result.** "Draw" sits in the same scan-line as WIN/LOSS pills and means something else. Rename to OTP/OTD or use glyphs.
4. 🔲 **Replay step noise.** "You moved Turtle Van from Hand to Hand", "Tainted Treats from Limbo to Limbo" are GRE artifacts — coalesce or hide behind a "show all steps" toggle. Every visible step should be something a human would narrate.
5. 🔲 **Replay controls.** Add a timeline scrubber (one tick per step, colored by event type), keyboard shortcuts (←/→ step, Shift+←/→ turn, Space play/pause), adjustable autoplay speed. Rename the "T?" chip to "Pre-game".
6. 🔲 **Life totals are buried.** Persistent header strip with both players' life and delta flashes, plus a clickable life-total sparkline across the game — the fastest "what happened in this game?" affordance.
7. ✅ **Event names are raw IDs.** *Done: a shared `lib/events.ts` parses Arena event IDs into a friendly kind + set code + date; `<EventLabel>` renders "Quick Draft · Final Fantasy" with the set symbol across Matches, Drafts, Decks, Overview, Deck/Match detail, and the rank tooltip. Set names/symbols come from Scryfall (`/api/sets?codes=…`), cached locally in `set_catalog` (mirrors `card_catalog`), so they work offline after first fetch; symbols are Scryfall SVGs rendered as CSS masks so they pick up the theme color. Raw IDs are preserved as hover titles.*
8. 🔲 **Overview is thin** relative to the data available: win rate by deck / color pair / play-draw / event type, current streak, form over last 20.

## Feature roadmap (suggested order)

1. ✅ **Live "now playing" experience** — *Done (v1): a global `<LiveMatchBanner>` (in `Layout`, under the nav) shows the in-progress match — opponent, event + set symbol, your deck, game/turn, opponent revealed cards, and estimated draw odds. Backed by `GET /api/live` (`internal/api/live.go` + `internal/db/store_live.go`), which surfaces the most recent match with no result/ended_at (recency-bounded). Refresh is ~2s polling (paused when the tab is hidden, slow idle poll); on match start/end it invalidates the matches/overview caches so the rest of the app refreshes. Draw odds are a labeled best-effort estimate (hypergeometric vs the decklist with library = deck − 7 − turns; the log doesn't expose your hand). Follow-ups: Wails `EventsEmit` push instead of polling; land/curve-aware odds once a local card DB exists; the banner only populates while live tracking is on (see parser auto-start item).*
2. 🔲 **Replay polish** — scrubber, keyboard nav, life sparkline, coalesced steps, combat arrows (attack/block state and target IDs are already stored per object).
3. 🔲 **Local card database** (Scryfall bulk import) — prerequisite for most analytics.
4. 🔲 **Deck analytics** — per-card stats from your own matches: win rate when drawn / in opener, mulligan rates, average turn played vs. curve. `match_card_plays` already supports this; mostly SQL.
5. 🔲 **Draft analytics** — full pack contents per pick are stored, which is gold: pick-order review ("what did I pass?"), color-commitment timeline, optional 17Lands win-rate overlay.
6. 🔲 **Opponent meta** — archetype-cluster observed opponent cards ("faced Dimir Midrange 9 times, went 4-5"); color-pair + key-card heuristics get far.
7. 🔲 **Collection tracking** — `InventoryInfo` is already in the logs; wildcards, set completion, "can I build this deck?"
8. 🔲 **Export/share** — deck export in Arena import format (table stakes), match CSV, eventually shareable replays (the format is self-contained).
9. 🔲 **In-game overlay** — biggest retention feature for trackers but a platform-specific rabbit hole; likely a separate overlay process, possibly post-Wails-v3.

## Housekeeping

- 🔲 `data/` holds many scratch DB variants with stale WAL files (gitignored) — worth pruning locally.
- ✅ README desktop documentation refreshed (asset-server API, dev workflow, desktop behaviors, compaction).
- 🔲 `main.go` embeds `web/dist`, so a stale `bun run build` silently ships old UI into the binary — a `wails build` pre-hook already rebuilds, but raw `go build` does not.
- Note: raw `go build -tags desktop,production` on newer macOS SDKs needs `CGO_LDFLAGS="-framework UniformTypeIdentifiers"` (the `wails` CLI handles it automatically).
