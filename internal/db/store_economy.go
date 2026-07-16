package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/solean/ponder/internal/model"
)

type EconomySnapshotRecord struct {
	ObservedAt            string
	SequenceID            int64
	Gold                  int64
	Gems                  int64
	VaultProgress         int64
	WildcardTrackPosition int64
	WildcardCommons       int64
	WildcardUncommons     int64
	WildcardRares         int64
	WildcardMythics       int64
	CustomTokensJSON      string
	BoostersJSON          string
	VouchersJSON          string
	ChangesJSON           string
}

func (s *Store) InsertEconomySnapshot(
	ctx context.Context,
	tx *sql.Tx,
	logPath string,
	lineNo int64,
	snapshot EconomySnapshotRecord,
) (bool, error) {
	snapshot.ObservedAt = normalizeTS(snapshot.ObservedAt)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO economy_snapshots (
			log_path,
			line_no,
			observed_at,
			sequence_id,
			gold,
			gems,
			vault_progress,
			wildcard_track_position,
			wildcard_commons,
			wildcard_uncommons,
			wildcard_rares,
			wildcard_mythics,
			custom_tokens_json,
			boosters_json,
			vouchers_json,
			changes_json,
			created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(log_path, line_no) DO NOTHING
	`, logPath, lineNo, nullIfEmpty(snapshot.ObservedAt), snapshot.SequenceID,
		snapshot.Gold, snapshot.Gems, snapshot.VaultProgress, snapshot.WildcardTrackPosition,
		snapshot.WildcardCommons, snapshot.WildcardUncommons, snapshot.WildcardRares,
		snapshot.WildcardMythics, jsonOrDefault(snapshot.CustomTokensJSON, "{}"),
		jsonOrDefault(snapshot.BoostersJSON, "[]"), jsonOrDefault(snapshot.VouchersJSON, "{}"),
		jsonOrDefault(snapshot.ChangesJSON, "[]"), nowUTC())
	if err != nil {
		return false, fmt.Errorf("insert economy snapshot: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("count inserted economy snapshots: %w", err)
	}
	return rowsAffected > 0, nil
}

func (s *Store) ListEconomyHistory(ctx context.Context) ([]model.EconomySnapshot, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			id,
			COALESCE(observed_at, ''),
			sequence_id,
			gold,
			gems,
			vault_progress,
			wildcard_track_position,
			wildcard_commons,
			wildcard_uncommons,
			wildcard_rares,
			wildcard_mythics,
			custom_tokens_json,
			boosters_json,
			vouchers_json,
			changes_json
		FROM economy_snapshots
		ORDER BY COALESCE(observed_at, created_at) ASC, id ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list economy history: %w", err)
	}
	defer rows.Close()

	out := make([]model.EconomySnapshot, 0)
	for rows.Next() {
		var snapshot model.EconomySnapshot
		var customTokensJSON, boostersJSON, vouchersJSON, changesJSON string
		if err := rows.Scan(
			&snapshot.ID,
			&snapshot.ObservedAt,
			&snapshot.SequenceID,
			&snapshot.Gold,
			&snapshot.Gems,
			&snapshot.VaultProgress,
			&snapshot.WildcardTrackPosition,
			&snapshot.Wildcards.Common,
			&snapshot.Wildcards.Uncommon,
			&snapshot.Wildcards.Rare,
			&snapshot.Wildcards.Mythic,
			&customTokensJSON,
			&boostersJSON,
			&vouchersJSON,
			&changesJSON,
		); err != nil {
			return nil, fmt.Errorf("scan economy snapshot: %w", err)
		}

		snapshot.CustomTokens = decodeIntMap(customTokensJSON)
		snapshot.Boosters = decodeBoosterCounts(boostersJSON)
		snapshot.Vouchers = decodeIntMap(vouchersJSON)
		snapshot.ChangeSources = decodeChangeSources(changesJSON)
		out = append(out, snapshot)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate economy history: %w", err)
	}
	return out, nil
}

func jsonOrDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func decodeIntMap(payload string) map[string]int64 {
	var raw map[string]json.RawMessage
	if json.Unmarshal([]byte(payload), &raw) != nil || len(raw) == 0 {
		return map[string]int64{}
	}
	out := make(map[string]int64, len(raw))
	for key, value := range raw {
		var count int64
		if json.Unmarshal(value, &count) == nil {
			out[key] = count
		}
	}
	return out
}

func decodeBoosterCounts(payload string) []model.EconomyBoosterCount {
	var boosters []struct {
		SetCode  string `json:"SetCode"`
		Count    int64  `json:"Count"`
		Quantity int64  `json:"Quantity"`
	}
	if json.Unmarshal([]byte(payload), &boosters) != nil || len(boosters) == 0 {
		return []model.EconomyBoosterCount{}
	}
	counts := make(map[string]int64)
	for _, booster := range boosters {
		setCode := strings.ToUpper(strings.TrimSpace(booster.SetCode))
		if setCode == "" {
			continue
		}
		count := max(booster.Count, booster.Quantity)
		if count <= 0 {
			count = 1
		}
		counts[setCode] += count
	}
	out := make([]model.EconomyBoosterCount, 0, len(counts))
	for setCode, count := range counts {
		out = append(out, model.EconomyBoosterCount{SetCode: setCode, Count: count})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SetCode < out[j].SetCode })
	return out
}

func decodeChangeSources(payload string) []string {
	var changes []struct {
		Source string `json:"Source"`
	}
	if json.Unmarshal([]byte(payload), &changes) != nil || len(changes) == 0 {
		return []string{}
	}
	seen := make(map[string]struct{}, len(changes))
	out := make([]string, 0, len(changes))
	for _, change := range changes {
		source := strings.TrimSpace(change.Source)
		if source == "" {
			continue
		}
		if _, exists := seen[source]; exists {
			continue
		}
		seen[source] = struct{}{}
		out = append(out, source)
	}
	return out
}
