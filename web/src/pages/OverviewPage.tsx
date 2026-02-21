import ReactECharts from "echarts-for-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { ResultPill } from "../components/ResultPill";
import { api } from "../lib/api";
import { formatDateTime, formatDuration, pct } from "../lib/format";

export function OverviewPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
  });

  if (isLoading) return <p className="state">Loading overview…</p>;
  if (error) return <p className="state error">{(error as Error).message}</p>;
  if (!data) return <p className="state">No data.</p>;

  const chartOption = {
    backgroundColor: "transparent",
    tooltip: { trigger: "item" },
    series: [
      {
        name: "Matches",
        type: "pie",
        radius: ["45%", "70%"],
        avoidLabelOverlap: false,
        label: { show: false },
        data: [
          { value: data.wins, name: "Wins", itemStyle: { color: "#76c9a2" } },
          { value: data.losses, name: "Losses", itemStyle: { color: "#e18f85" } },
        ],
      },
    ],
  };

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
        <article className="metric-card emphasis">
          <p>Win Rate</p>
          <h2>{pct(data.winRate)}</h2>
        </article>
      </section>

      <section className="two-col">
        <article className="panel chart-panel">
          <h3>Record Split</h3>
          <ReactECharts option={chartOption} style={{ height: 280 }} />
        </article>

        <article className="panel">
          <div className="panel-head">
            <h3>Recent Matches</h3>
            <Link to="/matches" className="text-link">
              Open full history
            </Link>
          </div>
          <div className="list">
            {data.recent.slice(0, 8).map((match) => (
              <div className="list-row" key={match.id}>
                <div>
                  <p className="list-title">{match.eventName || "Unknown event"}</p>
                  <p className="list-subtitle">
                    vs {match.opponent || "Unknown"} • {formatDateTime(match.startedAt)}
                  </p>
                </div>
                <div className="list-right">
                  <ResultPill result={match.result} />
                  <small>{formatDuration(match.secondsCount ?? undefined)}</small>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
