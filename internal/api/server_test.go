package api

import (
	"io"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestSPAFallback(t *testing.T) {
	assets := fstest.MapFS{
		"index.html":         {Data: []byte("<html>app</html>")},
		"assets/index-ab.js": {Data: []byte("console.log('js')")},
	}

	server := NewServer(nil, "", nil)
	server.SetStaticAssets(assets)
	handler := server.Handler()

	cases := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"root serves index", "/", 200, "<html>app</html>"},
		{"deep link falls back to index", "/matches/675", 200, "<html>app</html>"},
		{"nested deep link falls back", "/drafts/12/picks", 200, "<html>app</html>"},
		{"real asset served as-is", "/assets/index-ab.js", 200, "console.log('js')"},
		{"unknown api path stays 404", "/api/nope", 404, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tc.path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("GET %s: status = %d, want %d", tc.path, rec.Code, tc.wantStatus)
			}
			if tc.wantBody != "" {
				body, _ := io.ReadAll(rec.Body)
				if string(body) != tc.wantBody {
					t.Fatalf("GET %s: body = %q, want %q", tc.path, body, tc.wantBody)
				}
			}
		})
	}
}
