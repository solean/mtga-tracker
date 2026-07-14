package appstate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveSupportDirUsesPonderDirectory(t *testing.T) {
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatalf("resolve user config dir: %v", err)
	}

	got, err := resolveSupportDir("")
	if err != nil {
		t.Fatalf("resolve support dir: %v", err)
	}
	want := filepath.Join(base, "ponder")
	if got != want {
		t.Fatalf("support dir = %q, want %q", got, want)
	}
}
