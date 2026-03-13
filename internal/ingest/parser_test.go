package ingest

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cschnabel/mtgdata/internal/db"
	"github.com/cschnabel/mtgdata/internal/model"
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

func TestReplayFramesCaptureMultiCardStack(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test-replay-stack.db")
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
		`{"timestamp":"1772330782273","matchGameRoomStateChangedEvent":{"gameRoomInfo":{"gameRoomConfig":{"reservedPlayers":[{"userId":"opp-user","playerName":"Opp","systemSeatId":1,"teamId":1,"eventId":"Traditional_Ladder"},{"userId":"self-user","playerName":"Self","systemSeatId":2,"teamId":2,"eventId":"Traditional_Ladder"}],"matchId":"match-replay-stack"},"stateType":"MatchGameRoomStateType_Playing"}}}`,
		`{"timestamp":"1772330782309","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Full","gameStateId":1,"gameInfo":{"matchID":"match-replay-stack","gameNumber":1},"turnInfo":{"phase":"Phase_Main1","turnNumber":1},"zones":[{"zoneId":27,"type":"ZoneType_Stack","visibility":"Visibility_Public","objectInstanceIds":[]},{"zoneId":28,"type":"ZoneType_Battlefield","visibility":"Visibility_Public","objectInstanceIds":[]}],"gameObjects":[]}}]}}`,
		`{"timestamp":"1772330782310","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Diff","gameStateId":2,"prevGameStateId":1,"turnInfo":{"phase":"Phase_Main1","turnNumber":1},"zones":[{"zoneId":27,"type":"ZoneType_Stack","visibility":"Visibility_Public","objectInstanceIds":[501]}],"gameObjects":[{"instanceId":501,"grpId":9501,"type":"GameObjectType_Card","zoneId":27,"visibility":"Visibility_Public","ownerSeatId":1}]}}]}}`,
		`{"timestamp":"1772330782311","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Diff","gameStateId":3,"prevGameStateId":2,"turnInfo":{"phase":"Phase_Main1","turnNumber":1},"zones":[{"zoneId":27,"type":"ZoneType_Stack","visibility":"Visibility_Public","objectInstanceIds":[501,502]}],"gameObjects":[{"instanceId":502,"grpId":9502,"type":"GameObjectType_Card","zoneId":27,"visibility":"Visibility_Public","ownerSeatId":2}]}}]}}`,
		`{"timestamp":"1772330782312","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Diff","gameStateId":4,"prevGameStateId":3,"turnInfo":{"phase":"Phase_Main1","turnNumber":1},"zones":[{"zoneId":27,"type":"ZoneType_Stack","visibility":"Visibility_Public","objectInstanceIds":[501,502,503]}],"gameObjects":[{"instanceId":503,"grpId":9503,"type":"GameObjectType_Card","zoneId":27,"visibility":"Visibility_Public","ownerSeatId":1}]}}]}}`,
	}

	if err := writeLogLines(logPath, lines, false); err != nil {
		t.Fatalf("write log lines: %v", err)
	}
	if _, err := parser.ParseFile(ctx, logPath, false); err != nil {
		t.Fatalf("parse file: %v", err)
	}

	store := db.NewStore(database)
	frames, err := store.ListMatchReplayFrames(ctx, 1)
	if err != nil {
		t.Fatalf("list replay frames: %v", err)
	}
	if len(frames) != 4 {
		t.Fatalf("expected 4 replay frames, got %d", len(frames))
	}

	lastFrame := frames[len(frames)-1]
	stackObjects := replayObjectsInZone(lastFrame, "stack")
	if len(stackObjects) != 3 {
		t.Fatalf("expected 3 stack objects in final frame, got %d", len(stackObjects))
	}
	if stackObjects[0].InstanceID != 501 || stackObjects[1].InstanceID != 502 || stackObjects[2].InstanceID != 503 {
		t.Fatalf("unexpected stack order in final frame: %#v", stackObjects)
	}
}

