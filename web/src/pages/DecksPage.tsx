import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { pct } from "../lib/format";

export function DecksPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["decks"],
    queryFn: () => api.decks(),
  });

  if (isLoading) return <p className="state">Loading decks…</p>;
  if (error) return <p className="state error">{(error as Error).message}</p>;

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Deck Performance</h3>
        <p>{data?.length ?? 0} decks</p>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Deck</th>
              <th>Format</th>
              <th>Event</th>
              <th>Matches</th>
              <th>Wins</th>
              <th>Losses</th>
              <th>Win Rate</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((deck) => (
              <tr key={deck.deckId}>
                <td>
                  <Link to={`/decks/${deck.deckId}`} className="text-link">
                    {deck.deckName || `Deck ${deck.deckId}`}
                  </Link>
                </td>
                <td>{deck.format || "-"}</td>
                <td>{deck.eventName || "-"}</td>
                <td>{deck.matches}</td>
                <td>{deck.wins}</td>
                <td>{deck.losses}</td>
                <td>{pct(deck.winRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
