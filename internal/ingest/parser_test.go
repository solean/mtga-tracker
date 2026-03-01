package ingest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cschnabel/mtgdata/internal/db"
)

func TestTailParsePersistsStateAcrossResumeCalls(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.db")
	logPath := filepath.Join(tmpDir, "Player.log")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	if err := db.Init(ctx, database); err != nil {
		t.Fatalf("init db: %v", err)
	}

	parser := NewParser(db.NewStore(database))

	initialLines := []string{
		`{"clientId":"self-user","screenName":"Self"}`,
		`{"timestamp":"1772330782273","matchGameRoomStateChangedEvent":{"gameRoomInfo":{"gameRoomConfig":{"reservedPlayers":[{"userId":"opp-user","playerName":"Opp","systemSeatId":1,"teamId":1,"eventId":"Traditional_Ladder"},{"userId":"self-user","playerName":"Self","systemSeatId":2,"teamId":2,"eventId":"Traditional_Ladder"}],"matchId":"match-1"},"stateType":"MatchGameRoomStateType_Playing"}}}`,
		`{"timestamp":"1772330782309","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"gameInfo":{"matchID":"match-1"},"turnInfo":{"phase":"Phase_Main1","turnNumber":1},"zones":[{"zoneId":28,"type":"ZoneType_Battlefield"}],"gameObjects":[{"instanceId":101,"grpId":5001,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":1}]}}]}}`,
	}

	if err := writeLogLines(logPath, initialLines, false); err != nil {
		t.Fatalf("write initial log lines: %v", err)
	}

	if _, err := parser.ParseFile(ctx, logPath, true); err != nil {
		t.Fatalf("first parse: %v", err)
	}

	nextLines := []string{
		`{"timestamp":"1772330782310","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"turnInfo":{"phase":"Phase_Main1","turnNumber":2},"zones":[{"zoneId":28,"type":"ZoneType_Battlefield"}],"gameObjects":[{"instanceId":102,"grpId":5002,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":1}]}}]}}`,
	}
	if err := writeLogLines(logPath, nextLines, true); err != nil {
		t.Fatalf("append log lines: %v", err)
	}

	if _, err := parser.ParseFile(ctx, logPath, true); err != nil {
		t.Fatalf("second parse: %v", err)
	}

	var plays int
	if err := database.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM match_card_plays cp
		JOIN matches m ON m.id = cp.match_id
		WHERE m.arena_match_id = 'match-1'
	`).Scan(&plays); err != nil {
		t.Fatalf("count card plays: %v", err)
	}
	if plays != 2 {
		t.Fatalf("expected 2 card plays, got %d", plays)
	}

	var oppCards int
	if err := database.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM match_opponent_card_instances oc
		JOIN matches m ON m.id = oc.match_id
		WHERE m.arena_match_id = 'match-1'
	`).Scan(&oppCards); err != nil {
		t.Fatalf("count opponent cards: %v", err)
	}
	if oppCards != 2 {
		t.Fatalf("expected 2 opponent card instances, got %d", oppCards)
	}
}

func TestBestOfThreeTimelineAndOpponentCountsAreGameAware(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test-bo3.db")
	logPath := filepath.Join(tmpDir, "Player.log")

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	if err := db.Init(ctx, database); err != nil {
		t.Fatalf("init db: %v", err)
	}

	parser := NewParser(db.NewStore(database))

	lines := []string{
		`{"clientId":"self-user","screenName":"Self"}`,
		`{"timestamp":"1772330782273","matchGameRoomStateChangedEvent":{"gameRoomInfo":{"gameRoomConfig":{"reservedPlayers":[{"userId":"opp-user","playerName":"Opp","systemSeatId":1,"teamId":1,"eventId":"Traditional_Ladder"},{"userId":"self-user","playerName":"Self","systemSeatId":2,"teamId":2,"eventId":"Traditional_Ladder"}],"matchId":"match-bo3"},"stateType":"MatchGameRoomStateType_Playing"}}}`,
		`{"timestamp":"1772330782309","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"gameInfo":{"matchID":"match-bo3","gameNumber":1},"turnInfo":{"phase":"Phase_Main1","turnNumber":2},"zones":[{"zoneId":28,"type":"ZoneType_Battlefield"}],"gameObjects":[{"instanceId":101,"grpId":5001,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":1}]}}]}}`,
		`{"timestamp":"1772330782310","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"gameInfo":{"matchID":"match-bo3","gameNumber":2},"turnInfo":{"phase":"Phase_Main1","turnNumber":1},"zones":[{"zoneId":28,"type":"ZoneType_Battlefield"}],"gameObjects":[{"instanceId":101,"grpId":5001,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":1}]}}]}}`,
	}

	if err := writeLogLines(logPath, lines, false); err != nil {
		t.Fatalf("write log lines: %v", err)
	}

	if _, err := parser.ParseFile(ctx, logPath, false); err != nil {
		t.Fatalf("parse file: %v", err)
	}

	store := db.NewStore(database)
	detail, err := store.GetMatchDetail(ctx, 1)
	if err != nil {
		t.Fatalf("get match detail: %v", err)
	}

	if len(detail.CardPlays) != 2 {
		t.Fatalf("expected 2 card plays, got %d", len(detail.CardPlays))
	}
	if detail.CardPlays[0].GameNumber == nil || *detail.CardPlays[0].GameNumber != 1 {
		t.Fatalf("expected first card play in game 1, got %#v", detail.CardPlays[0].GameNumber)
	}
	if detail.CardPlays[1].GameNumber == nil || *detail.CardPlays[1].GameNumber != 2 {
		t.Fatalf("expected second card play in game 2, got %#v", detail.CardPlays[1].GameNumber)
	}

	if len(detail.OpponentObservedCards) != 1 {
		t.Fatalf("expected 1 observed opponent card, got %d", len(detail.OpponentObservedCards))
	}
	if detail.OpponentObservedCards[0].Quantity != 1 {
		t.Fatalf("expected observed quantity 1 (max per game), got %d", detail.OpponentObservedCards[0].Quantity)
	}
}

func writeLogLines(path string, lines []string, appendMode bool) error {
	if len(lines) == 0 {
		return nil
	}
	payload := strings.Join(lines, "\n") + "\n"
	if appendMode {
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.WriteString(payload)
		return err
	}
	return os.WriteFile(path, []byte(payload), 0o644)
}
