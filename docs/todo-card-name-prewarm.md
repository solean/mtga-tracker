# TODO: Optional Card Name Prewarm at Startup

## Status

Not implemented. Current behavior remains lazy card-name resolution on `GET /api/decks/:id`.

## Why

Today, first load of a deck can trigger on-demand card-name resolution for cache misses.
This is correct, but can add latency to the first request.

## Goal

Add an optional startup/background prewarm that fills `card_catalog` for known deck card IDs, while keeping lazy resolution as the default path.

## Proposed behavior

1. On server startup, if prewarm is enabled, run a background task.
2. Query distinct `deck_cards.card_id` values missing in `card_catalog`.
3. Resolve names in bulk using existing order:
   - local MTGA raw DB (`Raw_CardDatabase*.mtga`)
   - Scryfall fallback for unresolved IDs
4. Upsert resolved names into `card_catalog`.
5. Keep existing lazy enrichment in deck-detail handler unchanged.

## Config proposal

- `CARD_NAME_PREWARM` (default: `false`)
  - `true`: run background prewarm after server starts.
- Reuse existing `MTGA_RAW_CARD_DB` override if set.

## Implementation sketch

- `internal/db/store.go`
  - Add helper to list missing distinct card IDs from `deck_cards` vs `card_catalog`.
- `internal/api/server.go`
  - Add `startCardNamePrewarm(ctx)` background task from `Run(...)` when enabled.
  - Reuse existing resolver functions and cache upsert logic.
  - Add bounded batch size + timeout-aware requests.

## Acceptance criteria

1. With prewarm enabled, `card_catalog` is populated shortly after startup without a deck-detail request.
2. Startup still succeeds if MTGA raw DB and/or Scryfall are unavailable (best effort, logged).
3. With prewarm disabled, behavior is unchanged from today.

## Non-goals

- No blocking startup path for prewarm.
- No schema changes required.
