package ingest

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cschnabel/mtgdata/internal/db"
	"github.com/cschnabel/mtgdata/internal/model"
)

var (
	reOutgoing       = regexp.MustCompile(`^\[UnityCrossThreadLogger\]==>\s+([A-Za-z0-9_]+)\s+(.*)$`)
	reComplete       = regexp.MustCompile(`^<==\s+([A-Za-z0-9_]+)\(([^)]*)\)`)
	rePersonaPlain   = regexp.MustCompile(`"PersonaId":"([A-Za-z0-9_\-]+)"`)
	rePersonaEscaped = regexp.MustCompile(`\\\"PersonaId\\\":\\\"([A-Za-z0-9_\-]+)\\\"`)
	rePersonaMatchTo = regexp.MustCompile(`Match to ([A-Za-z0-9_\-]+):`)
	reClientID       = regexp.MustCompile(`"clientId"\s*:\s*"([A-Za-z0-9_\-]+)"`)
	reScreenName     = regexp.MustCompile(`"screenName"\s*:\s*"([^"]+)"`)
)

type Parser struct {
	store      *db.Store
	stateMu    sync.Mutex
	stateByLog map[string]*parseState
}

func NewParser(store *db.Store) *Parser {
	return &Parser{
		store:      store,
		stateByLog: make(map[string]*parseState),
	}
}

func (p *Parser) stateForLog(logPath string, reset bool) *parseState {
	key := strings.TrimSpace(logPath)
	if key == "" {
		return &parseState{}
	}

	p.stateMu.Lock()
	defer p.stateMu.Unlock()

	if reset {
		state := &parseState{}
		p.stateByLog[key] = state
		return state
	}

	state, ok := p.stateByLog[key]
	if !ok || state == nil {
		state = &parseState{}
		p.stateByLog[key] = state
	}
	return state
}

type parseState struct {
	personaID       string
	playerName      string
	activeMatchID   string
	selfSeatByMatch map[string]int64
	turnByMatch     map[string]int64
	phaseByMatch    map[string]string
	zoneTypeByMatch map[string]map[int64]string
}

func (s *parseState) rememberSelfSeat(matchID string, seatID int64) {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" || seatID <= 0 {
		return
	}
	if s.selfSeatByMatch == nil {
		s.selfSeatByMatch = make(map[string]int64)
	}
	s.selfSeatByMatch[matchID] = seatID
}

func (s *parseState) selfSeat(matchID string) int64 {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" || s.selfSeatByMatch == nil {
		return 0
	}
	return s.selfSeatByMatch[matchID]
}

func (s *parseState) rememberTurn(matchID string, turnNumber int64) {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" || turnNumber <= 0 {
		return
	}
	if s.turnByMatch == nil {
		s.turnByMatch = make(map[string]int64)
	}
	s.turnByMatch[matchID] = turnNumber
}

func (s *parseState) turn(matchID string) int64 {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" || s.turnByMatch == nil {
		return 0
	}
	return s.turnByMatch[matchID]
}

func (s *parseState) rememberPhase(matchID, phase string) {
	matchID = strings.TrimSpace(matchID)
	phase = normalizeGREPhase(phase)
	if matchID == "" || phase == "" {
		return
	}
	if s.phaseByMatch == nil {
		s.phaseByMatch = make(map[string]string)
	}
	s.phaseByMatch[matchID] = phase
}

func (s *parseState) phase(matchID string) string {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" || s.phaseByMatch == nil {
		return ""
	}
	return s.phaseByMatch[matchID]
}

func (s *parseState) rememberZoneType(matchID string, zoneID int64, zoneType string) {
	matchID = strings.TrimSpace(matchID)
	zoneType = normalizeGREZoneType(zoneType)
	if matchID == "" || zoneID <= 0 || zoneType == "" {
		return
	}
	if s.zoneTypeByMatch == nil {
		s.zoneTypeByMatch = make(map[string]map[int64]string)
	}
	byZone, ok := s.zoneTypeByMatch[matchID]
	if !ok {
		byZone = make(map[int64]string)
		s.zoneTypeByMatch[matchID] = byZone
	}
	byZone[zoneID] = zoneType
}

