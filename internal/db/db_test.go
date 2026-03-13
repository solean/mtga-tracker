package db

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
)

func TestMigrateMatchObservationTablesRepairsReplayObjectForeignKey(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	db := openTempSQLiteDB(t)

	mustExec(t, db, `CREATE TABLE matches (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		arena_match_id TEXT,
		player_seat_id INTEGER
	)`)
	mustExec(t, db, `CREATE TABLE match_card_plays (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		match_id INTEGER NOT NULL,
		game_number INTEGER NOT NULL DEFAULT 1,
		instance_id INTEGER NOT NULL,
		card_id INTEGER NOT NULL,
		owner_seat_id INTEGER,
		first_public_zone TEXT,
		turn_number INTEGER,
		phase TEXT,
		source TEXT,
		played_at TEXT,
		created_at TEXT NOT NULL
	)`)
	mustExec(t, db, `CREATE TABLE match_opponent_card_instances (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		match_id INTEGER NOT NULL,
		game_number INTEGER NOT NULL DEFAULT 1,
		instance_id INTEGER NOT NULL,
		card_id INTEGER NOT NULL,
		source TEXT,
		first_seen_at TEXT,
		created_at TEXT NOT NULL
	)`)
	mustExec(t, db, `CREATE TABLE match_replay_frames (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		match_id INTEGER NOT NULL,
		game_number INTEGER NOT NULL DEFAULT 1,
		game_state_id INTEGER,
		prev_game_state_id INTEGER,
		game_state_type TEXT,
		turn_number INTEGER,
		phase TEXT,
		player_life_totals_json TEXT,
		source TEXT,
		recorded_at TEXT,
		actions_json TEXT,
		annotations_json TEXT,
		created_at TEXT NOT NULL,
		UNIQUE(match_id, game_number, game_state_id),
		FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
	)`)
	mustExec(t, db, `CREATE TABLE match_replay_frame_objects (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		frame_id INTEGER NOT NULL,
		instance_id INTEGER NOT NULL,
		card_id INTEGER NOT NULL,
		owner_seat_id INTEGER,
		controller_seat_id INTEGER,
		zone_id INTEGER,
		zone_type TEXT NOT NULL,
		zone_position INTEGER,
		visibility TEXT,
		power INTEGER,
		toughness INTEGER,
		is_tapped INTEGER NOT NULL DEFAULT 0,
		has_summoning_sickness INTEGER NOT NULL DEFAULT 0,
		attack_state TEXT,
		attack_target_id INTEGER,
		block_state TEXT,
		block_attacker_ids_json TEXT,
		counter_summary_json TEXT,
		details_json TEXT,
		is_token INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		UNIQUE(frame_id, instance_id),
		FOREIGN KEY(frame_id) REFERENCES match_replay_frames_old(id) ON DELETE CASCADE
	)`)

	mustExec(t, db, `INSERT INTO matches (id, arena_match_id, player_seat_id) VALUES (1, 'match-1', 1)`)
	mustExec(t, db, `INSERT INTO match_replay_frames (
		id, match_id, game_number, game_state_id, created_at
	) VALUES (1, 1, 1, 10, '2026-03-12T01:40:00Z')`)
	mustExec(t, db, `INSERT INTO match_replay_frame_objects (
		id, frame_id, instance_id, card_id, zone_type, created_at
	) VALUES (1, 1, 1001, 2001, 'battlefield', '2026-03-12T01:40:00Z')`)

	if err := migrateMatchObservationTables(ctx, db); err != nil {
		t.Fatalf("migrateMatchObservationTables: %v", err)
	}

	assertReplayObjectFKTarget(t, db, "match_replay_frames")

	if _, err := db.ExecContext(ctx, `DELETE FROM match_replay_frame_objects WHERE frame_id = 1`); err != nil {
		t.Fatalf("delete repaired replay frame objects: %v", err)
	}
}

