import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { ResultPill } from "../components/ResultPill";
import { api } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";
import { fetchCardPreview } from "../lib/scryfall";

type DeckListCard = {
  cardId: number;
  cardName?: string;
  quantity: number;
};

function DeckCardPreviewName({ card }: { card: DeckListCard }) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const name = card.cardName?.trim() || `Card ${card.cardId}`;
  const fallbackHref = card.cardName?.trim()
    ? `https://scryfall.com/search?q=${encodeURIComponent(`!"${name}"`)}`
    : `https://scryfall.com/search?q=${encodeURIComponent(`arenaid:${card.cardId}`)}`;

  const previewQuery = useQuery({
    queryKey: ["card-preview", card.cardId, name],
    queryFn: () => fetchCardPreview(card.cardId, card.cardName),
    enabled: isOpen,
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
  });

  return (
    <div
      className="card-preview-anchor"
      ref={wrapperRef}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <a
        className="card-preview-trigger"
        href={previewQuery.data?.scryfallUrl ?? fallbackHref}
        target="_blank"
        rel="noreferrer"
        onFocus={() => setIsOpen(true)}
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
            <>
              <img src={previewQuery.data.imageUrl} alt={previewQuery.data.name} loading="lazy" />
              <div className="card-preview-meta">
                <p className="card-preview-name">{previewQuery.data.name}</p>
              </div>
            </>
          ) : (
            <p className="card-preview-status">Preview unavailable.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function DeckDetailPage() {
  const params = useParams();
  const deckId = Number(params.deckId);

  const { data, isLoading, error } = useQuery({
    queryKey: ["deck", deckId],
    queryFn: () => api.deckDetail(deckId),
    enabled: Number.isFinite(deckId),
  });

  const groupedCards = useMemo(() => {
    const bySection: Record<string, DeckListCard[]> = {};
    for (const card of data?.cards ?? []) {
      if (!bySection[card.section]) {
        bySection[card.section] = [];
      }
      bySection[card.section].push({ cardId: card.cardId, cardName: card.cardName, quantity: card.quantity });
    }
    return bySection;
  }, [data?.cards]);

  if (!Number.isFinite(deckId)) return <p className="state error">Invalid deck id.</p>;
  if (isLoading) return <p className="state">Loading deck…</p>;
  if (error) return <p className="state error">{(error as Error).message}</p>;
  if (!data) return <p className="state">Deck not found.</p>;

  return (
    <div className="stack-lg">
      <section className="panel decklist-panel">
        <div className="panel-head">
          <div>
            <h3>{data.name || "Unnamed Deck"}</h3>
            <p>
              {data.format || "Unknown format"} • {data.eventName || "No event"}
            </p>
          </div>
          <Link className="text-link" to="/decks">
            Back to decks
          </Link>
        </div>

        <div className="grid-cards">
          {Object.entries(groupedCards).map(([section, cards]) => (
            <article className="deck-card" key={section}>
              <h4>{section}</h4>
              <ul>
                {cards.map((card) => (
                  <li key={`${section}-${card.cardId}`}>
                    <span className="deck-card-qty">{card.quantity}x</span>
                    <DeckCardPreviewName card={card} />
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Matches with this deck</h3>
          <p>{data.matches.length} matches</p>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Event</th>
                <th>Opponent</th>
                <th>Result</th>
                <th>Turns</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {data.matches.map((match) => (
                <tr key={match.id}>
                  <td>{formatDateTime(match.startedAt)}</td>
                  <td>{match.eventName || "-"}</td>
                  <td>{match.opponent || "-"}</td>
                  <td>
                    <ResultPill result={match.result} />
                  </td>
                  <td>{match.turnCount ?? "-"}</td>
                  <td>{formatDuration(match.secondsCount ?? undefined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
