package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cschnabel/mtgdata/internal/db"
)

type Server struct {
	store     *db.Store
	staticDir string
}

func NewServer(store *db.Store, staticDir string) *Server {
	return &Server{store: store, staticDir: staticDir}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/overview", s.handleOverview)
	mux.HandleFunc("/api/matches", s.handleMatches)
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
