package ingest

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/solean/ponder/internal/db"
)

func TestParserTracksEconomySnapshotsFromInventoryInfo(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	tmpDir := t.TempDir()
	database, err := db.Open(filepath.Join(tmpDir, "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()
	if err := db.Init(ctx, database); err != nil {
		t.Fatalf("init db: %v", err)
	}

	logPath := filepath.Join(tmpDir, "Player.log")
	lines := []string{
		`[UnityCrossThreadLogger]7/12/2026 11:40:38 AM`,
		`<== StartHook(request-1)`,
		`{"InventoryInfo":{"SeqId":4,"Changes":[{"Source":"QuestReward","SourceId":"quest-1"}],"Gems":1200,"Gold":3450,"TotalVaultProgress":487,"wcTrackPosition":3,"WildCardCommons":20,"WildCardUnCommons":18,"WildCardRares":7,"WildCardMythics":2,"CustomTokens":{"PlayInToken":1,"Token_JumpIn":2},"Boosters":[{"CollationId":100061,"SetCode":"TST"},{"CollationId":100061,"SetCode":"TST"}],"Vouchers":{"DraftToken":1},"Cosmetics":{"ArtStyles":[{"Id":"ignored"}]}},"Decks":{"ignored":{"MainDeck":[]}}}`,
	}
	if err := writeLogLines(logPath, lines, false); err != nil {
		t.Fatalf("write log: %v", err)
	}

	store := db.NewStore(database)
	parser := NewParser(store)
	stats, err := parser.ParseFile(ctx, logPath, false)
	if err != nil {
		t.Fatalf("parse file: %v", err)
	}
	if stats.EconomySnapshots != 1 {
		t.Fatalf("EconomySnapshots = %d, want 1", stats.EconomySnapshots)
	}

	history, err := store.ListEconomyHistory(ctx)
	if err != nil {
		t.Fatalf("ListEconomyHistory: %v", err)
	}
	if len(history) != 1 {
		t.Fatalf("history length = %d, want 1", len(history))
	}
	snapshot := history[0]
	if snapshot.ObservedAt == "" {
		t.Fatal("ObservedAt is empty")
	}
	if snapshot.SequenceID != 4 || snapshot.Gold != 3450 || snapshot.Gems != 1200 {
		t.Fatalf("core balances = seq %d, gold %d, gems %d", snapshot.SequenceID, snapshot.Gold, snapshot.Gems)
	}
	if snapshot.VaultProgress != 487 || snapshot.WildcardTrackPosition != 3 {
		t.Fatalf("vault/track = %d/%d, want 487/3", snapshot.VaultProgress, snapshot.WildcardTrackPosition)
	}
	if snapshot.Wildcards.Common != 20 || snapshot.Wildcards.Uncommon != 18 ||
		snapshot.Wildcards.Rare != 7 || snapshot.Wildcards.Mythic != 2 {
		t.Fatalf("wildcards = %+v", snapshot.Wildcards)
	}
	if snapshot.CustomTokens["PlayInToken"] != 1 || snapshot.CustomTokens["Token_JumpIn"] != 2 {
		t.Fatalf("custom tokens = %#v", snapshot.CustomTokens)
	}
	if len(snapshot.Boosters) != 1 || snapshot.Boosters[0].SetCode != "TST" || snapshot.Boosters[0].Count != 2 {
		t.Fatalf("boosters = %#v, want two TST boosters", snapshot.Boosters)
	}
	if snapshot.Vouchers["DraftToken"] != 1 {
		t.Fatalf("vouchers = %#v", snapshot.Vouchers)
	}
	if len(snapshot.ChangeSources) != 1 || snapshot.ChangeSources[0] != "QuestReward" {
		t.Fatalf("change sources = %#v", snapshot.ChangeSources)
	}

	stats, err = parser.ParseFile(ctx, logPath, false)
	if err != nil {
		t.Fatalf("reparse file: %v", err)
	}
	if stats.EconomySnapshots != 0 {
		t.Fatalf("EconomySnapshots after reparse = %d, want 0", stats.EconomySnapshots)
	}
	history, err = store.ListEconomyHistory(ctx)
	if err != nil {
		t.Fatalf("ListEconomyHistory after reparse: %v", err)
	}
	if len(history) != 1 {
		t.Fatalf("history length after reparse = %d, want 1", len(history))
	}
}
