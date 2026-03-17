import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { MatchDeckColors } from "../components/MatchDeckColors";
import { RankProgressPanel } from "../components/RankProgressPanel";
import { ResultPill } from "../components/ResultPill";
import { StatusMessage } from "../components/StatusMessage";
import { api } from "../lib/api";
import { formatDateTime, formatDuration, pct } from "../lib/format";

export function OverviewPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
  });

  if (isLoading) return <StatusMessage>Loading overview…</StatusMessage>;
  if (error) return <StatusMessage tone="error">{(error as Error).message}</StatusMessage>;
  if (!data) return <StatusMessage>No data.</StatusMessage>;

  const displayedWinRate = Number((data.winRate * 100).toFixed(1));
  const winRateTone =
    displayedWinRate > 50 ? "positive" : displayedWinRate < 50 ? "negative" : "neutral";

  return (
    <div className="stack-lg">
      <section className="metrics-grid">
        <article className="metric-card">
          <p>Total Matches</p>
          <h2>{data.totalMatches}</h2>
        </article>
        <article className="metric-card">
          <p>Wins</p>
          <h2>{data.wins}</h2>
        </article>
        <article className="metric-card">
          <p>Losses</p>
          <h2>{data.losses}</h2>
        </article>
        <article className={`metric-card win-rate-card win-rate-card--${winRateTone}`}>
          <p>Win Rate</p>
          <h2>{pct(data.winRate)}</h2>
        </article>
      </section>

      <RankProgressPanel />

      <section className="panel">
        <div className="panel-head">
          <h3>Recent Matches</h3>
          <Link to="/matches" className="text-link">
            Open full history
          </Link>
        </div>
        <div className="list">
          {data.recent.slice(0, 8).map((match) => (
            <Link className="list-row" key={match.id} to={`/matches/${match.id}`}>
              <div>
                <p className="list-title">{match.eventName || "Unknown event"}</p>
                <p className="list-subtitle">
                  vs {match.opponent || "Unknown"} • {formatDateTime(match.startedAt)}
                </p>
                <MatchDeckColors
                  className="match-deck-colors-list"
                  deckColors={match.deckColors}
                  deckColorsKnown={match.deckColorsKnown}
                  opponentDeckColors={match.opponentDeckColors}
                  opponentDeckColorsKnown={match.opponentDeckColorsKnown}
                />
              </div>
              <div className="list-right">
                <ResultPill result={match.result} />
                <small>{formatDuration(match.secondsCount ?? undefined)}</small>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
