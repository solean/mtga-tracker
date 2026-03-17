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
          {data.recent.slice(0, 8).map((match) => {
            const queueLabel = match.eventName || "Unknown event";
            const title = match.deckName || queueLabel;
            const subtitle = match.deckName ? `Queue • ${queueLabel}` : null;
            const timingParts: string[] = [];
            const duration = formatDuration(match.secondsCount ?? undefined);

            if (duration !== "-") {
              timingParts.push(duration);
            }
            if (match.turnCount != null) {
              timingParts.push(`${match.turnCount} turn${match.turnCount === 1 ? "" : "s"}`);
            }

            return (
              <Link className="list-row" key={match.id} to={`/matches/${match.id}`}>
                <div className="list-main">
                  <p className="list-title">{title}</p>
                  {subtitle ? <p className="list-subtitle">{subtitle}</p> : null}
                </div>

                <dl className="list-meta" aria-label="Recent match summary">
                  <div className="list-meta-item">
                    <dt>Opponent</dt>
                    <dd>{match.opponent || "Unknown"}</dd>
                  </div>
                  <div className="list-meta-item">
                    <dt>Started</dt>
                    <dd>{formatDateTime(match.startedAt)}</dd>
                  </div>
                  <div className="list-meta-item list-meta-item--colors">
                    <dt>Colors</dt>
                    <dd>
                      <MatchDeckColors
                        className="match-deck-colors-list"
                        deckColors={match.deckColors}
                        deckColorsKnown={match.deckColorsKnown}
                        opponentDeckColors={match.opponentDeckColors}
                        opponentDeckColorsKnown={match.opponentDeckColorsKnown}
                      />
                    </dd>
                  </div>
                </dl>

                <div className="list-right">
                  <ResultPill result={match.result} />
                  <small>{timingParts.join(" • ") || "Timing unavailable"}</small>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