func TestReplayFramesTrackBoardRemovalEffects(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test-replay-removal.db")
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
		`{"timestamp":"1772330782273","matchGameRoomStateChangedEvent":{"gameRoomInfo":{"gameRoomConfig":{"reservedPlayers":[{"userId":"opp-user","playerName":"Opp","systemSeatId":1,"teamId":1,"eventId":"Traditional_Ladder"},{"userId":"self-user","playerName":"Self","systemSeatId":2,"teamId":2,"eventId":"Traditional_Ladder"}],"matchId":"match-replay-removal"},"stateType":"MatchGameRoomStateType_Playing"}}}`,
		`{"timestamp":"1772330782309","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Full","gameStateId":1,"gameInfo":{"matchID":"match-replay-removal","gameNumber":1},"turnInfo":{"phase":"Phase_Main1","turnNumber":3},"zones":[{"zoneId":28,"type":"ZoneType_Battlefield","visibility":"Visibility_Public","objectInstanceIds":[601,602]},{"zoneId":33,"type":"ZoneType_Graveyard","visibility":"Visibility_Public","ownerSeatId":1,"objectInstanceIds":[]}],"gameObjects":[{"instanceId":601,"grpId":9601,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":1},{"instanceId":602,"grpId":9602,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":2}]}}]}}`,
		`{"timestamp":"1772330782310","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Diff","gameStateId":2,"prevGameStateId":1,"turnInfo":{"phase":"Phase_Main1","turnNumber":3},"zones":[{"zoneId":28,"type":"ZoneType_Battlefield","visibility":"Visibility_Public","objectInstanceIds":[601]},{"zoneId":33,"type":"ZoneType_Graveyard","visibility":"Visibility_Public","ownerSeatId":1,"objectInstanceIds":[602]}],"gameObjects":[{"instanceId":602,"grpId":9602,"type":"GameObjectType_Card","zoneId":33,"visibility":"Visibility_Public","ownerSeatId":2}]}}]}}`,
		`{"timestamp":"1772330782311","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Diff","gameStateId":3,"prevGameStateId":2,"turnInfo":{"phase":"Phase_Main1","turnNumber":3},"zones":[{"zoneId":28,"type":"ZoneType_Battlefield","visibility":"Visibility_Public","objectInstanceIds":[]}],"diffDeletedInstanceIds":[601],"gameObjects":[]}}]}}`,
	}

	if err := writeLogLines(logPath, lines, false); err != nil {
		t.Fatalf("write log lines: %v", err)
	}
	if _, err := parser.ParseFile(ctx, logPath, false); err != nil {
		t.Fatalf("parse file: %v", err)
	}

	store := db.NewStore(database)
	frames, err := store.ListMatchReplayFrames(ctx, 1)
	if err != nil {
		t.Fatalf("list replay frames: %v", err)
	}
	if len(frames) != 3 {
		t.Fatalf("expected 3 replay frames, got %d", len(frames))
	}

	secondFrame := frames[1]
	if len(replayObjectsInZone(secondFrame, "battlefield")) != 1 {
		t.Fatalf("expected 1 battlefield card after first removal, got %d", len(replayObjectsInZone(secondFrame, "battlefield")))
	}
	if len(replayObjectsInZone(secondFrame, "graveyard")) != 1 {
		t.Fatalf("expected 1 graveyard card after first removal, got %d", len(replayObjectsInZone(secondFrame, "graveyard")))
	}
	if !replayHasChange(secondFrame, "move_public", 602, "battlefield", "graveyard") {
		t.Fatalf("expected move_public change for card 602 in second frame, got %#v", secondFrame.Changes)
	}

	lastFrame := frames[2]
	if len(replayObjectsInZone(lastFrame, "battlefield")) != 0 {
		t.Fatalf("expected empty battlefield in final frame, got %d", len(replayObjectsInZone(lastFrame, "battlefield")))
	}
	if !replayHasChange(lastFrame, "leave_public", 601, "battlefield", "") {
		t.Fatalf("expected leave_public change for card 601 in final frame, got %#v", lastFrame.Changes)
	}
}

func TestReplayFramesDoNotDuplicateResolvedStackCards(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test-replay-resolve.db")
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
		`{"timestamp":"1772330782273","matchGameRoomStateChangedEvent":{"gameRoomInfo":{"gameRoomConfig":{"reservedPlayers":[{"userId":"opp-user","playerName":"Opp","systemSeatId":1,"teamId":1,"eventId":"Traditional_Ladder"},{"userId":"self-user","playerName":"Self","systemSeatId":2,"teamId":2,"eventId":"Traditional_Ladder"}],"matchId":"match-replay-resolve"},"stateType":"MatchGameRoomStateType_Playing"}}}`,
		`{"timestamp":"1772330782309","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Full","gameStateId":1,"gameInfo":{"matchID":"match-replay-resolve","gameNumber":1},"turnInfo":{"phase":"Phase_Main1","turnNumber":2},"zones":[{"zoneId":27,"type":"ZoneType_Stack","visibility":"Visibility_Public","objectInstanceIds":[701]},{"zoneId":28,"type":"ZoneType_Battlefield","visibility":"Visibility_Public","objectInstanceIds":[702]}],"gameObjects":[{"instanceId":701,"grpId":9701,"type":"GameObjectType_Card","zoneId":27,"visibility":"Visibility_Public","ownerSeatId":2},{"instanceId":702,"grpId":9702,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":2}]}}]}}`,
		`{"timestamp":"1772330782310","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Diff","gameStateId":2,"prevGameStateId":1,"turnInfo":{"phase":"Phase_Main1","turnNumber":2},"zones":[{"zoneId":27,"type":"ZoneType_Stack","visibility":"Visibility_Public"},{"zoneId":28,"type":"ZoneType_Battlefield","visibility":"Visibility_Public","objectInstanceIds":[701,702]}],"gameObjects":[{"instanceId":701,"grpId":9701,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":2}]}}]}}`,
	}

	if err := writeLogLines(logPath, lines, false); err != nil {
		t.Fatalf("write log lines: %v", err)
	}
	if _, err := parser.ParseFile(ctx, logPath, false); err != nil {
		t.Fatalf("parse file: %v", err)
	}

	store := db.NewStore(database)
	frames, err := store.ListMatchReplayFrames(ctx, 1)
	if err != nil {
		t.Fatalf("list replay frames: %v", err)
	}
	if len(frames) != 2 {
		t.Fatalf("expected 2 replay frames, got %d", len(frames))
	}

	lastFrame := frames[1]
	if len(lastFrame.Objects) != 2 {
		t.Fatalf("expected 2 public objects after resolution, got %d", len(lastFrame.Objects))
	}
	if len(replayObjectsInZone(lastFrame, "stack")) != 0 {
		t.Fatalf("expected empty stack after resolution, got %#v", replayObjectsInZone(lastFrame, "stack"))
	}
	if len(replayObjectsInZone(lastFrame, "battlefield")) != 2 {
		t.Fatalf("expected 2 battlefield cards after resolution, got %#v", replayObjectsInZone(lastFrame, "battlefield"))
	}
}

