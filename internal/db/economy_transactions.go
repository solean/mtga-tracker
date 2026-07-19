package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/solean/ponder/internal/model"
)

// EconomyChange is one decoded entry of an InventoryInfo Changes array.
type EconomyChange struct {
	Source             string
	SourceID           string
	GoldDelta          int64
	GemsDelta          int64
	WildcardDeltas     model.WildcardBalance
	CardsGranted       int64
	VaultProgressDelta int64
	BoostersDelta      []model.EconomyBoosterCount
	CustomTokensDelta  map[string]int64
	VouchersDelta      map[string]int64
}

type rawEconomyChange struct {
	Source            string          `json:"Source"`
	SourceID          string          `json:"SourceId"`
	InventoryGold     int64           `json:"InventoryGold"`
	InventoryGems     int64           `json:"InventoryGems"`
	WildcardCommons   int64           `json:"InventoryWildCardCommons"`
	WildcardUncommons int64           `json:"InventoryWildCardUnCommons"`
	WildcardRares     int64           `json:"InventoryWildCardRares"`
	WildcardMythics   int64           `json:"InventoryWildCardMythics"`
	CustomTokens      json.RawMessage `json:"InventoryCustomTokens"`
	Boosters          json.RawMessage `json:"Boosters"`
	Vouchers          json.RawMessage `json:"Vouchers"`
	GrantedCards      []struct {
		GrpID         int64 `json:"GrpId"`
		CardAdded     bool  `json:"CardAdded"`
		VaultProgress int64 `json:"VaultProgress"`
	} `json:"GrantedCards"`
}

// DecodeEconomyChanges parses a Changes array into normalized deltas. Gems
// granted for duplicate cards inside GrantedCards are already included in
// InventoryGems, so only per-card VaultProgress is summed separately.
func DecodeEconomyChanges(changesJSON string) []EconomyChange {
	var raw []rawEconomyChange
	if json.Unmarshal([]byte(changesJSON), &raw) != nil || len(raw) == 0 {
		return nil
	}

	out := make([]EconomyChange, 0, len(raw))
	for _, entry := range raw {
		change := EconomyChange{
			Source:    strings.TrimSpace(entry.Source),
			SourceID:  strings.TrimSpace(entry.SourceID),
			GoldDelta: entry.InventoryGold,
			GemsDelta: entry.InventoryGems,
			WildcardDeltas: model.WildcardBalance{
				Common:   entry.WildcardCommons,
				Uncommon: entry.WildcardUncommons,
				Rare:     entry.WildcardRares,
				Mythic:   entry.WildcardMythics,
			},
			BoostersDelta:     decodeBoosterCounts(string(entry.Boosters)),
			CustomTokensDelta: decodeIntMap(string(entry.CustomTokens)),
			VouchersDelta:     decodeIntMap(string(entry.Vouchers)),
		}
		for _, card := range entry.GrantedCards {
			change.CardsGranted++
			change.VaultProgressDelta += card.VaultProgress
		}
		out = append(out, change)
	}
	return out
}

// Sources whose SourceId is the EventPayEntry GUID of the run they belong to.
func economyChangeUsesPaySourceID(source string) bool {
	switch source {
	case "EventReward", "EventPayEntry", "EventRefund":
		return true
	}
	return false
}

const economyEventLinkWindowMinutes = 15.0

