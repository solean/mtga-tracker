package db

import (
	"context"
	"testing"
)

func TestMatchListDerivesBestOfAndPlayDraw(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	database := openTempSQLiteDB(t)
	if err := Init(ctx, database); err != nil {
		t.Fatalf("Init: %v", err)
	}

	store := NewStore(database)
	tx, err := store.BeginTx(ctx)
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}

	if _, err := store.UpsertMatchStart(ctx, tx, "match-bo3", "Some_Event", 2, "2026-03-12T19:06:52Z"); err != nil {
		t.Fatalf("UpsertMatchStart(match-bo3): %v", err)
	}
	if err := store.UpsertMatchCardPlay(ctx, tx, "match-bo3", 1, 101, 5001, 1, 1, "main1", "battlefield", "2026-03-12T19:07:00Z", "test"); err != nil {
		t.Fatalf("UpsertMatchCardPlay(match-bo3 game 1): %v", err)
	}
	if err := store.UpsertMatchCardPlay(ctx, tx, "match-bo3", 2, 102, 5002, 1, 1, "main1", "battlefield", "2026-03-12T19:17:00Z", "test"); err != nil {
		t.Fatalf("UpsertMatchCardPlay(match-bo3 game 2): %v", err)
	}

	if _, err := store.UpsertMatchStart(ctx, tx, "match-bo1", "PremierDraft_ABC", 1, "2026-03-12T20:06:52Z"); err != nil {
		t.Fatalf("UpsertMatchStart(match-bo1): %v", err)
	}
	if err := store.UpsertMatchCardPlay(ctx, tx, "match-bo1", 1, 201, 6001, 1, 2, "main1", "battlefield", "2026-03-12T20:07:00Z", "test"); err != nil {
		t.Fatalf("UpsertMatchCardPlay(match-bo1 game 1): %v", err)
	}

	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	rows, err := store.ListMatches(ctx, 10, "", "")
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("len(ListMatches) = %d, want 2", len(rows))
	}

	byArenaID := make(map[string]struct {
		id       int64
		bestOf   string
		playDraw string
	}, len(rows))
	for _, row := range rows {
		byArenaID[row.ArenaMatchID] = struct {
			id       int64
			bestOf   string
			playDraw string
		}{
			id:       row.ID,
			bestOf:   row.BestOf,
			playDraw: row.PlayDraw,
		}
	}

	if got := byArenaID["match-bo3"]; got.bestOf != "bo3" || got.playDraw != "draw" {
		t.Fatalf("match-bo3 derived values = %+v, want bestOf=bo3 playDraw=draw", got)
	}
	if got := byArenaID["match-bo1"]; got.bestOf != "bo1" || got.playDraw != "draw" {
		t.Fatalf("match-bo1 derived values = %+v, want bestOf=bo1 playDraw=draw", got)
	}

	detail, err := store.GetMatchDetail(ctx, byArenaID["match-bo3"].id)
	if err != nil {
		t.Fatalf("GetMatchDetail(match-bo3): %v", err)
	}
	if detail.Match.BestOf != "bo3" || detail.Match.PlayDraw != "draw" {
		t.Fatalf("match detail derived values = %+v, want bestOf=bo3 playDraw=draw", detail.Match)
	}
}
