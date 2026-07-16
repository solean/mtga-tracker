package db

import (
	"context"
	"path/filepath"
	"testing"
)

func TestInitResetsIngestStateOnceForEconomyBackfill(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	database, err := Open(filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	if _, err := database.ExecContext(ctx, `
		CREATE TABLE ingest_state (
			log_path TEXT PRIMARY KEY,
			byte_offset INTEGER NOT NULL DEFAULT 0,
			line_no INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		);
		INSERT INTO ingest_state (log_path, byte_offset, line_no, updated_at)
		VALUES ('Player.log', 12345, 678, '2026-07-12T00:00:00Z');
	`); err != nil {
		t.Fatalf("seed legacy ingest state: %v", err)
	}

	if err := Init(ctx, database); err != nil {
		t.Fatalf("first Init: %v", err)
	}
	state, err := NewStore(database).GetIngestState(ctx, "Player.log")
	if err != nil {
		t.Fatalf("GetIngestState after first Init: %v", err)
	}
	if !state.Found || state.Offset != 0 || state.LineNo != 0 {
		t.Fatalf("state after first Init = %+v, want reset offsets", state)
	}

	if _, err := database.ExecContext(ctx, `
		UPDATE ingest_state
		SET byte_offset = 999, line_no = 42
		WHERE log_path = 'Player.log'
	`); err != nil {
		t.Fatalf("advance ingest state: %v", err)
	}
	if err := Init(ctx, database); err != nil {
		t.Fatalf("second Init: %v", err)
	}
	state, err = NewStore(database).GetIngestState(ctx, "Player.log")
	if err != nil {
		t.Fatalf("GetIngestState after second Init: %v", err)
	}
	if state.Offset != 999 || state.LineNo != 42 {
		t.Fatalf("state after second Init = %+v, want preserved offsets", state)
	}
}
