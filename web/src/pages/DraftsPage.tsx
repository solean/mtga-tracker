import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { formatDateTime, pct } from "../lib/format";

export function DraftsPage() {
  const draftsQuery = useQuery({
    queryKey: ["drafts"],
    queryFn: api.drafts,
  });
  const draftDecksQuery = useQuery({
    queryKey: ["decks", "draft"],
    queryFn: () => api.decks("draft"),
  });

  if (draftsQuery.isLoading || draftDecksQuery.isLoading) return <p className="state">Loading drafts…</p>;
  if (draftsQuery.error) return <p className="state error">{(draftsQuery.error as Error).message}</p>;
  if (draftDecksQuery.error) return <p className="state error">{(draftDecksQuery.error as Error).message}</p>;

  const drafts = draftsQuery.data ?? [];
  const draftDecks = draftDecksQuery.data ?? [];

  return (
    <div className="stack-lg">
      <section className="panel">
        <div className="panel-head">
          <h3>Draft Sessions</h3>
          <p>{drafts.length} sessions</p>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Event</th>
                <th>Mode</th>
                <th>Picks</th>
                <th>Started</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((draft) => (
                <tr key={draft.id}>
                  <td>
                    <Link to={`/drafts/${draft.id}`} className="text-link">
                      {draft.id}
                    </Link>
                  </td>
                  <td>{draft.eventName || "-"}</td>
                  <td>{draft.isBotDraft ? "Bot Draft" : "Player Draft"}</td>
                  <td>{draft.picks}</td>
                  <td>{formatDateTime(draft.startedAt)}</td>
                  <td>{formatDateTime(draft.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Draft Decks</h3>
          <p>{draftDecks.length} decks</p>
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
              {draftDecks.map((deck) => (
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
    </div>
  );
}
