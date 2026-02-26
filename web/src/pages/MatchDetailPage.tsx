import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";

import { ResultPill } from "../components/ResultPill";
import { api } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";
import { fetchCardPreview } from "../lib/scryfall";
import type { MatchCardPlay } from "../lib/types";

type OpponentDeckCard = {
  cardId: number;
  cardName?: string;
  quantity: number;
};

type PopoverPlacement = "left" | "right";
type ManaCostPart = { kind: "symbol"; token: string } | { kind: "separator"; value: string };

const SCRYFALL_SYMBOL_BASE_URL = "https://svgs.scryfall.io/card-symbols";

function cardDisplayName(card: OpponentDeckCard): string {
  return card.cardName?.trim() || `Card ${card.cardId}`;
}

function timelineCardName(play: MatchCardPlay): string {
  return play.cardName?.trim() || `Card ${play.cardId}`;
}

function timelinePlayerLabel(playerSide: MatchCardPlay["playerSide"]): string {
  if (playerSide === "self") return "You";
  if (playerSide === "opponent") return "Opponent";
  return "Unknown";
}

function timelineZoneLabel(zone: string): string {
  const trimmed = zone.trim();
  if (!trimmed) return "-";
  return trimmed
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function timelinePhaseLabel(phase: string | undefined): string {
  const trimmed = phase?.trim() ?? "";
  if (!trimmed) return "-";
  return trimmed
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function cardPreviewQueryKey(card: OpponentDeckCard): [string, number, string] {
  return ["card-preview", card.cardId, cardDisplayName(card)];
}

function parseManaCostParts(manaCost: string): ManaCostPart[] {
  const trimmed = manaCost.trim();
  if (!trimmed) {
    return [];
  }

  const parts: ManaCostPart[] = [];
  const tokenPattern = /\{([^}]+)\}/g;
  let lastIndex = 0;

  while (true) {
    const match = tokenPattern.exec(trimmed);
    if (!match) {
      break;
    }

    const between = trimmed.slice(lastIndex, match.index).trim();
    if (between) {
      parts.push({ kind: "separator", value: between });
    }

    const token = match[1]?.trim();
    if (token) {
      parts.push({ kind: "symbol", token });
    }

    lastIndex = tokenPattern.lastIndex;
  }

  const tail = trimmed.slice(lastIndex).trim();
  if (tail) {
    parts.push({ kind: "separator", value: tail });
  }

  return parts;
}

function manaSymbolURL(token: string): string {
  return `${SCRYFALL_SYMBOL_BASE_URL}/${encodeURIComponent(token)}.svg`;
}

function ManaSymbol({ token }: { token: string }) {
  const [didFail, setDidFail] = useState(false);
  const label = `{${token}}`;

  if (didFail) {
    return (
      <code className="mana-symbol-fallback" aria-label={label}>
        {label}
      </code>
    );
  }

  return (
    <img
      className="mana-symbol-icon"
      src={manaSymbolURL(token)}
      alt={label}
      loading="lazy"
      decoding="async"
      onError={() => setDidFail(true)}
    />
  );
}

function ManaCostDisplay({ manaCost }: { manaCost: string }) {
  const trimmed = manaCost.trim();
  if (!trimmed) {
    return <code className="deck-card-mana-cost">-</code>;
  }

  const parts = parseManaCostParts(trimmed);
  if (parts.length === 0) {
    return <code className="deck-card-mana-cost">{trimmed}</code>;
  }

  return (
    <span className="deck-card-mana-cost deck-card-mana-icons" aria-label={`Mana cost ${trimmed}`}>
      {parts.map((part, index) =>
        part.kind === "symbol" ? (
          <ManaSymbol key={`symbol-${part.token}-${index}`} token={part.token} />
        ) : (
          <span className="mana-symbol-separator" key={`sep-${part.value}-${index}`}>
            {part.value}
          </span>
        ),
      )}
    </span>
  );
}

function OpponentCardPreviewName({ card }: { card: OpponentDeckCard }) {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPlacement, setPopoverPlacement] = useState<PopoverPlacement>("right");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const name = cardDisplayName(card);
  const fallbackHref = card.cardName?.trim()
    ? `https://scryfall.com/search?q=${encodeURIComponent(`!"${name}"`)}`
    : `https://scryfall.com/search?q=${encodeURIComponent(`arenaid:${card.cardId}`)}`;

  const updatePopoverPlacement = () => {
    if (typeof window === "undefined") {
      return;
    }

    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const popoverWidth = window.matchMedia("(max-width: 640px)").matches ? 195 : 245;
    const horizontalGap = 14;
    const availableRight = viewportWidth - rect.right;
    const availableLeft = rect.left;

    if (availableRight >= popoverWidth + horizontalGap) {
      setPopoverPlacement("right");
      return;
    }
    if (availableLeft >= popoverWidth + horizontalGap) {
      setPopoverPlacement("left");
      return;
    }
    setPopoverPlacement(availableRight >= availableLeft ? "right" : "left");
  };

  const openPopover = () => {
    updatePopoverPlacement();
    setIsOpen(true);
  };

  const previewQuery = useQuery({
    queryKey: cardPreviewQueryKey(card),
    queryFn: () => fetchCardPreview(card.cardId, card.cardName),
    enabled: isOpen,
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onResize = () => updatePopoverPlacement();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isOpen]);

  return (
    <div
      className="card-preview-anchor"
      data-popover-placement={popoverPlacement}
      ref={wrapperRef}
      onMouseEnter={openPopover}
      onMouseLeave={() => setIsOpen(false)}
    >
      <a
        className="card-preview-trigger"
        href={previewQuery.data?.scryfallUrl ?? fallbackHref}
        target="_blank"
        rel="noreferrer"
        onFocus={openPopover}
        onBlur={(event) => {
          if (wrapperRef.current && event.relatedTarget instanceof Node && wrapperRef.current.contains(event.relatedTarget)) {
            return;
          }
          setIsOpen(false);
        }}
        aria-label={`Open ${name} on Scryfall`}
      >
        <code>{name}</code>
      </a>

      {isOpen ? (
        <div className="card-preview-popover" role="tooltip">
          {previewQuery.isLoading ? (
            <p className="card-preview-status">Loading preview…</p>
          ) : previewQuery.data ? (
            <img src={previewQuery.data.imageUrl} alt={previewQuery.data.name} loading="lazy" />
          ) : (
            <p className="card-preview-status">Preview unavailable.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function MatchDetailPage() {
  const params = useParams();
  const matchId = Number(params.matchId);
  const isValidMatchID = Number.isFinite(matchId);

  const query = useQuery({
    queryKey: ["match-detail", matchId],
    queryFn: () => api.matchDetail(matchId),
    enabled: isValidMatchID,
  });
  const timelineQuery = useQuery({
    queryKey: ["match-timeline", matchId],
    queryFn: () => api.matchTimeline(matchId),
    enabled: isValidMatchID,
  });

  const opponentObservedCards = query.data?.opponentObservedCards ?? [];
  const opponentCards = useMemo<OpponentDeckCard[]>(() => {
    return opponentObservedCards.map((card) => ({
      cardId: card.cardId,
      cardName: card.cardName,
      quantity: card.quantity,
    }));
  }, [opponentObservedCards]);

  const opponentCardPreviewQueries = useQueries({
    queries: opponentCards.map((card) => ({
      queryKey: cardPreviewQueryKey(card),
      queryFn: () => fetchCardPreview(card.cardId, card.cardName),
      enabled: card.cardId > 0,
      staleTime: 1000 * 60 * 60 * 24,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 1,
    })),
  });

  const opponentManaCostsByCardID = useMemo(() => {
    const out = new Map<number, string>();
    for (let i = 0; i < opponentCards.length; i += 1) {
      const card = opponentCards[i];
      const preview = opponentCardPreviewQueries[i]?.data;
      out.set(card.cardId, preview?.manaCost?.trim() ?? "");
    }
    return out;
  }, [opponentCards, opponentCardPreviewQueries]);

  const isOpponentCardMetadataLoading = opponentCardPreviewQueries.some((previewQuery) => previewQuery.isPending);

  if (!isValidMatchID) return <p className="state error">Invalid match id.</p>;
  if (query.isLoading) return <p className="state">Loading match…</p>;
  if (query.error) return <p className="state error">{(query.error as Error).message}</p>;
  if (!query.data) return <p className="state">Match not found.</p>;

  const { match } = query.data;
  const timelineRows = timelineQuery.data ?? query.data.cardPlays ?? [];

  return (
    <div className="stack-lg">
      <section className="panel">
        <div className="panel-head">
          <h3>Match #{match.id}</h3>
          <Link className="text-link" to="/matches">
            Back to matches
          </Link>
        </div>
        <div className="table-wrap">
          <table className="data-table compact">
            <tbody>
              <tr>
                <th>Event</th>
                <td>{match.eventName || "-"}</td>
              </tr>
              <tr>
                <th>Opponent</th>
                <td>{match.opponent || "Unknown"}</td>
              </tr>
              <tr>
                <th>Started</th>
                <td>{formatDateTime(match.startedAt)}</td>
              </tr>
              <tr>
                <th>Result</th>
                <td>
                  <ResultPill result={match.result} />
                </td>
              </tr>
              <tr>
                <th>Reason</th>
                <td>{match.winReason || "-"}</td>
              </tr>
              <tr>
                <th>Turns</th>
                <td>{match.turnCount ?? "-"}</td>
              </tr>
              <tr>
                <th>Duration</th>
                <td>{formatDuration(match.secondsCount ?? undefined)}</td>
              </tr>
              <tr>
                <th>Deck</th>
                <td>
                  {match.deckId ? (
                    <Link className="text-link" to={`/decks/${match.deckId}`}>
                      {match.deckName || `Deck ${match.deckId}`}
                    </Link>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Card Play Timeline</h3>
          <p>{timelineRows.length} observed plays</p>
        </div>
        {timelineQuery.error ? (
          <p className="state error">{(timelineQuery.error as Error).message}</p>
        ) : timelineRows.length === 0 ? (
          <p className="state">No observed card plays for this match yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Turn</th>
                  <th>Player</th>
                  <th>Card</th>
                  <th>Zone</th>
                  <th>Phase</th>
                  <th>Seen At</th>
                </tr>
              </thead>
              <tbody>
                {timelineRows.map((play, index) => (
                  <tr key={play.id}>
                    <td>{index + 1}</td>
                    <td>{play.turnNumber ?? "-"}</td>
                    <td>{timelinePlayerLabel(play.playerSide)}</td>
                    <td>
                      <code>{timelineCardName(play)}</code>
                    </td>
                    <td>{timelineZoneLabel(play.firstPublicZone)}</td>
                    <td>{timelinePhaseLabel(play.phase)}</td>
                    <td>{formatDateTime(play.playedAt ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Observed Opponent Cards</h3>
          <p>{opponentObservedCards.length} unique cards</p>
        </div>
        {opponentObservedCards.length === 0 ? (
          <p className="state">No public opponent cards observed for this match yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Qty</th>
                  <th>Card</th>
                  <th>Mana</th>
                </tr>
              </thead>
              <tbody>
                {opponentCards.map((card) => (
                  <tr key={card.cardId}>
                    <td>{card.quantity}</td>
                    <td>
                      <OpponentCardPreviewName card={card} />
                    </td>
                    <td>
                      <span className="deck-card-mana">
                        <ManaCostDisplay manaCost={opponentManaCostsByCardID.get(card.cardId) ?? ""} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {isOpponentCardMetadataLoading ? <p className="state">Loading card previews and mana details…</p> : null}
      </section>
    </div>
  );
}
