package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/cschnabel/mtgdata/internal/model"
)

type Store struct {
	db *sql.DB
}

type IngestState struct {
	Offset int64
	LineNo int64
	Found  bool
}

type DeckCard struct {
	Section  string
	CardID   int64
	Quantity int64
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func normalizeTS(ts string) string {
	ts = strings.TrimSpace(ts)
	if ts == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ts
	}
	return parsed.UTC().Format(time.RFC3339Nano)
}

func (s *Store) BeginTx(ctx context.Context) (*sql.Tx, error) {
	return s.db.BeginTx(ctx, nil)
}

func (s *Store) GetIngestState(ctx context.Context, logPath string) (IngestState, error) {
	state := IngestState{}
	err := s.db.QueryRowContext(ctx, `
		SELECT byte_offset, line_no
		FROM ingest_state
		WHERE log_path = ?
	`, logPath).Scan(&state.Offset, &state.LineNo)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return state, fmt.Errorf("get ingest_state: %w", err)
	}
	state.Found = true
	return state, nil
}

func (s *Store) SaveIngestState(ctx context.Context, tx *sql.Tx, logPath string, offset, lineNo int64) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ingest_state (log_path, byte_offset, line_no, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(log_path) DO UPDATE SET
			byte_offset = excluded.byte_offset,
			line_no = excluded.line_no,
			updated_at = excluded.updated_at
	`, logPath, offset, lineNo, nowUTC())
	if err != nil {
		return fmt.Errorf("save ingest_state: %w", err)
	}
	return nil
}

func (s *Store) InsertRawEvent(ctx context.Context, tx *sql.Tx, logPath string, lineNo, byteOffset int64, kind, method, requestID string, payload []byte, rawText string) error {
	payloadText := ""
	if len(payload) > 0 {
		payloadText = string(payload)
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO events_raw (
			log_path, line_no, byte_offset, kind, method_name, request_id, payload_json, raw_text, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, logPath, lineNo, byteOffset, kind, method, requestID, payloadText, rawText, nowUTC())
	if err != nil {
		return fmt.Errorf("insert events_raw: %w", err)
	}
	return nil
}

func detectEventType(eventName string) string {
	e := strings.ToLower(eventName)
	switch {
	case strings.Contains(e, "quickdraft"):
		return "quick_draft"
	case strings.Contains(e, "premierdraft"):
		return "premier_draft"
	case strings.Contains(e, "traditionalsealed") || strings.Contains(e, "sealed"):
		return "sealed"
	case strings.Contains(e, "jump_in"):
		return "jump_in"
	case strings.Contains(e, "ladder"):
		return "ladder"
	default:
		return "other"
	}
}

var reSetKindEvent = regexp.MustCompile(`^([A-Za-z0-9]+)_(Quick_Draft|Premier_Draft|Sealed)$`)

func (s *Store) resolveEventNameAlias(ctx context.Context, tx *sql.Tx, eventName string) (string, error) {
	eventName = strings.TrimSpace(eventName)
	if eventName == "" {
		return "", nil
	}

	var existing string
	err := tx.QueryRowContext(ctx, `SELECT event_name FROM event_runs WHERE event_name = ? LIMIT 1`, eventName).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("resolve event alias exact match: %w", err)
	}

	matches := reSetKindEvent.FindStringSubmatch(eventName)
	if len(matches) != 3 {
		return eventName, nil
	}

	setCode := strings.ToLower(matches[1])
	kind := strings.ToLower(matches[2])
	likePattern := ""
	switch kind {
	case "quick_draft":
		likePattern = fmt.Sprintf("quickdraft_%s_%%", setCode)
	case "premier_draft":
		likePattern = fmt.Sprintf("premierdraft_%s_%%", setCode)
	case "sealed":
		likePattern = fmt.Sprintf("sealed_%s_%%", setCode)
	}
	if likePattern == "" {
		return eventName, nil
	}

	err = tx.QueryRowContext(ctx, `
		SELECT event_name
		FROM event_runs
		WHERE LOWER(event_name) LIKE ?
		ORDER BY COALESCE(started_at, updated_at) DESC
		LIMIT 1
	`, likePattern).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("resolve event alias pattern: %w", err)
	}

	return eventName, nil
}

func (s *Store) UpsertEventRunJoin(ctx context.Context, tx *sql.Tx, eventName, currencyType string, currencyPaid int64, ts string) error {
	eventType := detectEventType(eventName)
	ts = normalizeTS(ts)
	_, err := tx.ExecContext(ctx, `
		INSERT INTO event_runs (
			event_name, event_type, entry_currency_type, entry_currency_paid, status, started_at, updated_at
		) VALUES (?, ?, ?, ?, 'active', ?, ?)
		ON CONFLICT(event_name) DO UPDATE SET
			event_type = excluded.event_type,
			entry_currency_type = COALESCE(excluded.entry_currency_type, event_runs.entry_currency_type),
			entry_currency_paid = COALESCE(excluded.entry_currency_paid, event_runs.entry_currency_paid),
			updated_at = excluded.updated_at
	`, eventName, eventType, nullIfEmpty(currencyType), nullableInt(currencyPaid), nullIfEmpty(ts), nowUTC())
	if err != nil {
		return fmt.Errorf("upsert event_runs join: %w", err)
	}
	return nil
}

func (s *Store) MarkEventRunClaimed(ctx context.Context, tx *sql.Tx, eventName, ts string) error {
	ts = normalizeTS(ts)
	_, err := tx.ExecContext(ctx, `
		UPDATE event_runs
		SET status = 'claimed',
			ended_at = COALESCE(ended_at, ?),
			updated_at = ?
		WHERE event_name = ?
	`, nullIfEmpty(ts), nowUTC(), eventName)
	if err != nil {
		return fmt.Errorf("mark event run claimed: %w", err)
	}
	return nil
}

func (s *Store) BumpEventRunRecord(ctx context.Context, tx *sql.Tx, eventName, result string) error {
	if eventName == "" || (result != "win" && result != "loss") {
		return nil
	}
	col := "wins"
	if result == "loss" {
		col = "losses"
	}
	_, err := tx.ExecContext(ctx, fmt.Sprintf(`
		UPDATE event_runs
		SET %s = %s + 1,
			updated_at = ?
		WHERE event_name = ?
	`, col, col), nowUTC(), eventName)
	if err != nil {
		return fmt.Errorf("bump event run record: %w", err)
	}
	return nil
}

func nullableInt(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func nullIfEmpty(v string) any {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	return v
}

func (s *Store) UpsertDeck(ctx context.Context, tx *sql.Tx, arenaDeckID, eventName, name, format, source, lastUpdated string, cards []DeckCard) (int64, error) {
	now := nowUTC()
	lastUpdated = normalizeTS(lastUpdated)

	_, err := tx.ExecContext(ctx, `
		INSERT INTO decks (
			arena_deck_id, event_name, name, format, source, last_updated, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(arena_deck_id) DO UPDATE SET
			event_name = COALESCE(excluded.event_name, decks.event_name),
			name = COALESCE(excluded.name, decks.name),
			format = COALESCE(excluded.format, decks.format),
			source = COALESCE(excluded.source, decks.source),
			last_updated = COALESCE(excluded.last_updated, decks.last_updated),
			updated_at = excluded.updated_at
	`, arenaDeckID, nullIfEmpty(eventName), nullIfEmpty(name), nullIfEmpty(format), nullIfEmpty(source), nullIfEmpty(lastUpdated), now, now)
	if err != nil {
		return 0, fmt.Errorf("upsert deck: %w", err)
	}

	var deckID int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM decks WHERE arena_deck_id = ?`, arenaDeckID).Scan(&deckID)
	if err != nil {
		return 0, fmt.Errorf("fetch deck id: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM deck_cards WHERE deck_id = ?`, deckID); err != nil {
		return 0, fmt.Errorf("clear deck_cards: %w", err)
	}

	for _, c := range cards {
		if c.Quantity <= 0 {
			continue
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO deck_cards (deck_id, section, card_id, quantity)
			VALUES (?, ?, ?, ?)
		`, deckID, c.Section, c.CardID, c.Quantity)
		if err != nil {
			return 0, fmt.Errorf("insert deck_card: %w", err)
		}
	}

	return deckID, nil
}

func (s *Store) UpsertMatchStart(ctx context.Context, tx *sql.Tx, arenaMatchID, eventName string, seatID int64, startedAt string) (int64, error) {
	resolvedEventName := eventName
	if eventName != "" {
		alias, err := s.resolveEventNameAlias(ctx, tx, eventName)
		if err != nil {
			return 0, err
		}
		resolvedEventName = alias
	}

	startedAt = normalizeTS(startedAt)
	now := nowUTC()
	_, err := tx.ExecContext(ctx, `
		INSERT INTO matches (
			arena_match_id, event_name, player_seat_id, started_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(arena_match_id) DO UPDATE SET
			event_name = COALESCE(excluded.event_name, matches.event_name),
			player_seat_id = COALESCE(excluded.player_seat_id, matches.player_seat_id),
			started_at = COALESCE(matches.started_at, excluded.started_at),
			updated_at = excluded.updated_at
	`, arenaMatchID, nullIfEmpty(resolvedEventName), nullableInt(seatID), nullIfEmpty(startedAt), now, now)
	if err != nil {
		return 0, fmt.Errorf("upsert match start: %w", err)
	}

	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM matches WHERE arena_match_id = ?`, arenaMatchID).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("fetch match id: %w", err)
	}

	if resolvedEventName != "" {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO event_runs (event_name, event_type, status, started_at, updated_at)
			VALUES (?, ?, 'active', ?, ?)
			ON CONFLICT(event_name) DO UPDATE SET updated_at = excluded.updated_at
		`, resolvedEventName, detectEventType(resolvedEventName), nullIfEmpty(startedAt), now); err != nil {
			return 0, fmt.Errorf("ensure event run from match start: %w", err)
		}
	}

	return id, nil
}

func (s *Store) UpdateMatchOpponent(ctx context.Context, tx *sql.Tx, arenaMatchID, opponentName, opponentUserID string) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE matches
		SET opponent_name = COALESCE(?, opponent_name),
			opponent_user_id = COALESCE(?, opponent_user_id),
			updated_at = ?
		WHERE arena_match_id = ?
	`, nullIfEmpty(opponentName), nullIfEmpty(opponentUserID), nowUTC(), arenaMatchID)
	if err != nil {
		return fmt.Errorf("update match opponent: %w", err)
	}
	return nil
}

func (s *Store) UpdateMatchEnd(ctx context.Context, tx *sql.Tx, arenaMatchID string, teamID, winningTeamID, turnCount, secondsCount int64, winReason, endedAt string) (string, string, error) {
	endedAt = normalizeTS(endedAt)

	var eventName string
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(event_name, '') FROM matches WHERE arena_match_id = ?`, arenaMatchID).Scan(&eventName)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO matches (arena_match_id, ended_at, created_at, updated_at)
			VALUES (?, ?, ?, ?)
		`, arenaMatchID, endedAt, nowUTC(), nowUTC()); err != nil {
			return "", "", fmt.Errorf("create ended-only match: %w", err)
		}
		eventName = ""
	} else if err != nil {
		return "", "", fmt.Errorf("get match event name: %w", err)
	}

	result := "unknown"
	if teamID > 0 && winningTeamID > 0 {
		if teamID == winningTeamID {
			result = "win"
		} else {
			result = "loss"
		}
	}

	_, err = tx.ExecContext(ctx, `
		UPDATE matches
		SET ended_at = COALESCE(?, ended_at),
			result = ?,
			win_reason = COALESCE(?, win_reason),
			turn_count = COALESCE(?, turn_count),
			seconds_count = COALESCE(?, seconds_count),
			updated_at = ?
		WHERE arena_match_id = ?
	`, nullIfEmpty(endedAt), result, nullIfEmpty(winReason), nullableInt(turnCount), nullableInt(secondsCount), nowUTC(), arenaMatchID)
	if err != nil {
		return "", "", fmt.Errorf("update match end: %w", err)
	}

	if eventName != "" && (result == "win" || result == "loss") {
		if err := s.BumpEventRunRecord(ctx, tx, eventName, result); err != nil {
			return "", "", err
		}
	}

	return eventName, result, nil
}

