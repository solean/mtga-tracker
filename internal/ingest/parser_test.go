package ingest

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/cschnabel/mtgdata/internal/db"
)

func TestParserStoresMatchRankSnapshotAcrossFiles(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "mtgdata.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	if err := db.Init(ctx, database); err != nil {
		t.Fatalf("init db: %v", err)
	}

	parser := NewParser(db.NewStore(database))

	prevLog := filepath.Join(tempDir, "Player-prev.log")
	currentLog := filepath.Join(tempDir, "Player.log")

	prevContents := `{"PersonaId":"SELF123"}
{"timestamp":"1773367612385","matchGameRoomStateChangedEvent":{"gameRoomInfo":{"gameRoomConfig":{"matchId":"match-1","reservedPlayers":[{"userId":"OPP456","playerName":"Opponent","systemSeatId":1,"teamId":1,"eventId":"Traditional_Ladder"},{"userId":"SELF123","playerName":"Self","systemSeatId":2,"teamId":2,"eventId":"Traditional_Ladder"}]},"stateType":"MatchGameRoomStateType_MatchCompleted","finalMatchResult":{"matchId":"match-1","matchCompletedReason":"MatchCompletedReasonType_Success","resultList":[{"scope":"MatchScope_Match","result":"ResultType_WinLoss","winningTeamId":1,"reason":"ResultReason_Concede"}]}}}}`
	if err := os.WriteFile(prevLog, []byte(prevContents+"\n"), 0o644); err != nil {
		t.Fatalf("write prev log: %v", err)
	}

	currentContents := `[UnityCrossThreadLogger]3/12/2026 7:08:37 PM
<== RankGetCombinedRankInfo(req-1)
{"constructedSeasonOrdinal":87,"constructedLevel":3,"constructedStep":2,"constructedMatchesWon":2,"constructedMatchesLost":2,"limitedSeasonOrdinal":87,"limitedLevel":3,"limitedMatchesWon":2,"limitedMatchesLost":3}`
	if err := os.WriteFile(currentLog, []byte(currentContents+"\n"), 0o644); err != nil {
		t.Fatalf("write current log: %v", err)
	}

	if _, err := parser.ParseFile(ctx, prevLog, false); err != nil {
		t.Fatalf("parse prev log: %v", err)
	}
	if _, err := parser.ParseFile(ctx, currentLog, false); err != nil {
		t.Fatalf("parse current log: %v", err)
	}

	var (
		matchID           string
		constructedLevel  sql.NullInt64
		constructedStep   sql.NullInt64
		constructedWins   sql.NullInt64
		constructedLosses sql.NullInt64
		limitedLevel      sql.NullInt64
		limitedWins       sql.NullInt64
		limitedLosses     sql.NullInt64
		observedAt        sql.NullString
	)
	err = database.QueryRowContext(ctx, `
		SELECT
			m.arena_match_id,
			mrs.constructed_level,
			mrs.constructed_step,
			mrs.constructed_matches_won,
			mrs.constructed_matches_lost,
			mrs.limited_level,
			mrs.limited_matches_won,
			mrs.limited_matches_lost,
			mrs.observed_at
		FROM match_rank_snapshots mrs
		JOIN matches m ON m.id = mrs.match_id
	`).Scan(
		&matchID,
		&constructedLevel,
		&constructedStep,
		&constructedWins,
		&constructedLosses,
		&limitedLevel,
		&limitedWins,
		&limitedLosses,
		&observedAt,
	)
	if err != nil {
		t.Fatalf("query rank snapshot: %v", err)
	}

	if matchID != "match-1" {
		t.Fatalf("match id = %q, want match-1", matchID)
	}
	if !constructedLevel.Valid || constructedLevel.Int64 != 3 {
		t.Fatalf("constructed level = %+v, want 3", constructedLevel)
	}
	if !constructedStep.Valid || constructedStep.Int64 != 2 {
		t.Fatalf("constructed step = %+v, want 2", constructedStep)
	}
	if !constructedWins.Valid || constructedWins.Int64 != 2 {
		t.Fatalf("constructed wins = %+v, want 2", constructedWins)
	}
	if !constructedLosses.Valid || constructedLosses.Int64 != 2 {
		t.Fatalf("constructed losses = %+v, want 2", constructedLosses)
	}
	if !limitedLevel.Valid || limitedLevel.Int64 != 3 {
		t.Fatalf("limited level = %+v, want 3", limitedLevel)
	}
	if !limitedWins.Valid || limitedWins.Int64 != 2 {
		t.Fatalf("limited wins = %+v, want 2", limitedWins)
	}
	if !limitedLosses.Valid || limitedLosses.Int64 != 3 {
		t.Fatalf("limited losses = %+v, want 3", limitedLosses)
	}
	if !observedAt.Valid || observedAt.String == "" {
		t.Fatalf("observed_at = %+v, want non-empty timestamp", observedAt)
	}
}

