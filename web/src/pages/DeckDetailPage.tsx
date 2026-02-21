import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { ResultPill } from "../components/ResultPill";
import { api } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";

export function DeckDetailPage() {
  const params = useParams();
  const deckId = Number(params.deckId);

  const { data, isLoading, error } = useQuery({
    queryKey: ["deck", deckId],
    queryFn: () => api.deckDetail(deckId),
    enabled: Number.isFinite(deckId),
  });

  const groupedCards = useMemo(() => {
    const bySection: Record<string, { cardId: number; cardName?: string; quantity: number }[]> = {};
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
      <section className="panel">
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
                    <span>{card.quantity}x</span>
                    <code>{card.cardName || card.cardId}</code>
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