func TestReplayFramesCapturePermanentStateAndStateChanges(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test-replay-state.db")
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
		`{"timestamp":"1772330782273","matchGameRoomStateChangedEvent":{"gameRoomInfo":{"gameRoomConfig":{"reservedPlayers":[{"userId":"opp-user","playerName":"Opp","systemSeatId":1,"teamId":1,"eventId":"Traditional_Ladder"},{"userId":"self-user","playerName":"Self","systemSeatId":2,"teamId":2,"eventId":"Traditional_Ladder"}],"matchId":"match-replay-state"},"stateType":"MatchGameRoomStateType_Playing"}}}`,
		`{"timestamp":"1772330782309","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Full","gameStateId":1,"gameInfo":{"matchID":"match-replay-state","gameNumber":1},"turnInfo":{"phase":"Phase_Main1","turnNumber":4},"players":[{"lifeTotal":20,"systemSeatNumber":1},{"lifeTotal":19,"systemSeatNumber":2}],"zones":[{"zoneId":28,"type":"ZoneType_Battlefield","visibility":"Visibility_Public","objectInstanceIds":[801,802]}],"gameObjects":[{"instanceId":801,"grpId":9801,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":1,"controllerSeatId":1,"cardTypes":["CardType_Creature"],"power":{"value":1},"toughness":{"value":1}},{"instanceId":802,"grpId":9802,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":2,"controllerSeatId":2,"cardTypes":["CardType_Creature"],"power":{"value":2},"toughness":{"value":3}}]}}]}}`,
		`{"timestamp":"1772330782310","greToClientEvent":{"greToClientMessages":[{"type":"GREMessageType_GameStateMessage","systemSeatIds":[2],"gameStateMessage":{"type":"GameStateType_Diff","gameStateId":2,"prevGameStateId":1,"turnInfo":{"phase":"Phase_Combat","step":"Step_DeclareAttack","turnNumber":4},"players":[{"lifeTotal":17,"systemSeatNumber":1},{"lifeTotal":18,"systemSeatNumber":2}],"zones":[{"zoneId":28,"type":"ZoneType_Battlefield","visibility":"Visibility_Public","objectInstanceIds":[801,802]}],"gameObjects":[{"instanceId":801,"grpId":9801,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":1,"controllerSeatId":2,"cardTypes":["CardType_Creature"],"power":{"value":3},"toughness":{"value":3},"isTapped":true,"hasSummoningSickness":true,"attackState":"AttackState_Attacking","attackInfo":{"targetId":1},"counters":[{"counterType":"CounterType_P1P1","count":2}]},{"instanceId":802,"grpId":9802,"type":"GameObjectType_Card","zoneId":28,"visibility":"Visibility_Public","ownerSeatId":2,"controllerSeatId":2,"cardTypes":["CardType_Creature"],"power":{"value":2},"toughness":{"value":3},"blockState":"BlockState_Declared","blockInfo":{"attackerIds":[801]}}],"annotations":[{"id":901,"affectedIds":[801],"type":["AnnotationType_TappedUntappedPermanent"],"details":[{"key":"tapped","type":"KeyValuePairValueType_int32","valueInt32":[1]}]}]}}]}}`,
	}

	if err := writeLogLines(logPath, lines, false); err != nil {
		t.Fatalf("write log lines: %v", err)
	}
	if _, err := parser.ParseFile(ctx, logPath, false); err != nil {
		t.Fatalf("parse file: %v", err)
	}

	store := db.NewStore(database)
	frames, err := store.ListMatchReplayFrames(ctx, 1)
	if err != nil {
		t.Fatalf("list replay frames: %v", err)
	}
	if len(frames) != 2 {
		t.Fatalf("expected 2 replay frames, got %d", len(frames))
	}

	lastFrame := frames[1]
	if lastFrame.SelfLifeTotal == nil || *lastFrame.SelfLifeTotal != 18 {
		t.Fatalf("expected self life total 18, got %#v", lastFrame.SelfLifeTotal)
	}
	if lastFrame.OpponentLifeTotal == nil || *lastFrame.OpponentLifeTotal != 17 {
		t.Fatalf("expected opponent life total 17, got %#v", lastFrame.OpponentLifeTotal)
	}
	var attacking model.MatchReplayFrameObjectRow
	var blocker model.MatchReplayFrameObjectRow
	for _, object := range replayObjectsInZone(lastFrame, "battlefield") {
		switch object.InstanceID {
		case 801:
			attacking = object
		case 802:
			blocker = object
		}
	}

	if attacking.InstanceID != 801 {
		t.Fatalf("expected attacking object 801 in battlefield, got %#v", attacking)
	}
	if attacking.PlayerSide != "self" {
		t.Fatalf("expected controller-based player side self, got %q", attacking.PlayerSide)
	}
	if !attacking.IsTapped || !attacking.HasSummoningSickness {
		t.Fatalf("expected tapped attacking creature with summoning sickness, got %#v", attacking)
	}
	if attacking.Power == nil || *attacking.Power != 3 || attacking.Toughness == nil || *attacking.Toughness != 3 {
		t.Fatalf("expected 3/3 stats, got %#v / %#v", attacking.Power, attacking.Toughness)
	}
	if attacking.AttackState != "attacking" || attacking.AttackTargetID == nil || *attacking.AttackTargetID != 1 {
		t.Fatalf("expected attacking state with target 1, got %#v", attacking)
	}
	if strings.TrimSpace(attacking.CounterSummaryJSON) == "" {
		t.Fatalf("expected counter summary json, got empty on %#v", attacking)
	}
	var counters []struct {
		Label string `json:"label"`
		Count int64  `json:"count"`
	}
	if err := json.Unmarshal([]byte(attacking.CounterSummaryJSON), &counters); err != nil {
		t.Fatalf("unmarshal counter summary: %v", err)
	}
	if len(counters) != 1 || counters[0].Label != "+1/+1" || counters[0].Count != 2 {
		t.Fatalf("unexpected counter summary: %#v", counters)
	}

	if blocker.InstanceID != 802 {
		t.Fatalf("expected blocker 802 in battlefield, got %#v", blocker)
	}
	if blocker.BlockState != "declared" || strings.TrimSpace(blocker.BlockAttackerIDsJSON) != "[801]" {
		t.Fatalf("expected declared blocker against attacker 801, got %#v", blocker)
	}

	if !replayHasAnyChange(lastFrame, "controller_change", 801) {
		t.Fatalf("expected controller_change for 801, got %#v", lastFrame.Changes)
	}
	if !replayHasAnyChange(lastFrame, "tap", 801) {
		t.Fatalf("expected tap change for 801, got %#v", lastFrame.Changes)
	}
	if !replayHasAnyChange(lastFrame, "attack", 801) {
		t.Fatalf("expected attack change for 801, got %#v", lastFrame.Changes)
	}
	if !replayHasAnyChange(lastFrame, "counters_change", 801) {
		t.Fatalf("expected counters_change for 801, got %#v", lastFrame.Changes)
	}
	if !replayHasAnyChange(lastFrame, "block", 802) {
		t.Fatalf("expected block change for 802, got %#v", lastFrame.Changes)
	}
}

func replayObjectsInZone(frame model.MatchReplayFrameRow, zoneType string) []model.MatchReplayFrameObjectRow {
	out := make([]model.MatchReplayFrameObjectRow, 0)
	for _, obj := range frame.Objects {
		if obj.ZoneType == zoneType {
			out = append(out, obj)
		}
	}
	return out
}

func replayHasChange(frame model.MatchReplayFrameRow, action string, instanceID int64, fromZone, toZone string) bool {
	for _, change := range frame.Changes {
		if change.Action != action || change.InstanceID != instanceID {
			continue
		}
		if change.FromZoneType != fromZone {
			continue
		}
		if change.ToZoneType != toZone {
			continue
		}
		return true
	}
	return false
}

func replayHasAnyChange(frame model.MatchReplayFrameRow, action string, instanceID int64) bool {
	for _, change := range frame.Changes {
		if change.Action == action && change.InstanceID == instanceID {
			return true
		}
	}
	return false
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