func (s *parseState) zoneType(matchID string, zoneID int64) string {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" || zoneID <= 0 || s.zoneTypeByMatch == nil {
		return ""
	}
	byZone := s.zoneTypeByMatch[matchID]
	if byZone == nil {
		return ""
	}
	return byZone[zoneID]
}

type outgoingEnvelope struct {
	ID      string          `json:"id"`
	Request json.RawMessage `json:"request"`
}

type eventJoinRequest struct {
	EventName         string `json:"EventName"`
	EntryCurrencyType string `json:"EntryCurrencyType"`
	EntryCurrencyPaid int64  `json:"EntryCurrencyPaid"`
}

type eventClaimPrizeRequest struct {
	EventName string `json:"EventName"`
}

type eventSetDeckRequest struct {
	EventName string `json:"EventName"`
	Summary   struct {
		DeckID     string `json:"DeckId"`
		Name       string `json:"Name"`
		Attributes []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"Attributes"`
	} `json:"Summary"`
	Deck struct {
		MainDeck []struct {
			CardID   int64 `json:"cardId"`
			Quantity int64 `json:"quantity"`
		} `json:"MainDeck"`
		Sideboard []struct {
			CardID   int64 `json:"cardId"`
			Quantity int64 `json:"quantity"`
		} `json:"Sideboard"`
		CommandZone []struct {
			CardID   int64 `json:"cardId"`
			Quantity int64 `json:"quantity"`
		} `json:"CommandZone"`
		Companions []struct {
			CardID   int64 `json:"cardId"`
			Quantity int64 `json:"quantity"`
		} `json:"Companions"`
	} `json:"Deck"`
}

type playerDraftPickRequest struct {
	DraftID string  `json:"DraftId"`
	GrpIDs  []int64 `json:"GrpIds"`
	Pack    int64   `json:"Pack"`
	Pick    int64   `json:"Pick"`
}

type botDraftPickRequest struct {
	EventName string `json:"EventName"`
	PickInfo  struct {
		CardIDs    []string `json:"CardIds"`
		PackNumber int64    `json:"PackNumber"`
		PickNumber int64    `json:"PickNumber"`
	} `json:"PickInfo"`
}

type draftCompleteRequest struct {
	EventName  string `json:"EventName"`
	IsBotDraft bool   `json:"IsBotDraft"`
}

type logBusinessEvent struct {
	EventType     int64  `json:"EventType"`
	EventTime     string `json:"EventTime"`
	EventName     string `json:"EventName"`
	EventID       string `json:"EventId"`
	MatchID       string `json:"MatchId"`
	SeatID        int64  `json:"SeatId"`
	TeamID        int64  `json:"TeamId"`
	WinningTeamID int64  `json:"WinningTeamId"`
	WinningReason string `json:"WinningReason"`
	TurnCount     int64  `json:"TurnCount"`
	SecondsCount  int64  `json:"SecondsCount"`
}

type roomPlayer struct {
	UserID       string `json:"userId"`
	PlayerName   string `json:"playerName"`
	SystemSeatID int64  `json:"systemSeatId"`
	TeamID       int64  `json:"teamId"`
	EventID      string `json:"eventId"`
}

type roomResultEntry struct {
	Scope         string `json:"scope"`
	Result        string `json:"result"`
	WinningTeamID int64  `json:"winningTeamId"`
	Reason        string `json:"reason"`
}

type roomStateEnvelope struct {
	Timestamp                      string `json:"timestamp"`
	MatchGameRoomStateChangedEvent *struct {
		GameRoomInfo *struct {
			GameRoomConfig *struct {
				MatchID         string       `json:"matchId"`
				ReservedPlayers []roomPlayer `json:"reservedPlayers"`
			} `json:"gameRoomConfig"`
			StateType        string `json:"stateType"`
			FinalMatchResult *struct {
				MatchID              string            `json:"matchId"`
				MatchCompletedReason string            `json:"matchCompletedReason"`
				ResultList           []roomResultEntry `json:"resultList"`
			} `json:"finalMatchResult"`
			Players []roomPlayer `json:"players"`
		} `json:"gameRoomInfo"`
	} `json:"matchGameRoomStateChangedEvent"`
}

type greEnvelope struct {
	Timestamp        string `json:"timestamp"`
	GREToClientEvent *struct {
		Messages []greMessage `json:"greToClientMessages"`
	} `json:"greToClientEvent"`
}

type greMessage struct {
	SystemSeatIDs    []int64          `json:"systemSeatIds"`
	GameStateMessage *greGameStateMsg `json:"gameStateMessage"`
}

type greGameStateMsg struct {
	GameInfo *struct {
		MatchID string `json:"matchID"`
	} `json:"gameInfo"`
	TurnInfo    *greTurnInfo    `json:"turnInfo"`
	Zones       []greZone       `json:"zones"`
	GameObjects []greGameObject `json:"gameObjects"`
}

type greTurnInfo struct {
	TurnNumber int64  `json:"turnNumber"`
	Phase      string `json:"phase"`
}

type greZone struct {
	ZoneID int64  `json:"zoneId"`
	Type   string `json:"type"`
}

type greGameObject struct {
	InstanceID  int64  `json:"instanceId"`
	GrpID       int64  `json:"grpId"`
	Type        string `json:"type"`
	ZoneID      int64  `json:"zoneId"`
	Visibility  string `json:"visibility"`
	OwnerSeatID int64  `json:"ownerSeatId"`
	IsToken     bool   `json:"isToken"`
}

func (p *Parser) ParseFile(ctx context.Context, logPath string, resume bool) (model.ParseStats, error) {
	stats := model.ParseStats{LogPath: logPath, StartedAt: time.Now().UTC()}

	startOffset := int64(0)
	startLine := int64(0)
	resetState := !resume
	if resume {
		ingestState, err := p.store.GetIngestState(ctx, logPath)
		if err != nil {
			return stats, err
		}
		if ingestState.Found {
			startOffset = ingestState.Offset
			startLine = ingestState.LineNo
			if startOffset == 0 && startLine == 0 {
				resetState = true
			}
		}
	}

	file, err := os.Open(logPath)
	if err != nil {
		return stats, fmt.Errorf("open log file: %w", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return stats, fmt.Errorf("stat log file: %w", err)
	}

	// MTGA rotates/truncates Player.log. If our saved offset points past EOF,
	// restart from the beginning of the current file so tailing can recover.
	if startOffset > info.Size() {
		startOffset = 0
		startLine = 0
		resetState = true
	}

	state := p.stateForLog(logPath, resetState)

	if startOffset > 0 {
		if _, err := file.Seek(startOffset, io.SeekStart); err != nil {
			return stats, fmt.Errorf("seek to offset %d: %w", startOffset, err)
		}
	}

	reader := bufio.NewReaderSize(file, 4*1024*1024)

	tx, err := p.store.BeginTx(ctx)
	if err != nil {
		return stats, fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	const batchSize = int64(500)
	lineNo := startLine
	byteOffset := startOffset
	linesSinceCommit := int64(0)

	commit := func() error {
		if err := p.store.SaveIngestState(ctx, tx, logPath, byteOffset, lineNo); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit tx: %w", err)
		}
		tx, err = p.store.BeginTx(ctx)
		if err != nil {
			return fmt.Errorf("begin new tx: %w", err)
		}
		linesSinceCommit = 0
		return nil
	}

	for {
		lineStartOffset := byteOffset
		line, readErr := reader.ReadString('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return stats, fmt.Errorf("read line: %w", readErr)
		}
		if len(line) == 0 && errors.Is(readErr, io.EOF) {
			break
		}

		lineNo++
		byteOffset += int64(len(line))
		stats.LinesRead++
		stats.BytesRead += int64(len(line))
		linesSinceCommit++

		trimmed := strings.TrimRight(line, "\r\n")
		if err := p.processLine(ctx, tx, &stats, state, logPath, lineNo, lineStartOffset, trimmed); err != nil {
			return stats, fmt.Errorf("process line %d: %w", lineNo, err)
		}

		if linesSinceCommit >= batchSize {
			if err := commit(); err != nil {
				return stats, err
			}
		}

		if errors.Is(readErr, io.EOF) {
			break
		}
	}

	if err := p.store.SaveIngestState(ctx, tx, logPath, byteOffset, lineNo); err != nil {
		return stats, err
	}
	if err := tx.Commit(); err != nil {
		return stats, fmt.Errorf("commit final tx: %w", err)
	}

	stats.CompletedAt = time.Now().UTC()
	return stats, nil
}

func (p *Parser) processLine(ctx context.Context, tx *sql.Tx, stats *model.ParseStats, state *parseState, logPath string, lineNo, byteOffset int64, line string) error {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}

	if state.personaID == "" {
		match := rePersonaPlain.FindStringSubmatch(line)
		if len(match) != 2 {
			match = rePersonaEscaped.FindStringSubmatch(line)
		}
		if len(match) == 2 {
			id := match[1]
			if !strings.HasPrefix(id, "NoInstallID") {
				state.personaID = id
			}
		}
		if state.personaID == "" {
			if m := rePersonaMatchTo.FindStringSubmatch(line); len(m) == 2 {
				state.personaID = strings.TrimSpace(m[1])
			}
		}
		if state.personaID == "" {
			if m := reClientID.FindStringSubmatch(line); len(m) == 2 {
				state.personaID = strings.TrimSpace(m[1])
			}
		}
	}
	if state.playerName == "" {
		if m := reScreenName.FindStringSubmatch(line); len(m) == 2 {
			state.playerName = strings.TrimSpace(m[1])
		}
	}

	if m := reOutgoing.FindStringSubmatch(line); len(m) == 3 {
		method := m[1]
		envelopeJSON := m[2]
		if err := p.handleOutgoing(ctx, tx, stats, state, logPath, lineNo, byteOffset, method, envelopeJSON); err != nil {
			return err
		}
		return nil
	}

	if m := reComplete.FindStringSubmatch(line); len(m) == 3 {
		if err := p.store.InsertRawEvent(ctx, tx, logPath, lineNo, byteOffset, "method_complete", m[1], m[2], nil, ""); err != nil {
			return err
		}
		stats.RawEventsStored++
		return nil
	}

	if strings.HasPrefix(line, "{") {
		if strings.Contains(line, "\"matchGameRoomStateChangedEvent\"") {
			if err := p.handleRoomStateJSON(ctx, tx, stats, logPath, lineNo, byteOffset, line, state); err != nil {
				return err
			}
			return nil
		}
		if strings.Contains(line, "\"greToClientEvent\"") {
			if err := p.handleGREJSON(ctx, tx, line, state); err != nil {
				return err
			}
			return nil
		}
	}

	return nil
}

func decodeRawRequest(raw json.RawMessage) ([]byte, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}

	if strings.HasPrefix(trimmed, "\"") {
		var inner string
		if err := json.Unmarshal([]byte(trimmed), &inner); err != nil {
			return nil, fmt.Errorf("decode string request: %w", err)
		}
		inner = strings.TrimSpace(inner)
		if inner == "" {
			return nil, nil
		}
		if strings.HasPrefix(inner, "{") || strings.HasPrefix(inner, "[") {
			return []byte(inner), nil
		}
		return []byte(strconv.Quote(inner)), nil
	}

	return []byte(trimmed), nil
}

func formatFromAttributes(attrs []struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}) string {
	for _, a := range attrs {
		if strings.EqualFold(strings.TrimSpace(a.Name), "Format") {
			return strings.Trim(strings.TrimSpace(a.Value), `"`)
		}
	}
	return ""
}

