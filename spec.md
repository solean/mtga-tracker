# MTGA Log Parser Spec (Planning Draft)

## 1) Problem Statement
Build a local program that parses MTG Arena `Player.log` / `Player-prev.log` files and stores structured gameplay data similar to tracker products (for example: match results, decks used, draft picks, event run progress).

Primary emphasis for this project:
- Reliable match/result extraction
- Strong draft support (Quick Draft, Premier Draft, Bot Draft / Player Draft)
- Incremental ingestion so repeated runs only parse new data

## 2) Goals
- Parse Arena logs into normalized records:
  - Matches
  - Games
  - Deck snapshots used in events/matches
  - Draft sessions and picks
  - Event runs (wins/losses and payouts)
- Support historical backfill from large files and live append parsing.
- Keep raw source snippets and offsets for traceability/debugging.
- Provide an extensible foundation for future analytics and UI.
- Ship a local MVP frontend to browse and visualize parsed data.

## 3) Future Goals (Post-MVP)
- Real-time overlay or in-game companion UI.
- Deck winrate metagame modeling from external population data.
- Full card text enrichment (can be added later via card DB join).
- Multi-user cloud sync/auth.

## 4) Source Data Characteristics (from sample log)
- Log has mixed plain text, structured JSON, and RPC-style envelopes.
- Key patterns:
  - Outgoing requests: `[UnityCrossThreadLogger]==> <Method> { ... }`
  - Request completion: `<== <Method>(<id>)`
  - Module payloads containing event/deck/draft state:
    - `CurrentModule` values such as `BotDraft`, `PlayerDraft`, `CreateMatch`, `Complete`
  - Match engine payloads (`greToClientEvent`) with deep game state and actions.
- High-value objects observed:
  - `EventJoin`, `EventEnterPairing`, `EventSetDeckV2`, `EventClaimPrize`
  - `EventPlayerDraftMakePick`, `BotDraftDraftPick`, `DraftCompleteDraft`
  - `InventoryInfo` / `DTO_InventoryInfo`
  - Match telemetry in `LogBusinessEvents` (match start/end, outcomes, interaction stats)
  - GRE stream with `matchId`, players, zones, turn/phase, actions

## 5) Proposed Output: Data Model

### 5.1 Core tables/entities
1. `sessions`
- `id` (uuid)
- `log_path`
- `client_version`
- `platform`
- `region`
- `started_at`
- `account_id`
- `persona_id`

2. `ingestion_runs`
- `id`
- `session_id`
- `file_inode`
- `file_size_bytes`
- `started_at`
- `completed_at`
- `start_offset`
- `end_offset`
- `status`
- `error`

3. `events_raw`
- `id`
- `session_id`
- `ingestion_run_id`
- `line_no`
- `byte_offset`
- `event_type` (enum-like string)
- `method_name`
- `request_id`
- `payload_json` (json)
- `raw_text` (optional for debug)

4. `matches`
- `id` (internal UUID)
- `arena_match_id` (string UUID from logs)
- `session_id`
- `event_name` (e.g. `QuickDraft_FIN_20250619`)
- `format`
- `queue_type` (`ranked`, `event`, `play`, etc, derived)
- `opponent_name` (if available)
- `opponent_user_id` (if available)
- `player_seat_id`
- `started_at`
- `ended_at`
- `result` (`win`/`loss`/`unknown`)
- `win_reason` (`Concede`, `Damage`, etc)
- `seconds_count`
- `turn_count`

5. `games`
- `id`
- `match_id` (fk to `matches`)
- `game_number`
- `started_at`
- `ended_at`
- `result`
- `on_play` (bool, if derivable)
- `mulligan_count`

6. `decks`
- `id`
- `arena_deck_id`
- `name`
- `format`
- `last_updated`
- `source` (`event_set_deck`, `course_snapshot`, etc)

7. `deck_cards`
- `id`
- `deck_id`
- `section` (`main`, `sideboard`, `companion`, `command`)
- `card_id` (Arena grpId/int)
- `quantity`

8. `match_decks`
- `id`
- `match_id`
- `deck_id`
- `snapshot_reason` (`pre_match`, `event_submit`, `course_snapshot`)

9. `event_runs`
- `id`
- `event_name`
- `event_type` (`quick_draft`, `premier_draft`, etc derived)
- `entry_currency_type`
- `entry_currency_paid`
- `started_at`
- `ended_at`
- `wins`
- `losses`
- `status` (`active`, `completed`, `claimed`)

10. `draft_sessions`
- `id`
- `event_run_id` (nullable if not reconstructable)
- `event_name`
- `draft_id` (for player draft)
- `is_bot_draft`
- `started_at`
- `completed_at`

11. `draft_picks`
- `id`
- `draft_session_id`
- `pack_number`
- `pick_number`
- `picked_card_ids` (json array, usually 1 item)
- `pack_card_ids` (json array if available)
- `pick_ts`

12. `draft_pool_cards`
- `id`
- `draft_session_id`
- `card_id`
- `quantity`

13. `economy_snapshots` (optional V1, useful for audit)
- `id`
- `session_id`
- `ts`
- `gold`
- `gems`
- `wildcard_common`
- `wildcard_uncommon`
- `wildcard_rare`
- `wildcard_mythic`
- `vault_progress`

### 5.2 Storage engine recommendation
- SQLite for V1:
  - Local-first
  - Simple deployment
  - Good enough performance for this workload
  - Easy to inspect via CLI/DB browser

## 6) Parser Architecture

### 6.1 Pipeline stages
1. `reader`
- Streams file line-by-line
- Tracks byte offset and line number
- Supports resume from last offset

2. `line classifier`
- Fast regex checks to classify line:
  - `outgoing_method`
  - `incoming_method_complete`
  - `json_blob`
  - `noise`

