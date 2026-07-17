package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/solean/ponder/internal/ai"
)

// aiGenerateTimeout bounds a single primer generation. Opus with web search
// can legitimately take a few minutes.
const aiGenerateTimeout = 5 * time.Minute

func (s *Server) handleAIStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.aiProvider.Status(r.Context()))
}

// handleDeckPrimer serves GET (cached primer) and POST (generate + stream)
// for /api/decks/{id}/primer.
func (s *Server) handleDeckPrimer(w http.ResponseWriter, r *http.Request, deckID int64) {
	switch r.Method {
	case http.MethodGet:
		s.handleDeckPrimerGet(w, r, deckID)
	case http.MethodPost:
		s.handleDeckPrimerGenerate(w, r, deckID)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleDeckPrimerGet(w http.ResponseWriter, r *http.Request, deckID int64) {
	primer, err := s.store.GetDeckPrimer(r.Context(), deckID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if primer == nil {
		writeError(w, http.StatusNotFound, "no primer generated for this deck")
		return
	}
	if detail, err := s.store.GetDeckDetail(r.Context(), deckID, 1); err == nil {
		primer.Stale = ai.CardsHash(detail.Cards) != primer.CardsHash
	}
	writeJSON(w, http.StatusOK, primer)
}

// handleDeckPrimerGenerate streams generation progress as Server-Sent Events:
// `delta` events carry JSON-encoded text fragments, a final `done` event
// carries the saved primer, and `error` reports failures. The frontend sends
// Accept: text/event-stream, which also exempts the response from gzip.
func (s *Server) handleDeckPrimerGenerate(w http.ResponseWriter, r *http.Request, deckID int64) {
	if !s.aiGenBusy.TryLock() {
		writeError(w, http.StatusConflict, "another AI generation is already running")
		return
	}
	defer s.aiGenBusy.Unlock()

	if status := s.aiProvider.Status(r.Context()); !status.Available {
		writeError(w, http.StatusServiceUnavailable, status.Detail)
		return
	}

	detail, err := s.store.GetDeckDetail(r.Context(), deckID, 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(detail.Cards) == 0 {
		writeError(w, http.StatusBadRequest, "deck has no cards to analyze")
		return
	}
	s.enrichDeckCardNames(r.Context(), detail.Cards)
	s.enrichMatchDeckColors(r.Context(), detail.Matches)

	// If the underlying writer can't flush (e.g. some asset-server setups),
	// events still arrive — just buffered until the handler returns.
	flush := func() {}
	if flusher, ok := w.(http.Flusher); ok {
		flush = flusher.Flush
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flush()

	sendEvent := func(event string, payload any) {
		data, err := json.Marshal(payload)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		flush()
	}

	ctx, cancel := context.WithTimeout(r.Context(), aiGenerateTimeout)
	defer cancel()

	prompt := ai.BuildPrimerPrompt(detail)
	content, err := s.aiProvider.Generate(ctx, ai.DefaultModel, prompt, func(text string) {
		sendEvent("delta", text)
	})
	if err != nil {
		sendEvent("error", map[string]string{"error": err.Error()})
		return
	}

	// Persist with a fresh context: the client may disconnect right as
	// generation finishes, and the work is too expensive to throw away.
	saveCtx, saveCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer saveCancel()
	primer, err := s.store.UpsertDeckPrimer(saveCtx, deckID, ai.CardsHash(detail.Cards), ai.DefaultModel, content)
	if err != nil {
		sendEvent("error", map[string]string{"error": err.Error()})
		return
	}
	sendEvent("done", primer)
}