func cardSectionCards(section string, in []struct {
	CardID   int64 `json:"cardId"`
	Quantity int64 `json:"quantity"`
}) []db.DeckCard {
	out := make([]db.DeckCard, 0, len(in))
	for _, c := range in {
		if c.Quantity <= 0 {
			continue
		}
		out = append(out, db.DeckCard{Section: section, CardID: c.CardID, Quantity: c.Quantity})
	}
	return out
}

func parseStringIDsToInt64(in []string) []int64 {
	out := make([]int64, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			continue
		}
		out = append(out, v)
	}
	return out
}

func parseRoomTimestamp(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return ""
	}

	var ts time.Time
	switch {
	case v >= 1_000_000_000_000 && v < 10_000_000_000_000:
		ts = time.UnixMilli(v)
	case v >= 1_000_000_000 && v < 10_000_000_000:
		ts = time.Unix(v, 0)
	default:
		return ""
	}
	return ts.UTC().Format(time.RFC3339Nano)
}

func roomEventName(players []roomPlayer) string {
	for _, pl := range players {
		eventID := strings.TrimSpace(pl.EventID)
		if eventID != "" {
			return eventID
		}
	}
	return ""
}

func normalizeWinningReason(reason string) string {
	reason = strings.TrimSpace(reason)
	reason = strings.TrimPrefix(reason, "ResultReason_")
	reason = strings.TrimPrefix(reason, "WinningReason_")
	return reason
}

