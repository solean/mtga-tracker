package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/solean/ponder/internal/model"
)

// GetDeckPrimer returns the cached AI primer for a deck, or (nil, nil) when
// none has been generated yet.
func (s *Store) GetDeckPrimer(ctx context.Context, deckID int64) (*model.DeckPrimer, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT deck_id, cards_hash, model, content, created_at
		FROM deck_ai_primers
		WHERE deck_id = ?
	`, deckID)

	var out model.DeckPrimer
	err := row.Scan(&out.DeckID, &out.CardsHash, &out.Model, &out.Content, &out.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get deck primer: %w", err)
	}
	return &out, nil
}

// UpsertDeckPrimer stores (or replaces) the AI primer for a deck and returns
// the stored row.
func (s *Store) UpsertDeckPrimer(ctx context.Context, deckID int64, cardsHash, modelName, content string) (*model.DeckPrimer, error) {
	createdAt := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO deck_ai_primers (deck_id, cards_hash, model, content, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(deck_id) DO UPDATE SET
			cards_hash = excluded.cards_hash,
			model = excluded.model,
			content = excluded.content,
			created_at = excluded.created_at
	`, deckID, cardsHash, modelName, content, createdAt)
	if err != nil {
		return nil, fmt.Errorf("upsert deck primer: %w", err)
	}
	return &model.DeckPrimer{
		DeckID:    deckID,
		CardsHash: cardsHash,
		Model:     modelName,
		Content:   content,
		CreatedAt: createdAt,
	}, nil
}
