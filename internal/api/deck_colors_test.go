package api

import (
	"reflect"
	"testing"
)

func TestMatchColorsForCardQuantitiesIgnoresTinySplash(t *testing.T) {
	t.Parallel()

	colors, known := matchColorsForCardQuantities(
		map[int64]int64{
			1: 18,
			2: 14,
			3: 2,
		},
		map[int64][]string{
			1: {"U"},
			2: {"B"},
			3: {"R"},
		},
	)

	if !known {
		t.Fatal("expected colors to be known")
	}
	if want := []string{"U", "B"}; !reflect.DeepEqual(colors, want) {
		t.Fatalf("colors = %v, want %v", colors, want)
	}
}

func TestMatchColorsForCardQuantitiesFallsBackForSmallSamples(t *testing.T) {
	t.Parallel()

	colors, known := matchColorsForCardQuantities(
		map[int64]int64{
			1: 2,
		},
		map[int64][]string{
			1: {"R"},
		},
	)

	if !known {
		t.Fatal("expected colors to be known")
	}
	if want := []string{"R"}; !reflect.DeepEqual(colors, want) {
		t.Fatalf("colors = %v, want %v", colors, want)
	}
}

func TestMatchColorsForCardQuantitiesKeepsColorlessDecks(t *testing.T) {
	t.Parallel()

	colors, known := matchColorsForCardQuantities(
		map[int64]int64{
			1: 20,
		},
		map[int64][]string{
			1: {},
		},
	)

	if !known {
		t.Fatal("expected colors to be known")
	}
	if len(colors) != 0 {
		t.Fatalf("colors = %v, want colorless deck", colors)
	}
}