func chooseMatchResult(results []roomResultEntry) (int64, string) {
	var fallbackTeamID int64
	var fallbackReason string
	for _, r := range results {
		if r.WinningTeamID <= 0 {
			continue
		}
		reason := normalizeWinningReason(r.Reason)
		if strings.EqualFold(strings.TrimSpace(r.Scope), "MatchScope_Match") {
			return r.WinningTeamID, reason
		}
		if fallbackTeamID == 0 {
			fallbackTeamID = r.WinningTeamID
			fallbackReason = reason
		}
	}
	return fallbackTeamID, fallbackReason
}

func normalizeGREPhase(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "Phase_")
	raw = strings.TrimPrefix(raw, "Step_")
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	return strings.ToLower(raw)
}

func normalizeGREZoneType(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "ZoneType_")
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	return strings.ToLower(raw)
}

func isTimelinePlayableZone(zoneType string) bool {
	zoneType = strings.TrimSpace(strings.ToLower(zoneType))
	return zoneType == "stack" || zoneType == "battlefield"
}

func fallbackGREZoneType(zoneID int64) string {
	switch zoneID {
	case 27:
		return "stack"
	case 28:
		return "battlefield"
	default:
		return ""
	}
}

func (p *Parser) handleGREJSON(ctx context.Context, tx *sql.Tx, line string, state *parseState) error {
	var env greEnvelope
	if err := json.Unmarshal([]byte(line), &env); err != nil {
		return nil
	}
	if env.GREToClientEvent == nil {
		return nil
	}

	eventTS := parseRoomTimestamp(env.Timestamp)
	for _, msg := range env.GREToClientEvent.Messages {
		if msg.GameStateMessage == nil {
			continue
		}

		matchID := strings.TrimSpace(state.activeMatchID)
		if msg.GameStateMessage.GameInfo != nil && strings.TrimSpace(msg.GameStateMessage.GameInfo.MatchID) != "" {
			matchID = strings.TrimSpace(msg.GameStateMessage.GameInfo.MatchID)
			selfSeat := state.selfSeat(matchID)
			if selfSeat <= 0 && len(msg.SystemSeatIDs) == 1 && msg.SystemSeatIDs[0] > 0 {
				selfSeat = msg.SystemSeatIDs[0]
			}
			if _, err := p.store.UpsertMatchStart(ctx, tx, matchID, "", selfSeat, eventTS); err != nil {
				return err
			}
			state.activeMatchID = matchID
			state.rememberSelfSeat(matchID, selfSeat)
		}
		if matchID == "" {
			continue
		}

		if msg.GameStateMessage.TurnInfo != nil {
			state.rememberTurn(matchID, msg.GameStateMessage.TurnInfo.TurnNumber)
			state.rememberPhase(matchID, msg.GameStateMessage.TurnInfo.Phase)
		}
		for _, zone := range msg.GameStateMessage.Zones {
			state.rememberZoneType(matchID, zone.ZoneID, zone.Type)
		}

		selfSeat := state.selfSeat(matchID)
		if selfSeat <= 0 && len(msg.SystemSeatIDs) == 1 && msg.SystemSeatIDs[0] > 0 {
			selfSeat = msg.SystemSeatIDs[0]
			state.rememberSelfSeat(matchID, selfSeat)
		}
		turnNumber := state.turn(matchID)
		phase := state.phase(matchID)

		for _, obj := range msg.GameStateMessage.GameObjects {
			if obj.InstanceID <= 0 || obj.GrpID <= 0 || obj.OwnerSeatID <= 0 {
				continue
			}
			if !strings.EqualFold(strings.TrimSpace(obj.Type), "GameObjectType_Card") {
				continue
			}
			if !strings.EqualFold(strings.TrimSpace(obj.Visibility), "Visibility_Public") {
				continue
			}

			if !obj.IsToken {
				zoneType := state.zoneType(matchID, obj.ZoneID)
				if zoneType == "" {
					zoneType = fallbackGREZoneType(obj.ZoneID)
				}
				if isTimelinePlayableZone(zoneType) {
					if err := p.store.UpsertMatchCardPlay(ctx, tx, matchID, obj.InstanceID, obj.GrpID, obj.OwnerSeatID, turnNumber, phase, zoneType, eventTS, "gre_public_gameobject"); err != nil {
						return err
					}
				}
			}

			if selfSeat <= 0 || obj.IsToken || obj.OwnerSeatID == selfSeat {
				continue
			}

			if err := p.store.UpsertMatchOpponentCardInstance(ctx, tx, matchID, obj.InstanceID, obj.GrpID, eventTS, "gre_public_gameobject"); err != nil {
				return err
			}
		}
	}

	return nil
}