func TestParserIgnoresRankSnapshotWithoutCompletedMatch(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "mtgdata.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	if err := db.Init(ctx, database); err != nil {
		t.Fatalf("init db: %v", err)
	}

	parser := NewParser(db.NewStore(database))
	logPath := filepath.Join(tempDir, "Player.log")
	contents := `[UnityCrossThreadLogger]3/12/2026 7:08:37 PM
<== RankGetCombinedRankInfo(req-1)
{"constructedSeasonOrdinal":87,"constructedLevel":3,"constructedStep":2,"constructedMatchesWon":2,"constructedMatchesLost":2,"limitedSeasonOrdinal":87,"limitedLevel":3,"limitedMatchesWon":2,"limitedMatchesLost":3}`
	if err := os.WriteFile(logPath, []byte(contents+"\n"), 0o644); err != nil {
		t.Fatalf("write log: %v", err)
	}

	if _, err := parser.ParseFile(ctx, logPath, false); err != nil {
		t.Fatalf("parse log: %v", err)
	}

	var count int64
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM match_rank_snapshots`).Scan(&count); err != nil {
		t.Fatalf("count rank snapshots: %v", err)
	}
	if count != 0 {
		t.Fatalf("rank snapshot count = %d, want 0", count)
	}
}

func TestParserBackfillsRankSnapshotForExistingCompletedMatch(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "mtgdata.db")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	if err := db.Init(ctx, database); err != nil {
		t.Fatalf("init db: %v", err)
	}

	store := db.NewStore(database)
	tx, err := store.BeginTx(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if _, err := store.UpsertMatchStart(ctx, tx, "match-1", "Traditional_Ladder", 2, "2026-03-12T19:06:52Z"); err != nil {
		t.Fatalf("upsert match start: %v", err)
	}
	if _, _, _, err := store.UpdateMatchEnd(ctx, tx, "match-1", 2, 1, 28, 1140, "Concede", "2026-03-12T19:06:52Z"); err != nil {
		t.Fatalf("update match end: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit seeded match: %v", err)
	}

	parser := NewParser(store)

	prevLog := filepath.Join(tempDir, "Player-prev.log")
	currentLog := filepath.Join(tempDir, "Player.log")

	prevContents := `{"PersonaId":"SELF123"}
{"timestamp":"1773367612385","matchGameRoomStateChangedEvent":{"gameRoomInfo":{"gameRoomConfig":{"matchId":"match-1","reservedPlayers":[{"userId":"OPP456","playerName":"Opponent","systemSeatId":1,"teamId":1,"eventId":"Traditional_Ladder"},{"userId":"SELF123","playerName":"Self","systemSeatId":2,"teamId":2,"eventId":"Traditional_Ladder"}]},"stateType":"MatchGameRoomStateType_MatchCompleted","finalMatchResult":{"matchId":"match-1","matchCompletedReason":"MatchCompletedReasonType_Success","resultList":[{"scope":"MatchScope_Match","result":"ResultType_WinLoss","winningTeamId":1,"reason":"ResultReason_Concede"}]}}}}`
	if err := os.WriteFile(prevLog, []byte(prevContents+"\n"), 0o644); err != nil {
		t.Fatalf("write prev log: %v", err)
	}

	currentContents := `[UnityCrossThreadLogger]3/12/2026 7:08:37 PM
<== RankGetCombinedRankInfo(req-1)
{"constructedSeasonOrdinal":87,"constructedLevel":3,"constructedStep":2,"constructedMatchesWon":2,"constructedMatchesLost":2,"limitedSeasonOrdinal":87,"limitedLevel":3,"limitedMatchesWon":2,"limitedMatchesLost":3}`
	if err := os.WriteFile(currentLog, []byte(currentContents+"\n"), 0o644); err != nil {
		t.Fatalf("write current log: %v", err)
	}

	if _, err := parser.ParseFile(ctx, prevLog, false); err != nil {
		t.Fatalf("parse prev log: %v", err)
	}
	if _, err := parser.ParseFile(ctx, currentLog, false); err != nil {
		t.Fatalf("parse current log: %v", err)
	}

	var count int64
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM match_rank_snapshots`).Scan(&count); err != nil {
		t.Fatalf("count rank snapshots: %v", err)
	}
	if count != 1 {
		t.Fatalf("rank snapshot count = %d, want 1", count)
	}
}
