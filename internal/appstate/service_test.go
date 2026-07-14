package appstate

import (
	"path/filepath"
	"testing"
)

func TestSupportDirPathUsesPonderName(t *testing.T) {
	base := t.TempDir()
	got := supportDirPath(base)
	want := filepath.Join(base, "ponder")
	if got != want {
		t.Fatalf("support dir = %q, want %q", got, want)
	}
}
