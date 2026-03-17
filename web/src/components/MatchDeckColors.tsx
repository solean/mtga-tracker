import { ManaSymbol } from "./ManaSymbol";

const COLOR_ORDER = ["W", "U", "B", "R", "G"] as const;

const COLOR_LABELS: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless",
};

type MatchDeckColorsProps = {
  deckColors?: string[] | null;
  deckColorsKnown?: boolean;
  opponentDeckColors?: string[] | null;
  opponentDeckColorsKnown?: boolean;
  className?: string;
};

type DeckColorIdentityProps = {
  colors?: string[] | null;
  known?: boolean;
  className?: string;
};

function normalizeColors(colors?: string[] | null): string[] {
  if (!colors || colors.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  for (const color of colors) {
    const normalized = color.trim().toUpperCase();
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
  }

  return COLOR_ORDER.filter((color) => seen.has(color));
}

function deckColorsLabel(colors: string[] | null | undefined, known?: boolean): string {
  if (!known) {
    return "Unknown";
  }

  const normalized = normalizeColors(colors);
  if (normalized.length === 0) {
    return COLOR_LABELS.C;
  }

  return normalized.map((color) => COLOR_LABELS[color] ?? color).join(" ");
}

export function DeckColorIdentity({
  colors,
  known,
  className = "",
}: DeckColorIdentityProps) {
  if (!known) {
    return <span className="deck-color-unknown">Unknown</span>;
  }

  const normalized = normalizeColors(colors);
  const displayColors = normalized.length > 0 ? normalized : ["C"];
  const classes = ["deck-card-mana-icons", "match-deck-color-symbols", className].filter(Boolean).join(" ");

  return (
    <span className={classes} aria-label={deckColorsLabel(colors, known)}>
      {displayColors.map((color) => (
        <ManaSymbol key={color} token={color} />
      ))}
    </span>
  );
}

export function MatchDeckColors({
  deckColors,
  deckColorsKnown,
  opponentDeckColors,
  opponentDeckColorsKnown,
  className = "",
}: MatchDeckColorsProps) {
  const classes = ["match-deck-colors", className].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      aria-label={`Deck colors. You: ${deckColorsLabel(deckColors, deckColorsKnown)}. Opponent: ${deckColorsLabel(
        opponentDeckColors,
        opponentDeckColorsKnown,
      )}.`}
    >
      <span className="match-deck-colors-group">
        <span className="match-deck-colors-label">You</span>
        <DeckColorIdentity colors={deckColors} known={deckColorsKnown} />
      </span>
      <span className="match-deck-colors-group">
        <span className="match-deck-colors-label">Opp.</span>
        <DeckColorIdentity colors={opponentDeckColors} known={opponentDeckColorsKnown} />
      </span>
    </div>
  );
}