// DeriveEconomyTransactions decodes a snapshot's Changes payload into
// economy_transactions rows and attributes event-related changes to
// event_runs. Linking is exact where the payload names the event
// (EventGrantCardPool) or where the pay GUID is already recorded; otherwise a
// 15-minute proximity window against event_runs timestamps is used and
// labeled as such. Inserts are idempotent per (snapshot, change index).
func (s *Store) DeriveEconomyTransactions(
	ctx context.Context,
	tx *sql.Tx,
	snapshotID int64,
	observedAt string,
	changesJSON string,
) (int64, error) {
	changes := DecodeEconomyChanges(changesJSON)
	if len(changes) == 0 {
		return 0, nil
	}

	observedAt = normalizeTS(observedAt)
	inserted := int64(0)
	for index, change := range changes {
		if change.Source == "" {
			continue
		}

		eventName, eventLink, err := s.linkEconomyChangeToEvent(ctx, tx, change, observedAt)
		if err != nil {
			return inserted, err
		}

		boostersJSON, err := json.Marshal(change.BoostersDelta)
		if err != nil {
			return inserted, fmt.Errorf("encode booster deltas: %w", err)
		}
		customTokensJSON, err := json.Marshal(change.CustomTokensDelta)
		if err != nil {
			return inserted, fmt.Errorf("encode custom token deltas: %w", err)
		}
		vouchersJSON, err := json.Marshal(change.VouchersDelta)
		if err != nil {
			return inserted, fmt.Errorf("encode voucher deltas: %w", err)
		}

		result, err := tx.ExecContext(ctx, `
			INSERT INTO economy_transactions (
				snapshot_id,
				change_index,
				observed_at,
				source,
				source_id,
				event_name,
				event_link,
				gold_delta,
				gems_delta,
				wildcard_common_delta,
				wildcard_uncommon_delta,
				wildcard_rare_delta,
				wildcard_mythic_delta,
				cards_granted,
				vault_progress_delta,
				boosters_delta_json,
				custom_tokens_delta_json,
				vouchers_delta_json,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(snapshot_id, change_index) DO NOTHING
		`, snapshotID, index, nullIfEmpty(observedAt), change.Source, nullIfEmpty(change.SourceID),
			nullIfEmpty(eventName), nullIfEmpty(eventLink),
			change.GoldDelta, change.GemsDelta,
			change.WildcardDeltas.Common, change.WildcardDeltas.Uncommon,
			change.WildcardDeltas.Rare, change.WildcardDeltas.Mythic,
			change.CardsGranted, change.VaultProgressDelta,
			string(boostersJSON), string(customTokensJSON), string(vouchersJSON), nowUTC())
		if err != nil {
			return inserted, fmt.Errorf("insert economy transaction: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return inserted, fmt.Errorf("count inserted economy transactions: %w", err)
		}
		inserted += rows

		// Remember the pay GUID on the run so later EventReward changes with
		// the same SourceId link exactly instead of by proximity.
		if rows > 0 && change.Source == "EventPayEntry" && change.SourceID != "" && eventName != "" {
			if _, err := tx.ExecContext(ctx, `
				UPDATE event_runs
				SET pay_source_id = COALESCE(pay_source_id, ?), updated_at = ?
				WHERE event_name = ?
			`, change.SourceID, nowUTC(), eventName); err != nil {
				return inserted, fmt.Errorf("record event pay source id: %w", err)
			}
		}
	}
	return inserted, nil
}

func (s *Store) linkEconomyChangeToEvent(
	ctx context.Context,
	tx *sql.Tx,
	change EconomyChange,
	observedAt string,
) (eventName, eventLink string, err error) {
	switch change.Source {
	case "EventGrantCardPool":
		if change.SourceID == "" {
			return "", "", nil
		}
		var name string
		err := tx.QueryRowContext(ctx, `
			SELECT event_name FROM event_runs WHERE event_name = ?
		`, change.SourceID).Scan(&name)
		if err == nil {
			return name, "event_name", nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("link card pool grant to event: %w", err)
		}
		// The event name is authoritative even without a tracked run.
		return change.SourceID, "event_name", nil
	}

	if !economyChangeUsesPaySourceID(change.Source) {
		return "", "", nil
	}

	if change.SourceID != "" {
		var name string
		err := tx.QueryRowContext(ctx, `
			SELECT event_name FROM event_runs WHERE pay_source_id = ?
		`, change.SourceID).Scan(&name)
		if err == nil {
			return name, "source_id", nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("link economy change by pay source id: %w", err)
		}
	}

	if observedAt == "" {
		return "", "", nil
	}

	// Proximity fallback: the pay change lands seconds after EventJoin sets
	// started_at, and rewards land seconds after EventClaimPrize sets
	// ended_at. Ladder-style runs never pay or claim, so exclude free entries.
	timeColumn := "started_at"
	if change.Source == "EventReward" {
		timeColumn = "ended_at"
	}
	query := fmt.Sprintf(`
		SELECT event_name
		FROM event_runs
		WHERE %[1]s IS NOT NULL AND %[1]s != ''
		  AND COALESCE(entry_currency_type, 'None') != 'None'
		  AND ABS(julianday(?) - julianday(%[1]s)) * 1440.0 <= ?
		ORDER BY ABS(julianday(?) - julianday(%[1]s)) ASC
		LIMIT 1
	`, timeColumn)
	var name string
	err = tx.QueryRowContext(ctx, query, observedAt, economyEventLinkWindowMinutes, observedAt).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("link economy change by proximity: %w", err)
	}
	return name, "proximity", nil
}

// backfillEconomyTransactions derives normalized transactions for snapshots
// stored before the ledger existed. It is idempotent: only snapshots with a
// non-empty Changes payload and no derived rows are processed, so the routine
// can run on every startup.
func backfillEconomyTransactions(ctx context.Context, conn dbConn, store *Store) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin economy transaction backfill: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
		SELECT es.id, COALESCE(es.observed_at, ''), es.changes_json
		FROM economy_snapshots es
		WHERE es.changes_json != '[]'
		  AND NOT EXISTS (
			SELECT 1 FROM economy_transactions et WHERE et.snapshot_id = es.id
		  )
		ORDER BY COALESCE(es.observed_at, es.created_at) ASC, es.id ASC
	`)
	if err != nil {
		return fmt.Errorf("list snapshots for economy transaction backfill: %w", err)
	}
	type pendingSnapshot struct {
		id          int64
		observedAt  string
		changesJSON string
	}
	pending := make([]pendingSnapshot, 0)
	for rows.Next() {
		var snapshot pendingSnapshot
		if err := rows.Scan(&snapshot.id, &snapshot.observedAt, &snapshot.changesJSON); err != nil {
			rows.Close()
			return fmt.Errorf("scan snapshot for economy transaction backfill: %w", err)
		}
		pending = append(pending, snapshot)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate snapshots for economy transaction backfill: %w", err)
	}
	rows.Close()

	for _, snapshot := range pending {
		if _, err := store.DeriveEconomyTransactions(ctx, tx, snapshot.id, snapshot.observedAt, snapshot.changesJSON); err != nil {
			return fmt.Errorf("backfill economy transactions for snapshot %d: %w", snapshot.id, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit economy transaction backfill: %w", err)
	}
	return nil
}

// migrateEconomyTables brings pre-ledger databases up to the current economy
// schema. Purely additive and safe to run repeatedly.
func migrateEconomyTables(ctx context.Context, conn dbConn) error {
	hasPaySourceID, err := tableHasColumn(ctx, conn, "event_runs", "pay_source_id")
	if err != nil {
		return fmt.Errorf("inspect event_runs pay source schema: %w", err)
	}
	if !hasPaySourceID {
		if _, err := conn.ExecContext(ctx, `
			ALTER TABLE event_runs ADD COLUMN pay_source_id TEXT
		`); err != nil {
			return fmt.Errorf("add event_runs pay source id: %w", err)
		}
	}
	return nil
}