func (s *Store) LinkMatchToLatestDeckByEvent(ctx context.Context, tx *sql.Tx, arenaMatchID, eventName, reason string) error {
	if eventName == "" {
		return nil
	}
	alias, err := s.resolveEventNameAlias(ctx, tx, eventName)
	if err != nil {
		return err
	}
	if alias != "" {
		eventName = alias
	}

	var matchID int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM matches WHERE arena_match_id = ?`, arenaMatchID).Scan(&matchID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("get match id: %w", err)
	}

	var deckID int64
	err = tx.QueryRowContext(ctx, `
		SELECT id
		FROM decks
		WHERE event_name = ?
		ORDER BY COALESCE(last_updated, updated_at) DESC
		LIMIT 1
	`, eventName).Scan(&deckID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("find deck for match: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO match_decks (match_id, deck_id, snapshot_reason, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(match_id, deck_id) DO NOTHING
	`, matchID, deckID, reason, nowUTC())
	if err != nil {
		return fmt.Errorf("link match_deck: %w", err)
	}

	return nil
}

func (s *Store) EnsureDraftSession(ctx context.Context, tx *sql.Tx, eventName string, draftID *string, isBot bool, ts string) (int64, error) {
	isBotInt := 0
	if isBot {
		isBotInt = 1
	}
	ts = normalizeTS(ts)

	var sessionID int64
	if draftID != nil && *draftID != "" {
		err := tx.QueryRowContext(ctx, `SELECT id FROM draft_sessions WHERE draft_id = ? AND is_bot_draft = ?`, *draftID, isBotInt).Scan(&sessionID)
		if err == nil {
			_, _ = tx.ExecContext(ctx, `
				UPDATE draft_sessions
				SET event_name = COALESCE(?, event_name), updated_at = ?
				WHERE id = ?
			`, nullIfEmpty(eventName), nowUTC(), sessionID)
			return sessionID, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return 0, fmt.Errorf("select draft session by draft_id: %w", err)
		}
	}

	if draftID == nil || *draftID == "" {
		// For bot drafts (or unknown IDs), reuse active session for same event if incomplete.
		err := tx.QueryRowContext(ctx, `
			SELECT id
			FROM draft_sessions
			WHERE event_name = ? AND is_bot_draft = ? AND completed_at IS NULL
			ORDER BY id DESC
			LIMIT 1
		`, eventName, isBotInt).Scan(&sessionID)
		if err == nil {
			return sessionID, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return 0, fmt.Errorf("select active draft session: %w", err)
		}
	}

	_, err := tx.ExecContext(ctx, `
		INSERT INTO draft_sessions (event_name, draft_id, is_bot_draft, started_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, nullIfEmpty(eventName), nullDraftID(draftID), isBotInt, nullIfEmpty(ts), nowUTC(), nowUTC())
	if err != nil {
		return 0, fmt.Errorf("insert draft_session: %w", err)
	}

	if err := tx.QueryRowContext(ctx, `SELECT last_insert_rowid()`).Scan(&sessionID); err != nil {
		return 0, fmt.Errorf("last_insert_rowid draft_session: %w", err)
	}

	return sessionID, nil
}

func nullDraftID(v *string) any {
	if v == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*v)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func (s *Store) InsertDraftPick(ctx context.Context, tx *sql.Tx, sessionID int64, packNo, pickNo int64, pickedIDs []int64, packIDs []int64, ts string) error {
	pickedJSON, _ := json.Marshal(pickedIDs)
	packJSON := []byte("[]")
	if len(packIDs) > 0 {
		packJSON, _ = json.Marshal(packIDs)
	}

	_, err := tx.ExecContext(ctx, `
		INSERT INTO draft_picks (
			draft_session_id, pack_number, pick_number, picked_card_ids, pack_card_ids, pick_ts, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(draft_session_id, pack_number, pick_number) DO UPDATE SET
			picked_card_ids = excluded.picked_card_ids,
			pack_card_ids = excluded.pack_card_ids,
			pick_ts = COALESCE(excluded.pick_ts, draft_picks.pick_ts)
	`, sessionID, packNo, pickNo, string(pickedJSON), string(packJSON), nullIfEmpty(normalizeTS(ts)), nowUTC())
	if err != nil {
		return fmt.Errorf("insert draft_pick: %w", err)
	}

	_, _ = tx.ExecContext(ctx, `UPDATE draft_sessions SET updated_at = ? WHERE id = ?`, nowUTC(), sessionID)
	return nil
}

func (s *Store) CompleteDraftSession(ctx context.Context, tx *sql.Tx, eventName string, draftID *string, isBot bool, ts string) error {
	isBotInt := 0
	if isBot {
		isBotInt = 1
	}
	ts = normalizeTS(ts)

	if draftID != nil && strings.TrimSpace(*draftID) != "" {
		_, err := tx.ExecContext(ctx, `
			UPDATE draft_sessions
			SET completed_at = COALESCE(completed_at, ?), updated_at = ?
			WHERE draft_id = ? AND is_bot_draft = ?
		`, ts, nowUTC(), strings.TrimSpace(*draftID), isBotInt)
		if err != nil {
			return fmt.Errorf("complete draft session by draft_id: %w", err)
		}
		return nil
	}

	if eventName != "" {
		_, err := tx.ExecContext(ctx, `
			UPDATE draft_sessions
			SET completed_at = COALESCE(completed_at, ?), updated_at = ?
			WHERE id = (
				SELECT id FROM draft_sessions
				WHERE event_name = ? AND is_bot_draft = ?
				ORDER BY id DESC LIMIT 1
			)
		`, ts, nowUTC(), eventName, isBotInt)
		if err != nil {
			return fmt.Errorf("complete draft session by event_name: %w", err)
		}
	}

	return nil
}

func (s *Store) Overview(ctx context.Context, recentLimit int64) (model.Overview, error) {
	out := model.Overview{}
	if recentLimit <= 0 {
		recentLimit = 20
	}

	err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*) AS total,
			SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
			SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
		FROM matches
	`).Scan(&out.TotalMatches, &out.Wins, &out.Losses)
	if err != nil {
		return out, fmt.Errorf("overview aggregate: %w", err)
	}
	if out.TotalMatches > 0 {
		out.WinRate = float64(out.Wins) / float64(out.TotalMatches)
	}

	recent, err := s.ListMatches(ctx, recentLimit, "", "")
	if err != nil {
		return out, err
	}
	out.Recent = recent
	return out, nil
}

func (s *Store) ListMatches(ctx context.Context, limit int64, eventName, result string) ([]model.MatchRow, error) {
	if limit <= 0 {
		limit = 200
	}
	query := `
		SELECT
			m.id,
			m.arena_match_id,
			COALESCE(m.event_name, ''),
			COALESCE(m.opponent_name, ''),
			COALESCE(m.started_at, ''),
			COALESCE(m.ended_at, ''),
			COALESCE(m.result, 'unknown'),
			COALESCE(m.win_reason, ''),
			m.turn_count,
			m.seconds_count,
			d.id,
			d.name
		FROM matches m
		LEFT JOIN match_decks md ON md.match_id = m.id
		LEFT JOIN decks d ON d.id = md.deck_id
		WHERE (? = '' OR m.event_name = ?)
		  AND (? = '' OR m.result = ?)
		ORDER BY COALESCE(m.started_at, m.ended_at, m.updated_at) DESC
		LIMIT ?
	`
	rows, err := s.db.QueryContext(ctx, query, eventName, eventName, result, result, limit)
	if err != nil {
		return nil, fmt.Errorf("list matches: %w", err)
	}
	defer rows.Close()

	resultRows := make([]model.MatchRow, 0, limit)
	for rows.Next() {
		var r model.MatchRow
		if err := rows.Scan(
			&r.ID,
			&r.ArenaMatchID,
			&r.EventName,
			&r.Opponent,
			&r.StartedAt,
			&r.EndedAt,
			&r.Result,
			&r.WinReason,
			&r.TurnCount,
			&r.SecondsCount,
			&r.DeckID,
			&r.DeckName,
		); err != nil {
			return nil, fmt.Errorf("scan match row: %w", err)
		}
		resultRows = append(resultRows, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate matches: %w", err)
	}

	return resultRows, nil
}

func (s *Store) ListDecks(ctx context.Context) ([]model.DeckSummaryRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			d.id,
			COALESCE(d.name, d.arena_deck_id) AS deck_name,
			COALESCE(d.format, ''),
			COALESCE(d.event_name, ''),
			COUNT(m.id) AS matches,
			SUM(CASE WHEN m.result = 'win' THEN 1 ELSE 0 END) AS wins,
			SUM(CASE WHEN m.result = 'loss' THEN 1 ELSE 0 END) AS losses
		FROM decks d
		LEFT JOIN match_decks md ON md.deck_id = d.id
		LEFT JOIN matches m ON m.id = md.match_id
		GROUP BY d.id, d.name, d.arena_deck_id, d.format, d.event_name
		ORDER BY matches DESC, deck_name ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list decks: %w", err)
	}
	defer rows.Close()

	var out []model.DeckSummaryRow
	for rows.Next() {
		var r model.DeckSummaryRow
		if err := rows.Scan(&r.DeckID, &r.DeckName, &r.Format, &r.EventName, &r.Matches, &r.Wins, &r.Losses); err != nil {
			return nil, fmt.Errorf("scan deck summary: %w", err)
		}
		if r.Matches > 0 {
			r.WinRate = float64(r.Wins) / float64(r.Matches)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate decks: %w", err)
	}
	return out, nil
}

func (s *Store) GetDeckDetail(ctx context.Context, deckID int64, matchLimit int64) (model.DeckDetail, error) {
	var out model.DeckDetail
	if matchLimit <= 0 {
		matchLimit = 50
	}

	err := s.db.QueryRowContext(ctx, `
		SELECT id, arena_deck_id, COALESCE(name, ''), COALESCE(format, ''), COALESCE(event_name, '')
		FROM decks
		WHERE id = ?
	`, deckID).Scan(&out.DeckID, &out.ArenaDeckID, &out.Name, &out.Format, &out.EventName)
	if err != nil {
		return out, fmt.Errorf("get deck: %w", err)
	}

	cardRows, err := s.db.QueryContext(ctx, `
		SELECT section, card_id, quantity
		FROM deck_cards
		WHERE deck_id = ?
		ORDER BY section, card_id
	`, deckID)
	if err != nil {
		return out, fmt.Errorf("get deck cards: %w", err)
	}
	defer cardRows.Close()

	for cardRows.Next() {
		var c model.DeckCardRow
		if err := cardRows.Scan(&c.Section, &c.CardID, &c.Quantity); err != nil {
			return out, fmt.Errorf("scan deck card: %w", err)
		}
		out.Cards = append(out.Cards, c)
	}
	if err := cardRows.Err(); err != nil {
		return out, fmt.Errorf("iterate deck cards: %w", err)
	}

	matchRows, err := s.db.QueryContext(ctx, `
		SELECT
			m.id,
			m.arena_match_id,
			COALESCE(m.event_name, ''),
			COALESCE(m.opponent_name, ''),
			COALESCE(m.started_at, ''),
			COALESCE(m.ended_at, ''),
			COALESCE(m.result, 'unknown'),
			COALESCE(m.win_reason, ''),
			m.turn_count,
			m.seconds_count
		FROM matches m
		JOIN match_decks md ON md.match_id = m.id
		WHERE md.deck_id = ?
		ORDER BY COALESCE(m.started_at, m.ended_at, m.updated_at) DESC
		LIMIT ?
	`, deckID, matchLimit)
	if err != nil {
		return out, fmt.Errorf("get deck matches: %w", err)
	}
	defer matchRows.Close()

	for matchRows.Next() {
		var m model.MatchRow
		if err := matchRows.Scan(
			&m.ID,
			&m.ArenaMatchID,
			&m.EventName,
			&m.Opponent,
			&m.StartedAt,
			&m.EndedAt,
			&m.Result,
			&m.WinReason,
			&m.TurnCount,
			&m.SecondsCount,
		); err != nil {
			return out, fmt.Errorf("scan deck match row: %w", err)
		}
		out.Matches = append(out.Matches, m)
	}
	if err := matchRows.Err(); err != nil {
		return out, fmt.Errorf("iterate deck matches: %w", err)
	}

	return out, nil
}

func (s *Store) ListDraftSessions(ctx context.Context) ([]model.DraftSessionRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			ds.id,
			COALESCE(ds.event_name, ''),
			ds.draft_id,
			ds.is_bot_draft,
			COALESCE(ds.started_at, ''),
			COALESCE(ds.completed_at, ''),
			COUNT(dp.id) AS picks
		FROM draft_sessions ds
		LEFT JOIN draft_picks dp ON dp.draft_session_id = ds.id
		GROUP BY ds.id, ds.event_name, ds.draft_id, ds.is_bot_draft, ds.started_at, ds.completed_at
		ORDER BY ds.id DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list draft sessions: %w", err)
	}
	defer rows.Close()

	var out []model.DraftSessionRow
	for rows.Next() {
		var row model.DraftSessionRow
		var isBotInt int64
		if err := rows.Scan(&row.ID, &row.EventName, &row.DraftID, &isBotInt, &row.StartedAt, &row.CompletedAt, &row.Picks); err != nil {
			return nil, fmt.Errorf("scan draft session row: %w", err)
		}
		row.IsBotDraft = isBotInt == 1
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate draft sessions: %w", err)
	}

	return out, nil
}

func (s *Store) ListDraftPicks(ctx context.Context, draftSessionID int64) ([]model.DraftPickRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, pack_number, pick_number, picked_card_ids, COALESCE(pack_card_ids, '[]'), COALESCE(pick_ts, '')
		FROM draft_picks
		WHERE draft_session_id = ?
		ORDER BY pack_number, pick_number
	`, draftSessionID)
	if err != nil {
		return nil, fmt.Errorf("list draft picks: %w", err)
	}
	defer rows.Close()

	var out []model.DraftPickRow
	for rows.Next() {
		var r model.DraftPickRow
		if err := rows.Scan(&r.ID, &r.PackNumber, &r.PickNumber, &r.PickedCardIDs, &r.PackCardIDs, &r.PickTs); err != nil {
			return nil, fmt.Errorf("scan draft pick row: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate draft picks: %w", err)
	}

	return out, nil
}