3. `extractors`
- Method-specific handlers for:
  - Event joins/pairing/claims
  - Deck submissions
  - Draft picks/status
  - Match/game outcomes
  - GRE match metadata
- Emit typed internal events

4. `reconciler`
- Correlates events into cohesive objects:
  - Associate picks to draft session
  - Associate match start/end with same `arena_match_id`
  - Resolve deck snapshot closest to match start

5. `writer`
- Upserts into SQLite in transaction batches
- Stores raw fallback event when parser cannot fully classify

### 6.2 Parser mode
- `backfill` mode: parse full file from start
- `tail` mode: watch file for appended lines and parse incrementally

## 7) Matching / Correlation Strategy

### 7.1 Keys used for correlation
- `arena_match_id` (strong key for matches)
- RPC method request IDs (`id` fields) for request/response pairing
- `draft_id` (for player draft)
- `event_name` + timestamp windows (for bot draft and event state transitions)

### 7.2 Fallback heuristics
- If no explicit match-end event:
  - Infer from scene transition + next matchmaking request + outcome telemetry.
- If no explicit draft session start:
  - Start when first pick appears after `EventJoin` into draft event.

## 8) Draft-Focused Requirements (High Priority)
- Capture every pick in order.
- Capture pack contents when available.
- Capture final submitted deck and sideboard.
- Persist event run state (wins/losses after each match).
- Handle both:
  - Bot draft logs (`BotDraftDraftPick`, status payloads)
  - Human draft logs (`EventPlayerDraftMakePick`, `DraftCompleteDraft`)

## 9) Suggested Tech Stack
### 9.1 Parser/backend
- Language:
  - Preferred: TypeScript/Node.js or Python
  - Both are good; pick based on your preferred tooling.
- Libraries:
  - Regex + JSON parsing
  - SQLite library (`better-sqlite3` for Node or `sqlite3` builtin for Python)
  - Optional validation (`zod` / `pydantic`) for parsed event shapes
- CLI:
  - `parse <logfile>`
  - `tail <logfile>`
  - `status`
  - `export --format csv|json`

### 9.2 Frontend (recommended for MVP)
- Framework: React + Vite + TypeScript
- Data fetching/state: TanStack Query
- Routing: React Router
- UI: Tailwind CSS + shadcn/ui
- Table/grid: TanStack Table
- Charts: Apache ECharts
- Delivery model:
  - Backend serves JSON endpoints from SQLite.
  - Frontend runs locally and consumes the same API.

### 9.3 Why this frontend choice
- Fast local development and hot reload.
- Good control over data-heavy views (match history, draft pick timelines).
- Easy to grow from MVP into a richer product without replatforming.

## 10) Data Quality and Reliability
- Track parser confidence:
  - `exact` (explicit field match)
  - `derived` (heuristic correlation)
  - `unknown`
- Keep raw event fallback to enable reparsing with improved logic.
- Version the parser schema:
  - `parser_version`
  - migration scripts for DB schema updates

## 11) Privacy/Security Considerations
- Logs contain account identifiers and opponent names.
- Default behavior should be local-only storage.
- If sharing/exporting, support redaction options:
  - Hash account IDs
  - Drop opponent identifiers

## 12) V1 Milestones

### Milestone 1: Foundation
- CLI scaffold
- SQLite schema v1
- Raw event ingestion (`events_raw`)
- Incremental offset tracking

### Milestone 2: Match + Deck
- Parse match start/end
- Parse event joins and outcomes
- Parse `EventSetDeckV2` and course deck snapshots
- Link deck snapshot to match

### Milestone 3: Draft
- Parse bot and player draft picks
- Build draft session timelines
- Persist draft pool and final submitted deck
- Emit draft summary views

### Milestone 4: Reporting + Frontend MVP
- Backend query endpoints:
  - Match history by format/event
  - Deck win/loss summary
  - Draft pick logs and run outcomes
- Frontend pages:
  - Overview dashboard (recent matches, winrate, active event runs)
  - Match history table (filters for format/event/deck/result)
  - Deck detail page (matchups + trend)
  - Draft run page (pick timeline, deck submitted, results)

## 13) Suggested Query/API Outputs
- `latest_matches` view:
  - date, event, result, turn_count, duration, opponent
- `deck_performance` view:
  - deck_name, format, matches, wins, losses, winrate
- `draft_runs` view:
  - event_name, started_at, wins, losses, status
- `draft_picks_timeline` view:
  - draft_session_id, pack, pick, picked_card_id

## 14) Testing Strategy
- Build fixture logs from real snippets (sanitized).
- Unit tests per extractor:
  - EventJoin extractor
  - EventSetDeckV2 extractor
  - Draft pick extractor (bot/player)
  - Match result extractor
- Integration tests:
  - Full parse of sample log -> assert record counts + key fields
- Regression tests:
  - Store tricky snippets that previously broke parsing.

## 15) Risks / Unknowns
- MTGA log format can change with client updates.
- Some fields are only available in certain queues/events.
- Response payloads can be huge and may span lines in unusual ways.
- Mapping card IDs to card metadata needs external data source (future task).

## 16) Open Questions for Discussion
1. Preferred implementation language (TypeScript vs Python)?
2. Confirm frontend stack: React/Vite/TanStack/ECharts?
3. Should V1 include live tailing while Arena is open, or backfill-only first?
4. Do you want per-game action timelines in V1, or just game-level outcomes?
5. Should we include collection/economy history from day one?
6. Any priority formats/events beyond draft and ranked constructed?

## 17) Recommended Next Step
After approval of this spec, implement Milestone 1 + Milestone 2 first, then add Draft (Milestone 3) immediately after to maximize value for your use case.
