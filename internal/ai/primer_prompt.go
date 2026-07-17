package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"github.com/solean/ponder/internal/model"
)

// wubrgOrder sorts color identity strings into canonical WUBRG order so
// matchup groupings are stable ("UW" and "WU" collapse to "WU").
var wubrgOrder = map[string]int{"W": 0, "U": 1, "B": 2, "R": 3, "G": 4}

func colorKey(colors []string) string {
	if len(colors) == 0 {
		return ""
	}
	sorted := append([]string(nil), colors...)
	sort.Slice(sorted, func(i, j int) bool { return wubrgOrder[sorted[i]] < wubrgOrder[sorted[j]] })
	return strings.Join(sorted, "")
}

// CardsHash fingerprints a deck's card list (section, id, quantity) so a
// cached primer can be flagged stale after the deck changes.
func CardsHash(cards []model.DeckCardRow) string {
	entries := make([]string, 0, len(cards))
	for _, card := range cards {
		entries = append(entries, fmt.Sprintf("%s|%d|%d", card.Section, card.CardID, card.Quantity))
	}
	sort.Strings(entries)
	sum := sha256.Sum256([]byte(strings.Join(entries, "\n")))
	return hex.EncodeToString(sum[:])
}

// BuildPrimerPrompt renders the deck list plus the pilot's own match history
// into a prompt for primer generation.
func BuildPrimerPrompt(deck model.DeckDetail) string {
	var b strings.Builder

	b.WriteString("You are an expert Magic: The Gathering coach. Write a strategy primer for the deck below, which the pilot plays on MTG Arena.\n\n")

	format := deck.Format
	if format == "" {
		format = "Unknown"
	}
	fmt.Fprintf(&b, "Deck name: %s\nFormat: %s\n", deck.Name, format)
	if deck.EventName != "" {
		fmt.Fprintf(&b, "Arena event: %s\n", deck.EventName)
	}

	writeSection := func(title, section string) {
		var lines []string
		for _, card := range deck.Cards {
			if card.Section != section {
				continue
			}
			name := card.CardName
			if name == "" {
				name = fmt.Sprintf("Unknown card (Arena id %d)", card.CardID)
			}
			lines = append(lines, fmt.Sprintf("%dx %s", card.Quantity, name))
		}
		if len(lines) == 0 {
			return
		}
		fmt.Fprintf(&b, "\n%s:\n%s\n", title, strings.Join(lines, "\n"))
	}
	writeSection("Mainboard", "main")
	writeSection("Sideboard", "sideboard")

	writeMatchHistory(&b, deck.Matches)

	b.WriteString(`
Instructions:
- If any card names are unfamiliar (they may be from a very recent set), use web search to confirm what they do before writing about them. Also use web search to check the current ` + format + ` metagame before giving matchup advice.
- Write the primer in Markdown with exactly these sections: "## Overview", "## Game Plan", "## Key Cards", "## Mulligan Guide", "## Matchups & Sideboarding".
- In "Matchups & Sideboarding", lead with the matchups this pilot actually faces most (per the match history above), give a short plan for each, and list concrete sideboard swaps (cards in / cards out) when a sideboard exists.
- Ground any claims about the pilot's results in the record above; don't invent results.
- Be concrete and practical. No filler, no restating the decklist. Aim for 600-900 words.
- Output only the primer Markdown. Do not add a preamble, a title heading, or closing remarks.`)

	return b.String()
}

func writeMatchHistory(b *strings.Builder, matches []model.MatchRow) {
	if len(matches) == 0 {
		b.WriteString("\nThe pilot has no recorded matches with this deck yet.\n")
		return
	}

	type record struct{ wins, losses, other int }
	var overall record
	byColors := map[string]*record{}
	order := []string{}

	for _, match := range matches {
		key := ""
		if match.OpponentDeckColorsKnown {
			key = colorKey(match.OpponentDeckColors)
			if key == "" {
				key = "Colorless"
			}
		}
		rec := byColors[key]
		if rec == nil {
			rec = &record{}
			byColors[key] = rec
			order = append(order, key)
		}
		switch strings.ToLower(match.Result) {
		case "win", "won":
			overall.wins++
			rec.wins++
		case "loss", "lost", "lose":
			overall.losses++
			rec.losses++
		default:
			overall.other++
			rec.other++
		}
	}

	fmt.Fprintf(b, "\nPilot's match history with this deck (from Arena logs, most recent %d matches):\n", len(matches))
	fmt.Fprintf(b, "Overall record: %d-%d\n", overall.wins, overall.losses)
	b.WriteString("Record by opponent deck colors (W=white U=blue B=black R=red G=green):\n")
	sort.SliceStable(order, func(i, j int) bool {
		a, c := byColors[order[i]], byColors[order[j]]
		return a.wins+a.losses+a.other > c.wins+c.losses+c.other
	})
	for _, key := range order {
		rec := byColors[key]
		label := key
		if label == "" {
			label = "Unknown colors"
		}
		fmt.Fprintf(b, "- vs %s: %d-%d\n", label, rec.wins, rec.losses)
	}
}
