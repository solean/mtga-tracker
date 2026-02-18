package model

import "time"

type ParseStats struct {
	LogPath         string
	LinesRead       int64
	BytesRead       int64
	RawEventsStored int64
	MatchesUpserted int64
	DecksUpserted   int64
	DraftPicksAdded int64
	StartedAt       time.Time
	CompletedAt     time.Time
}

type MatchRow struct {
	ID           int64   `json:"id"`
	ArenaMatchID string  `json:"arenaMatchId"`
	EventName    string  `json:"eventName"`
	Opponent     string  `json:"opponent"`
	StartedAt    string  `json:"startedAt"`
	EndedAt      string  `json:"endedAt"`
	Result       string  `json:"result"`
	WinReason    string  `json:"winReason"`
	TurnCount    *int64  `json:"turnCount"`
	SecondsCount *int64  `json:"secondsCount"`
	DeckID       *int64  `json:"deckId"`
	DeckName     *string `json:"deckName"`
}

type DeckSummaryRow struct {
	DeckID    int64   `json:"deckId"`
	DeckName  string  `json:"deckName"`
	Format    string  `json:"format"`
	EventName string  `json:"eventName"`
	Matches   int64   `json:"matches"`
	Wins      int64   `json:"wins"`
	Losses    int64   `json:"losses"`
	WinRate   float64 `json:"winRate"`
}

type DeckCardRow struct {
	Section  string `json:"section"`
	CardID   int64  `json:"cardId"`
	Quantity int64  `json:"quantity"`
}

type DeckDetail struct {
	DeckID      int64         `json:"deckId"`
	ArenaDeckID string        `json:"arenaDeckId"`
	Name        string        `json:"name"`
	Format      string        `json:"format"`
	EventName   string        `json:"eventName"`
	Cards       []DeckCardRow `json:"cards"`
	Matches     []MatchRow    `json:"matches"`
}

type DraftSessionRow struct {
	ID          int64   `json:"id"`
	EventName   string  `json:"eventName"`
	DraftID     *string `json:"draftId"`
	IsBotDraft  bool    `json:"isBotDraft"`
	StartedAt   string  `json:"startedAt"`
	CompletedAt string  `json:"completedAt"`
	Picks       int64   `json:"picks"`
}

type DraftPickRow struct {
	ID            int64  `json:"id"`
	PackNumber    int64  `json:"packNumber"`
	PickNumber    int64  `json:"pickNumber"`
	PickedCardIDs string `json:"pickedCardIds"`
	PackCardIDs   string `json:"packCardIds"`
	PickTs        string `json:"pickTs"`
}

type Overview struct {
	TotalMatches int64      `json:"totalMatches"`
	Wins         int64      `json:"wins"`
	Losses       int64      `json:"losses"`
	WinRate      float64    `json:"winRate"`
	Recent       []MatchRow `json:"recent"`
}
