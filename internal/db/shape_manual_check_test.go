package db

// Temporary manual harness: verifies the turn-stat backfill against a copy of
// a real database. Run with:
//   PONDER_SHAPE_CHECK_DB=/path/to/snapshot.db go test ./internal/db -run TestManualShapeBackfill -v

import (
	"context"
	"os"
	"testing"
)

func TestManualShapeBackfill(t *testing.T) {
	path := os.Getenv("PONDER_SHAPE_CHECK_DB")
	if path == "" {
		t.Skip("PONDER_SHAPE_CHECK_DB not set")
	}
	ctx := context.Background()
	database, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer database.Close()
	if err := Init(ctx, database); err != nil {
		t.Fatalf("init: %v", err)
	}
	store := NewStore(database)

	if _, err := database.ExecContext(ctx, `DELETE FROM match_analytics_coverage`); err != nil {
		t.Fatalf("invalidate coverage: %v", err)
	}
	refreshed, err := store.RefreshPendingMatchAnalytics(ctx)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	t.Logf("refreshed %d matches", refreshed)

	var games, gamesWithStats, turnRows, judgedRows, missedDropTurns, minLifeGames int64
	if err := database.QueryRowContext(ctx, `
		SELECT
			(SELECT COUNT(*) FROM games),
			(SELECT COUNT(DISTINCT game_id) FROM game_turn_stats),
			(SELECT COUNT(*) FROM game_turn_stats),
			(SELECT COUNT(*) FROM game_turn_stats WHERE land_in_hand IS NOT NULL),
			(SELECT COUNT(*) FROM game_turn_stats ts
				JOIN games g ON g.id = ts.game_id
				WHERE ts.is_player_turn = 1 AND ts.lands_played = 0 AND ts.land_in_hand = 1
				  AND ts.turn_number < COALESCE(g.turn_count, 0)),
			(SELECT COUNT(*) FROM games WHERE min_self_life IS NOT NULL)
	`).Scan(&games, &gamesWithStats, &turnRows, &judgedRows, &missedDropTurns, &minLifeGames); err != nil {
		t.Fatalf("summary: %v", err)
	}
	t.Logf("games=%d gamesWithTurnStats=%d turnRows=%d judgedTurnRows=%d missedDropTurns=%d gamesWithMinLife=%d",
		games, gamesWithStats, turnRows, judgedRows, missedDropTurns, minLifeGames)

	rows, err := database.QueryContext(ctx, `
		SELECT ts.match_id, ts.turn_number, ts.self_life, ts.opponent_life, ts.lands_played,
			ts.spells_cast, ts.land_in_hand, ts.is_player_turn
		FROM game_turn_stats ts
		WHERE ts.match_id = (SELECT MAX(match_id) FROM game_turn_stats)
		ORDER BY ts.turn_number LIMIT 20
	`)
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var matchID, turn, lands, spells int64
		var selfLife, oppLife, landInHand, isPlayerTurn *int64
		if err := rows.Scan(&matchID, &turn, &selfLife, &oppLife, &lands, &spells, &landInHand, &isPlayerTurn); err != nil {
			t.Fatalf("scan sample: %v", err)
		}
		show := func(v *int64) any {
			if v == nil {
				return "·"
			}
			return *v
		}
		t.Logf("match=%d turn=%2d self=%v opp=%v lands=%d spells=%d landInHand=%v own=%v",
			matchID, turn, show(selfLife), show(oppLife), lands, spells, show(landInHand), show(isPlayerTurn))
	}
}
