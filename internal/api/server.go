package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cschnabel/mtgdata/internal/db"
	"github.com/cschnabel/mtgdata/internal/model"
)

type Server struct {
	store      *db.Store
	staticDir  string
	httpClient *http.Client
}

func NewServer(store *db.Store, staticDir string) *Server {
	return &Server{
		store:     store,
		staticDir: staticDir,
		httpClient: &http.Client{
			Timeout: 8 * time.Second,
		},
	}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/overview", s.handleOverview)
	mux.HandleFunc("/api/matches", s.handleMatches)
	mux.HandleFunc("/api/matches/", s.handleMatchDetail)
	mux.HandleFunc("/api/decks", s.handleDecks)
	mux.HandleFunc("/api/decks/", s.handleDeckDetail)
	mux.HandleFunc("/api/drafts", s.handleDrafts)
	mux.HandleFunc("/api/drafts/", s.handleDraftPicks)

	if s.staticDir != "" {
		if fi, err := os.Stat(s.staticDir); err == nil && fi.IsDir() {
			fs := http.FileServer(http.Dir(s.staticDir))
			mux.Handle("/", fs)
		} else {
			mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("mtgdata API is running. Frontend build not found."))
			})
		}
	}

	return withCORS(mux)
}

func (s *Server) Run(ctx context.Context, addr string) error {
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("HTTP server listening on %s", addr)
		err := httpServer.ListenAndServe()
		if err != nil && err != http.ErrServerClosed {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		return nil
	case err := <-errCh:
		return err
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	if status >= http.StatusInternalServerError {
		log.Printf("http %d: %s", status, message)
	}
	writeJSON(w, status, map[string]any{
		"error": message,
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	limit := int64(20)
	if raw := strings.TrimSpace(r.URL.Query().Get("recent")); raw != "" {
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil {
			limit = v
		}
	}
	out, err := s.store.Overview(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleMatches(w http.ResponseWriter, r *http.Request) {
	limit := int64(200)
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil {
			limit = v
		}
	}
	event := strings.TrimSpace(r.URL.Query().Get("event"))
	result := strings.TrimSpace(r.URL.Query().Get("result"))

	rows, err := s.store.ListMatches(r.Context(), limit, event, result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) handleMatchDetail(w http.ResponseWriter, r *http.Request) {
	prefix := "/api/matches/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	idStr := strings.TrimSpace(strings.Trim(strings.TrimPrefix(r.URL.Path, prefix), "/"))
	if idStr == "" {
		writeError(w, http.StatusBadRequest, "missing match id")
		return
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid match id")
		return
	}

	out, err := s.store.GetMatchDetail(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "match not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.enrichOpponentObservedCardNames(r.Context(), out.OpponentObservedCards)
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDecks(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/decks" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	rows, err := s.store.ListDecks(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) handleDeckDetail(w http.ResponseWriter, r *http.Request) {
	prefix := "/api/decks/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	idStr := strings.TrimPrefix(r.URL.Path, prefix)
	idStr = strings.Trim(idStr, "/")
	if idStr == "" {
		writeError(w, http.StatusBadRequest, "missing deck id")
		return
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid deck id")
		return
	}

	out, err := s.store.GetDeckDetail(r.Context(), id, 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.enrichDeckCardNames(r.Context(), out.Cards)
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDrafts(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/drafts" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	rows, err := s.store.ListDraftSessions(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) handleDraftPicks(w http.ResponseWriter, r *http.Request) {
	prefix := "/api/drafts/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, prefix), "/")
	if len(parts) != 2 || parts[1] != "picks" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid draft id")
		return
	}
	rows, err := s.store.ListDraftPicks(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func DefaultStaticDir(repoRoot string) string {
	if repoRoot == "" {
		return ""
	}
	return filepath.Join(repoRoot, "web", "dist")
}

func ParseAddr(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("address is empty")
	}
	return raw, nil
}

const (
	scryfallSearchURL      = "https://api.scryfall.com/cards/search"
	scryfallSearchBatchMax = 40
	mtgaRawCardDBEnvVar    = "MTGA_RAW_CARD_DB"
)

func (s *Server) enrichDeckCardNames(ctx context.Context, cards []model.DeckCardRow) {
	if len(cards) == 0 {
		return
	}

	unique := make(map[int64]struct{}, len(cards))
	missingCardIDs := make([]int64, 0, len(cards))
	for _, card := range cards {
		if strings.TrimSpace(card.CardName) != "" {
			continue
		}
		if _, seen := unique[card.CardID]; seen {
			continue
		}
		unique[card.CardID] = struct{}{}
		missingCardIDs = append(missingCardIDs, card.CardID)
	}
	if len(missingCardIDs) == 0 {
		return
	}

	resolvedNames, err := s.store.LookupCardNames(ctx, missingCardIDs)
	if err != nil {
		log.Printf("card name lookup failed: %v", err)
		resolvedNames = map[int64]string{}
	}
	newlyResolved := make(map[int64]string, len(missingCardIDs))

	unresolved := make([]int64, 0, len(missingCardIDs))
	for _, cardID := range missingCardIDs {
		if _, ok := resolvedNames[cardID]; !ok {
			unresolved = append(unresolved, cardID)
		}
	}

	if len(unresolved) > 0 {
		localNames, localErr := s.fetchCardNamesFromMTGARaw(ctx, unresolved)
		if localErr != nil {
			log.Printf("local MTGA card lookup failed: %v", localErr)
		}
		for cardID, name := range localNames {
			resolvedNames[cardID] = name
			newlyResolved[cardID] = name
		}

		unresolved = unresolvedCardIDs(missingCardIDs, resolvedNames)
	}

	if len(unresolved) > 0 {
		fetchedNames, fetchErr := s.fetchCardNamesFromScryfall(ctx, unresolved)
		if fetchErr != nil {
			log.Printf("scryfall card name lookup failed: %v", fetchErr)
		}
		if len(fetchedNames) > 0 {
			for cardID, name := range fetchedNames {
				resolvedNames[cardID] = name
				newlyResolved[cardID] = name
			}
		}
	}
	if len(newlyResolved) > 0 {
		if err := s.store.UpsertCardNames(ctx, newlyResolved); err != nil {
			log.Printf("card name cache upsert failed: %v", err)
		}
	}

	for i := range cards {
		if strings.TrimSpace(cards[i].CardName) != "" {
			continue
		}
		if name, ok := resolvedNames[cards[i].CardID]; ok {
			cards[i].CardName = name
		}
	}
}

func (s *Server) enrichOpponentObservedCardNames(ctx context.Context, cards []model.OpponentObservedCardRow) {
	if len(cards) == 0 {
		return
	}

	unique := make(map[int64]struct{}, len(cards))
	missingCardIDs := make([]int64, 0, len(cards))
	for _, card := range cards {
		if strings.TrimSpace(card.CardName) != "" {
			continue
		}
		if _, seen := unique[card.CardID]; seen {
			continue
		}
		unique[card.CardID] = struct{}{}
		missingCardIDs = append(missingCardIDs, card.CardID)
	}
	if len(missingCardIDs) == 0 {
		return
	}

	resolvedNames, err := s.store.LookupCardNames(ctx, missingCardIDs)
	if err != nil {
		log.Printf("card name lookup failed: %v", err)
		resolvedNames = map[int64]string{}
	}
	newlyResolved := make(map[int64]string, len(missingCardIDs))

	unresolved := make([]int64, 0, len(missingCardIDs))
	for _, cardID := range missingCardIDs {
		if _, ok := resolvedNames[cardID]; !ok {
			unresolved = append(unresolved, cardID)
		}
	}

	if len(unresolved) > 0 {
		localNames, localErr := s.fetchCardNamesFromMTGARaw(ctx, unresolved)
		if localErr != nil {
			log.Printf("local MTGA card lookup failed: %v", localErr)
		}
		for cardID, name := range localNames {
			resolvedNames[cardID] = name
			newlyResolved[cardID] = name
		}

		unresolved = unresolvedCardIDs(missingCardIDs, resolvedNames)
	}

	if len(unresolved) > 0 {
		fetchedNames, fetchErr := s.fetchCardNamesFromScryfall(ctx, unresolved)
		if fetchErr != nil {
			log.Printf("scryfall card name lookup failed: %v", fetchErr)
		}
		for cardID, name := range fetchedNames {
			resolvedNames[cardID] = name
			newlyResolved[cardID] = name
		}
	}

	if len(newlyResolved) > 0 {
		if err := s.store.UpsertCardNames(ctx, newlyResolved); err != nil {
			log.Printf("card name cache upsert failed: %v", err)
		}
	}

	for i := range cards {
		if strings.TrimSpace(cards[i].CardName) != "" {
			continue
		}
		if name, ok := resolvedNames[cards[i].CardID]; ok {
			cards[i].CardName = name
		}
	}
}

func unresolvedCardIDs(cardIDs []int64, resolved map[int64]string) []int64 {
	unresolved := make([]int64, 0, len(cardIDs))
	for _, cardID := range cardIDs {
		if _, ok := resolved[cardID]; !ok {
			unresolved = append(unresolved, cardID)
		}
	}
	return unresolved
}

func (s *Server) fetchCardNamesFromMTGARaw(ctx context.Context, cardIDs []int64) (map[int64]string, error) {
	out := make(map[int64]string, len(cardIDs))
	if len(cardIDs) == 0 {
		return out, nil
	}

	rawDBPath := discoverMTGARawCardDBPath()
	if strings.TrimSpace(rawDBPath) == "" {
		return out, nil
	}

	rawDB, err := sql.Open("sqlite", rawDBPath)
	if err != nil {
		return nil, fmt.Errorf("open MTGA raw card db %q: %w", rawDBPath, err)
	}
	defer rawDB.Close()
	rawDB.SetMaxOpenConns(1)
	rawDB.SetMaxIdleConns(1)

	if err := rawDB.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping MTGA raw card db %q: %w", rawDBPath, err)
	}

	placeholders := make([]string, 0, len(cardIDs))
	args := make([]any, 0, len(cardIDs))
	for _, id := range cardIDs {
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}

	query := fmt.Sprintf(`
		SELECT
			c.GrpId,
			COALESCE(
				NULLIF(TRIM(l1.Loc), ''),
				NULLIF(TRIM(l2.Loc), ''),
				NULLIF(TRIM(l3.Loc), '')
			) AS name
		FROM Cards c
		LEFT JOIN Localizations_enUS l1 ON l1.LocId = c.TitleId
		LEFT JOIN Localizations_enUS l2 ON l2.LocId = c.AltTitleId
		LEFT JOIN Localizations_enUS l3 ON l3.LocId = c.InterchangeableTitleId
		WHERE c.GrpId IN (%s)
	`, strings.Join(placeholders, ","))

	rows, err := rawDB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query MTGA raw card db: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var cardID int64
		var name string
		if err := rows.Scan(&cardID, &name); err != nil {
			return nil, fmt.Errorf("scan MTGA raw card row: %w", err)
		}
		name = strings.TrimSpace(name)
		if cardID <= 0 || name == "" {
			continue
		}
		out[cardID] = name
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate MTGA raw card rows: %w", err)
	}

	return out, nil
}

func discoverMTGARawCardDBPath() string {
	explicit := strings.TrimSpace(os.Getenv(mtgaRawCardDBEnvVar))
	if explicit != "" {
		if fi, err := os.Stat(explicit); err == nil && !fi.IsDir() {
			return explicit
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	patterns := []string{
		filepath.Join(home, "Library", "Application Support", "com.wizards.mtga", "Downloads", "Raw", "Raw_CardDatabase*.mtga"),
		filepath.Join(home, "AppData", "LocalLow", "Wizards Of The Coast", "MTGA", "Downloads", "Raw", "Raw_CardDatabase*.mtga"),
	}

	var newestPath string
	var newestMod time.Time
	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		for _, match := range matches {
			fi, err := os.Stat(match)
			if err != nil || fi.IsDir() {
				continue
			}
			if newestPath == "" || fi.ModTime().After(newestMod) {
				newestPath = match
				newestMod = fi.ModTime()
			}
		}
	}

	return newestPath
}

func (s *Server) fetchCardNamesFromScryfall(ctx context.Context, cardIDs []int64) (map[int64]string, error) {
	out := make(map[int64]string, len(cardIDs))
	if len(cardIDs) == 0 {
		return out, nil
	}

	var firstErr error
	for start := 0; start < len(cardIDs); start += scryfallSearchBatchMax {
		end := min(start+scryfallSearchBatchMax, len(cardIDs))
		batchNames, err := s.fetchCardNameBatch(ctx, cardIDs[start:end])
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for cardID, name := range batchNames {
			out[cardID] = name
		}
	}
	return out, firstErr
}

func (s *Server) fetchCardNameBatch(ctx context.Context, cardIDs []int64) (map[int64]string, error) {
	type responseCard struct {
		ArenaID int64  `json:"arena_id"`
		Name    string `json:"name"`
	}
	type responsePayload struct {
		Data     []responseCard `json:"data"`
		HasMore  bool           `json:"has_more"`
		NextPage string         `json:"next_page"`
	}

	if len(cardIDs) == 0 {
		return map[int64]string{}, nil
	}

	terms := make([]string, 0, len(cardIDs))
	for _, cardID := range cardIDs {
		terms = append(terms, fmt.Sprintf("arenaid:%d", cardID))
	}

	query := strings.Join(terms, " or ")
	searchURL := fmt.Sprintf("%s?q=%s&unique=cards", scryfallSearchURL, url.QueryEscape(query))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, searchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build scryfall request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mtgdata/0.1 (local tracker)")

	res, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request scryfall: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusNotFound {
		return map[int64]string{}, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return nil, fmt.Errorf("scryfall status %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}

	var decoded responsePayload
	if err := json.NewDecoder(res.Body).Decode(&decoded); err != nil {
		return nil, fmt.Errorf("decode scryfall response: %w", err)
	}

	names := make(map[int64]string, len(decoded.Data))
	addCards := func(cards []responseCard) {
		for _, card := range cards {
			if card.ArenaID <= 0 || strings.TrimSpace(card.Name) == "" {
				continue
			}
			names[card.ArenaID] = card.Name
		}
	}
	addCards(decoded.Data)

	nextPage := decoded.NextPage
	for decoded.HasMore && strings.TrimSpace(nextPage) != "" {
		nextReq, err := http.NewRequestWithContext(ctx, http.MethodGet, nextPage, nil)
		if err != nil {
			return names, fmt.Errorf("build scryfall next page request: %w", err)
		}
		nextReq.Header.Set("Accept", "application/json")
		nextReq.Header.Set("User-Agent", "mtgdata/0.1 (local tracker)")

		nextRes, err := s.httpClient.Do(nextReq)
		if err != nil {
			return names, fmt.Errorf("request scryfall next page: %w", err)
		}

		var nextDecoded responsePayload
		if nextRes.StatusCode >= 200 && nextRes.StatusCode < 300 {
			err = json.NewDecoder(nextRes.Body).Decode(&nextDecoded)
		} else {
			body, _ := io.ReadAll(io.LimitReader(nextRes.Body, 1024))
			err = fmt.Errorf("scryfall next page status %d: %s", nextRes.StatusCode, strings.TrimSpace(string(body)))
		}
		nextRes.Body.Close()
		if err != nil {
			return names, err
		}
		addCards(nextDecoded.Data)
		decoded = nextDecoded
		nextPage = nextDecoded.NextPage
	}
	return names, nil
}