func TestMigrateMatchObservationTablesRebuildsReplayFramesBeforeRepairingReplayObjects(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	db := openTempSQLiteDB(t)

	mustExec(t, db, `CREATE TABLE matches (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		arena_match_id TEXT,
		player_seat_id INTEGER
	)`)
	mustExec(t, db, `CREATE TABLE match_card_plays (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		match_id INTEGER NOT NULL,
		instance_id INTEGER NOT NULL,
		card_id INTEGER NOT NULL,
		owner_seat_id INTEGER,
		first_public_zone TEXT,
		turn_number INTEGER,
		phase TEXT,
		source TEXT,
		played_at TEXT,
		created_at TEXT NOT NULL
	)`)
	mustExec(t, db, `CREATE TABLE match_opponent_card_instances (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		match_id INTEGER NOT NULL,
		instance_id INTEGER NOT NULL,
		card_id INTEGER NOT NULL,
		source TEXT,
		first_seen_at TEXT,
		created_at TEXT NOT NULL
	)`)
	mustExec(t, db, `CREATE TABLE match_replay_frames (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		match_id INTEGER NOT NULL,
		game_number INTEGER NOT NULL DEFAULT 1,
		game_state_id INTEGER,
		prev_game_state_id INTEGER,
		game_state_type TEXT,
		turn_number INTEGER,
		phase TEXT,
		source TEXT,
		recorded_at TEXT,
		actions_json TEXT,
		annotations_json TEXT,
		created_at TEXT NOT NULL,
		UNIQUE(match_id, game_number, game_state_id),
		FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
	)`)
	mustExec(t, db, `CREATE TABLE match_replay_frame_objects (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		frame_id INTEGER NOT NULL,
		instance_id INTEGER NOT NULL,
		card_id INTEGER NOT NULL,
		owner_seat_id INTEGER,
		controller_seat_id INTEGER,
		zone_id INTEGER,
		zone_type TEXT NOT NULL,
		zone_position INTEGER,
		visibility TEXT,
		power INTEGER,
		toughness INTEGER,
		is_tapped INTEGER NOT NULL DEFAULT 0,
		has_summoning_sickness INTEGER NOT NULL DEFAULT 0,
		attack_state TEXT,
		attack_target_id INTEGER,
		block_state TEXT,
		block_attacker_ids_json TEXT,
		counter_summary_json TEXT,
		details_json TEXT,
		is_token INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		UNIQUE(frame_id, instance_id),
		FOREIGN KEY(frame_id) REFERENCES match_replay_frames(id) ON DELETE CASCADE
	)`)

	mustExec(t, db, `INSERT INTO matches (id, arena_match_id, player_seat_id) VALUES (1, 'match-2', 1)`)
	mustExec(t, db, `INSERT INTO match_replay_frames (
		id, match_id, game_number, game_state_id, created_at
	) VALUES (1, 1, 1, 12, '2026-03-12T01:41:00Z')`)
	mustExec(t, db, `INSERT INTO match_replay_frame_objects (
		id, frame_id, instance_id, card_id, zone_type, created_at
	) VALUES (1, 1, 1002, 2002, 'stack', '2026-03-12T01:41:00Z')`)

	if err := migrateMatchObservationTables(ctx, db); err != nil {
		t.Fatalf("migrateMatchObservationTables: %v", err)
	}

	if hasLifeTotals, err := tableHasColumn(ctx, db, "match_replay_frames", "player_life_totals_json"); err != nil {
		t.Fatalf("tableHasColumn(match_replay_frames.player_life_totals_json): %v", err)
	} else if !hasLifeTotals {
		t.Fatalf("expected player_life_totals_json to exist after migration")
	}

	assertReplayObjectFKTarget(t, db, "match_replay_frames")

	if _, err := db.ExecContext(ctx, `DELETE FROM match_replay_frame_objects WHERE frame_id = 1`); err != nil {
		t.Fatalf("delete replay frame objects after frame rebuild: %v", err)
	}
}

func openTempSQLiteDB(t *testing.T) *sql.DB {
	t.Helper()

	path := filepath.Join(t.TempDir(), "test.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open(%s): %v", path, err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func assertReplayObjectFKTarget(t *testing.T, db *sql.DB, want string) {
	t.Helper()

	ctx := context.Background()
	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_list(match_replay_frame_objects)`)
	if err != nil {
		t.Fatalf("foreign_key_list(match_replay_frame_objects): %v", err)
	}
	defer rows.Close()

	found := false
	for rows.Next() {
		var (
			id       int
			seq      int
			refTable string
			fromCol  string
			toCol    string
			onUpdate string
			onDelete string
			match    string
		)
		if err := rows.Scan(&id, &seq, &refTable, &fromCol, &toCol, &onUpdate, &onDelete, &match); err != nil {
			t.Fatalf("scan foreign key row: %v", err)
		}
		if refTable == want {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate foreign key rows: %v", err)
	}
	if !found {
		t.Fatalf("expected match_replay_frame_objects to reference %q", want)
	}
}

func mustExec(t *testing.T, db *sql.DB, stmt string) {
	t.Helper()

	if _, err := db.Exec(stmt); err != nil {
		t.Fatalf("exec %s: %v", fmt.Sprintf("%.80s", stmt), err)
	}
}
