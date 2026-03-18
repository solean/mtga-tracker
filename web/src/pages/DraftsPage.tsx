import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { StatusMessage } from "../components/StatusMessage";
import { api } from "../lib/api";
import { formatDateTime, pct } from "../lib/format";

const DRAFT_EVENT_DATE_PATTERN = /_(\d{4})(\d{2})(\d{2})$/;

function getDraftDeckDateValue(eventName?: string | null): number | null {
  const match = eventName?.match(DRAFT_EVENT_DATE_PATTERN);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function formatDraftDeckDate(eventName?: string | null): string {
  const dateValue = getDraftDeckDateValue(eventName);
  if (dateValue == null) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(dateValue));
}

export function DraftsPage() {
  const draftsQuery = useQuery({
    queryKey: ["drafts"],
    queryFn: api.drafts,
  });
  const draftDecksQuery = useQuery({
    queryKey: ["decks", "draft"],
    queryFn: () => api.decks("draft"),
  });

  const draftDecks = [...(draftDecksQuery.data ?? [])].sort((a, b) => {
    const aDate = getDraftDeckDateValue(a.eventName);
    const bDate = getDraftDeckDateValue(b.eventName);

    if (aDate != null && bDate != null && aDate !== bDate) {
      return bDate - aDate;
    }
    if (aDate != null) {
      return -1;
    }
    if (bDate != null) {
      return 1;
    }

    return b.deckId - a.deckId;
  });

  if (draftsQuery.isLoading || draftDecksQuery.isLoading) return <StatusMessage>Loading drafts…</StatusMessage>;
  if (draftsQuery.error) return <StatusMessage tone="error">{(draftsQuery.error as Error).message}</StatusMessage>;
  if (draftDecksQuery.error) return <StatusMessage tone="error">{(draftDecksQuery.error as Error).message}</StatusMessage>;

  const drafts = draftsQuery.data ?? [];

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
                <th>Date</th>
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
                  <td>{formatDraftDeckDate(deck.eventName)}</td>
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
