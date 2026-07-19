package ingest

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/solean/ponder/internal/db"
	"github.com/solean/ponder/internal/model"
)

type inventoryInfoPayload struct {
	SequenceID            int64           `json:"SeqId"`
	Changes               json.RawMessage `json:"Changes"`
	Gems                  int64           `json:"Gems"`
	Gold                  int64           `json:"Gold"`
	VaultProgress         int64           `json:"TotalVaultProgress"`
	WildcardTrackPosition int64           `json:"wcTrackPosition"`
	WildcardCommons       int64           `json:"WildCardCommons"`
	WildcardUncommons     int64           `json:"WildCardUnCommons"`
	WildcardRares         int64           `json:"WildCardRares"`
	WildcardMythics       int64           `json:"WildCardMythics"`
	CustomTokens          json.RawMessage `json:"CustomTokens"`
	Boosters              json.RawMessage `json:"Boosters"`
	Vouchers              json.RawMessage `json:"Vouchers"`
}

// Arena reports inventory either nested under "InventoryInfo" or, for module
// responses like draft card-pool grants, as a top-level "DTO_InventoryInfo".
type economyEnvelope struct {
	InventoryInfo    *inventoryInfoPayload `json:"InventoryInfo"`
	DTOInventoryInfo *inventoryInfoPayload `json:"DTO_InventoryInfo"`
}

func (p *Parser) handleEconomyJSON(
	ctx context.Context,
	tx *sql.Tx,
	stats *model.ParseStats,
	state *parseState,
	logPath string,
	lineNo int64,
	line string,
) error {
	var envelope economyEnvelope
	if err := json.Unmarshal([]byte(line), &envelope); err != nil {
		return nil
	}
	inventory := envelope.InventoryInfo
	if inventory == nil {
		inventory = envelope.DTOInventoryInfo
	}
	if inventory == nil {
		return nil
	}
	snapshotID, inserted, err := p.store.InsertEconomySnapshot(ctx, tx, logPath, lineNo, db.EconomySnapshotRecord{
		ObservedAt:            state.lastUnityLogTimestamp,
		SequenceID:            inventory.SequenceID,
		Gold:                  inventory.Gold,
		Gems:                  inventory.Gems,
		VaultProgress:         inventory.VaultProgress,
		WildcardTrackPosition: inventory.WildcardTrackPosition,
		WildcardCommons:       inventory.WildcardCommons,
		WildcardUncommons:     inventory.WildcardUncommons,
		WildcardRares:         inventory.WildcardRares,
		WildcardMythics:       inventory.WildcardMythics,
		CustomTokensJSON:      string(inventory.CustomTokens),
		BoostersJSON:          string(inventory.Boosters),
		VouchersJSON:          string(inventory.Vouchers),
		ChangesJSON:           string(inventory.Changes),
	})
	if err != nil {
		return err
	}
	if inserted {
		stats.EconomySnapshots++
		if _, err := p.store.DeriveEconomyTransactions(
			ctx, tx, snapshotID, state.lastUnityLogTimestamp, string(inventory.Changes),
		); err != nil {
			return err
		}
	}
	return nil
}
