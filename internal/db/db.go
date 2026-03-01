package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"strings"
)

import _ "modernc.org/sqlite"

//go:embed schema.sql
var schemaFS embed.FS

func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	db.SetMaxOpenConns(1)

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	return db, nil
}

func Init(ctx context.Context, db *sql.DB) error {
	schema, err := schemaFS.ReadFile("schema.sql")
	if err != nil {
		return fmt.Errorf("read schema: %w", err)
	}

	if _, err := db.ExecContext(ctx, string(schema)); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}

	if err := migrateMatchObservationTables(ctx, db); err != nil {
		return err
	}

	return nil
}

func migrateMatchObservationTables(ctx context.Context, db *sql.DB) error {
	hasGameNo, err := tableHasColumn(ctx, db, "match_card_plays", "game_number")
	if err != nil {
		return fmt.Errorf("inspect match_card_plays schema: %w", err)
	}
	if !hasGameNo {
		if err := rebuildMatchCardPlaysTable(ctx, db); err != nil {
			return err
		}
	}

	hasOpponentGameNo, err := tableHasColumn(ctx, db, "match_opponent_card_instances", "game_number")
	if err != nil {
		return fmt.Errorf("inspect match_opponent_card_instances schema: %w", err)
	}
	if !hasOpponentGameNo {
		if err := rebuildMatchOpponentCardInstancesTable(ctx, db); err != nil {
			return err
		}
	}

	return nil
}

func tableHasColumn(ctx context.Context, db *sql.DB, tableName, columnName string) (bool, error) {
	query := fmt.Sprintf(`PRAGMA table_info(%s)`, tableName)
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return false, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			cid        int
			name       string
			columnType string
			notNull    int
			defaultVal sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultVal, &pk); err != nil {
			return false, err
		}
		if strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(columnName)) {
			return true, nil
		}
	}

	if err := rows.Err(); err != nil {
		return false, err
	}
	return false, nil
}

func rebuildMatchCardPlaysTable(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migrate match_card_plays: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	steps := []string{
		`ALTER TABLE match_card_plays RENAME TO match_card_plays_old`,
		`DROP INDEX IF EXISTS idx_match_card_plays_match_id`,
		`DROP INDEX IF EXISTS idx_match_card_plays_card_id`,
		`DROP INDEX IF EXISTS idx_match_card_plays_turn_order`,
		`CREATE TABLE match_card_plays (
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
			created_at TEXT NOT NULL,
			UNIQUE(match_id, game_number, instance_id),
			FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
		)`,
		`INSERT INTO match_card_plays (
			id, match_id, game_number, instance_id, card_id, owner_seat_id, first_public_zone, turn_number, phase, source, played_at, created_at
		)
		SELECT
			id, match_id, 1, instance_id, card_id, owner_seat_id, first_public_zone, turn_number, phase, source, played_at, created_at
		FROM match_card_plays_old`,
		`CREATE INDEX idx_match_card_plays_match_id ON match_card_plays(match_id)`,
		`CREATE INDEX idx_match_card_plays_card_id ON match_card_plays(card_id)`,
		`CREATE INDEX idx_match_card_plays_turn_order ON match_card_plays(match_id, turn_number, played_at, id)`,
		`DROP TABLE match_card_plays_old`,
	}

	for _, step := range steps {
		if _, err := tx.ExecContext(ctx, step); err != nil {
			return fmt.Errorf("migrate match_card_plays: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migrate match_card_plays: %w", err)
	}
	return nil
}

func rebuildMatchOpponentCardInstancesTable(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migrate match_opponent_card_instances: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	steps := []string{
		`ALTER TABLE match_opponent_card_instances RENAME TO match_opponent_card_instances_old`,
		`DROP INDEX IF EXISTS idx_match_opponent_cards_match_id`,
		`DROP INDEX IF EXISTS idx_match_opponent_cards_card_id`,
		`CREATE TABLE match_opponent_card_instances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			match_id INTEGER NOT NULL,
			game_number INTEGER NOT NULL DEFAULT 1,
			instance_id INTEGER NOT NULL,
			card_id INTEGER NOT NULL,
			source TEXT,
			first_seen_at TEXT,
			created_at TEXT NOT NULL,
			UNIQUE(match_id, game_number, instance_id),
			FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
		)`,
		`INSERT INTO match_opponent_card_instances (
			id, match_id, game_number, instance_id, card_id, source, first_seen_at, created_at
		)
		SELECT
			id, match_id, 1, instance_id, card_id, source, first_seen_at, created_at
		FROM match_opponent_card_instances_old`,
		`CREATE INDEX idx_match_opponent_cards_match_id ON match_opponent_card_instances(match_id)`,
		`CREATE INDEX idx_match_opponent_cards_card_id ON match_opponent_card_instances(card_id)`,
		`DROP TABLE match_opponent_card_instances_old`,
	}

	for _, step := range steps {
		if _, err := tx.ExecContext(ctx, step); err != nil {
			return fmt.Errorf("migrate match_opponent_card_instances: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migrate match_opponent_card_instances: %w", err)
	}
	return nil
}