func (p *Parser) handleOutgoing(ctx context.Context, tx *sql.Tx, stats *model.ParseStats, state *parseState, logPath string, lineNo, byteOffset int64, method, envelopeJSON string) error {
	var env outgoingEnvelope
	if err := json.Unmarshal([]byte(envelopeJSON), &env); err != nil {
		if err := p.store.InsertRawEvent(ctx, tx, logPath, lineNo, byteOffset, "outgoing_unparsed", method, "", nil, ""); err != nil {
			return err
		}
		stats.RawEventsStored++
		return nil
	}

	requestPayload, err := decodeRawRequest(env.Request)
	if err != nil {
		return fmt.Errorf("decode raw request for %s: %w", method, err)
	}

	if err := p.store.InsertRawEvent(ctx, tx, logPath, lineNo, byteOffset, "outgoing", method, env.ID, requestPayload, ""); err != nil {
		return err
	}
	stats.RawEventsStored++

	switch method {
	case "EventJoin":
		var req eventJoinRequest
		if err := json.Unmarshal(requestPayload, &req); err != nil {
			return nil
		}
		if req.EventName == "" {
			return nil
		}
		if err := p.store.UpsertEventRunJoin(ctx, tx, req.EventName, req.EntryCurrencyType, req.EntryCurrencyPaid, ""); err != nil {
			return err
		}
	case "EventClaimPrize":
		var req eventClaimPrizeRequest
		if err := json.Unmarshal(requestPayload, &req); err != nil {
			return nil
		}
		if req.EventName != "" {
			if err := p.store.MarkEventRunClaimed(ctx, tx, req.EventName, ""); err != nil {
				return err
			}
		}
	case "EventSetDeckV2":
		var req eventSetDeckRequest
		if err := json.Unmarshal(requestPayload, &req); err != nil {
			return nil
		}
		if req.Summary.DeckID == "" {
			return nil
		}
		cards := make([]db.DeckCard, 0, len(req.Deck.MainDeck)+len(req.Deck.Sideboard)+len(req.Deck.CommandZone)+len(req.Deck.Companions))
		cards = append(cards, cardSectionCards("main", req.Deck.MainDeck)...)
		cards = append(cards, cardSectionCards("sideboard", req.Deck.Sideboard)...)
		cards = append(cards, cardSectionCards("command", req.Deck.CommandZone)...)
		cards = append(cards, cardSectionCards("companion", req.Deck.Companions)...)

		format := formatFromAttributes(req.Summary.Attributes)
		lastUpdated := ""
		for _, a := range req.Summary.Attributes {
			if strings.EqualFold(strings.TrimSpace(a.Name), "LastUpdated") {
				lastUpdated = strings.Trim(strings.TrimSpace(a.Value), `"`)
				break
			}
		}

		_, err := p.store.UpsertDeck(ctx, tx, req.Summary.DeckID, req.EventName, req.Summary.Name, format, "event_set_deck", lastUpdated, cards)
		if err != nil {
			return err
		}
		stats.DecksUpserted++
	case "EventPlayerDraftMakePick":
		var req playerDraftPickRequest
		if err := json.Unmarshal(requestPayload, &req); err != nil {
			return nil
		}
		if req.DraftID == "" {
			return nil
		}
		draftID := req.DraftID
		sessionID, err := p.store.EnsureDraftSession(ctx, tx, "", &draftID, false, "")
		if err != nil {
			return err
		}
		if err := p.store.InsertDraftPick(ctx, tx, sessionID, req.Pack, req.Pick, req.GrpIDs, nil, ""); err != nil {
			return err
		}
		stats.DraftPicksAdded++
	case "BotDraftDraftPick":
		var req botDraftPickRequest
		if err := json.Unmarshal(requestPayload, &req); err != nil {
			return nil
		}
		if req.EventName == "" {
			return nil
		}
		sessionID, err := p.store.EnsureDraftSession(ctx, tx, req.EventName, nil, true, "")
		if err != nil {
			return err
		}
		picked := parseStringIDsToInt64(req.PickInfo.CardIDs)
		if err := p.store.InsertDraftPick(ctx, tx, sessionID, req.PickInfo.PackNumber, req.PickInfo.PickNumber, picked, nil, ""); err != nil {
			return err
		}
		stats.DraftPicksAdded++
	case "DraftCompleteDraft":
		var req draftCompleteRequest
		if err := json.Unmarshal(requestPayload, &req); err != nil {
			return nil
		}
		if err := p.store.CompleteDraftSession(ctx, tx, req.EventName, nil, req.IsBotDraft, ""); err != nil {
			return err
		}
	case "LogBusinessEvents":
		var evt logBusinessEvent
		if err := json.Unmarshal(requestPayload, &evt); err != nil {
			return nil
		}
		switch evt.EventType {
		case 3:
			if evt.MatchID == "" {
				return nil
			}
			eventName := evt.EventID
			if eventName == "" {
				eventName = evt.EventName
			}
			_, err := p.store.UpsertMatchStart(ctx, tx, evt.MatchID, eventName, evt.SeatID, evt.EventTime)
			if err != nil {
				return err
			}
			state.activeMatchID = strings.TrimSpace(evt.MatchID)
			state.rememberSelfSeat(evt.MatchID, evt.SeatID)
			_ = p.store.LinkMatchToLatestDeckByEvent(ctx, tx, evt.MatchID, eventName, "pre_match")
			stats.MatchesUpserted++
		case 4:
			if evt.MatchID == "" {
				return nil
			}
			_, _, err := p.store.UpdateMatchEnd(ctx, tx, evt.MatchID, evt.TeamID, evt.WinningTeamID, evt.TurnCount, evt.SecondsCount, evt.WinningReason, evt.EventTime)
			if err != nil {
				return err
			}
		}
	}

	return nil
}

