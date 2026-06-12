package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

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