func (p *Parser) handleRoomStateJSON(ctx context.Context, tx *sql.Tx, stats *model.ParseStats, logPath string, lineNo, byteOffset int64, line string, state *parseState) error {
	var env roomStateEnvelope
	if err := json.Unmarshal([]byte(line), &env); err != nil {
		return nil
	}
	if env.MatchGameRoomStateChangedEvent == nil || env.MatchGameRoomStateChangedEvent.GameRoomInfo == nil || env.MatchGameRoomStateChangedEvent.GameRoomInfo.GameRoomConfig == nil {
		return nil
	}

	info := env.MatchGameRoomStateChangedEvent.GameRoomInfo
	config := info.GameRoomConfig
	if config.MatchID == "" {
		return nil
	}

	players := info.Players
	if len(config.ReservedPlayers) > 0 {
		players = config.ReservedPlayers
	}

	eventName := roomEventName(config.ReservedPlayers)
	if eventName == "" {
		eventName = roomEventName(players)
	}
	matchTS := parseRoomTimestamp(env.Timestamp)

	selfSeen := false
	var selfSeatID int64
	var selfTeamID int64
	opponentName := ""
	opponentUserID := ""
	personaID := strings.TrimSpace(state.personaID)

	for _, pl := range players {
		playerUserID := strings.TrimSpace(pl.UserID)
		playerName := strings.TrimSpace(pl.PlayerName)

		if personaID != "" && playerUserID == personaID {
			selfSeen = true
			if pl.SystemSeatID > 0 {
				selfSeatID = pl.SystemSeatID
			}
			if pl.TeamID > 0 {
				selfTeamID = pl.TeamID
			}
			if state.playerName == "" && playerName != "" {
				state.playerName = playerName
			}
			continue
		}
		if opponentName == "" {
			// Avoid ever setting self as opponent by name when known.
			if state.playerName != "" && strings.EqualFold(playerName, strings.TrimSpace(state.playerName)) {
				continue
			}
			opponentName = playerName
			opponentUserID = playerUserID
		}
	}

	if _, err := p.store.UpsertMatchStart(ctx, tx, config.MatchID, eventName, selfSeatID, matchTS); err != nil {
		return err
	}
	state.activeMatchID = strings.TrimSpace(config.MatchID)
	state.rememberSelfSeat(config.MatchID, selfSeatID)
	if eventName != "" {
		_ = p.store.LinkMatchToLatestDeckByEvent(ctx, tx, config.MatchID, eventName, "room_state")
	}

	if selfSeen && (strings.TrimSpace(opponentName) != "" || strings.TrimSpace(opponentUserID) != "") {
		if err := p.store.UpdateMatchOpponent(ctx, tx, config.MatchID, opponentName, opponentUserID); err != nil {
			return err
		}
	}

	if strings.EqualFold(strings.TrimSpace(info.StateType), "MatchGameRoomStateType_MatchCompleted") && selfTeamID > 0 && info.FinalMatchResult != nil {
		winningTeamID, reason := chooseMatchResult(info.FinalMatchResult.ResultList)
		if winningTeamID > 0 {
			if _, _, err := p.store.UpdateMatchEnd(ctx, tx, config.MatchID, selfTeamID, winningTeamID, 0, 0, reason, matchTS); err != nil {
				return err
			}
		}
	}

	if err := p.store.InsertRawEvent(ctx, tx, logPath, lineNo, byteOffset, "room_state", "matchGameRoomStateChangedEvent", "", nil, ""); err != nil {
		return err
	}
	stats.RawEventsStored++
	stats.MatchesUpserted++
	return nil
}
