import ReactECharts from "echarts-for-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";

import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import {
  buildGraphPoints,
  LADDER_CONFIG,
  seasonOrdinalsFor,
  tierLabelAt,
  type Ladder,
  type RankProgressSeries,
  type SeasonView,
} from "../lib/rankProgress";
import { useTheme, type Theme } from "../lib/theme";

type ChartThemeTokens = {
  accent: string;
  accentFaint: string;
  accentGlow: string;
  accentSoft: string;
  axisLine: string;
  axisText: string;
  hoverBorder: string;
  pointBorder: string;
  splitLine: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipText: string;
};

const CHART_THEME_TOKENS: Record<Theme, ChartThemeTokens> = {
  dark: {
    accent: "#ff8a24",
    accentFaint: "rgba(255, 138, 36, 0.02)",
    accentGlow: "rgba(255, 138, 36, 0.24)",
    accentSoft: "rgba(255, 138, 36, 0.12)",
    axisLine: "rgba(255, 145, 64, 0.16)",
    axisText: "#c5a086",
    hoverBorder: "#f2e6db",
    pointBorder: "rgba(24, 16, 10, 0.94)",
    splitLine: "rgba(255, 138, 36, 0.03)",
    tooltipBackground: "rgba(12, 8, 6, 0.97)",
    tooltipBorder: "rgba(255, 168, 90, 0.3)",
    tooltipText: "#f2e6db",
  },
  light: {
    accent: "#c55a11",
    accentFaint: "rgba(197, 90, 17, 0.02)",
    accentGlow: "rgba(197, 90, 17, 0.15)",
    accentSoft: "rgba(197, 90, 17, 0.1)",
    axisLine: "rgba(140, 62, 8, 0.14)",
    axisText: "#5c402d",
    hoverBorder: "#fffaf4",
    pointBorder: "rgba(247, 239, 230, 0.96)",
    splitLine: "rgba(197, 90, 17, 0.02)",
    tooltipBackground: "rgba(250, 243, 236, 0.98)",
    tooltipBorder: "rgba(140, 62, 8, 0.28)",
    tooltipText: "#24150b",
  },
};

const SEASON_VIEW_LABELS: Record<SeasonView, string> = {
  current: "Current",
  previous: "Previous",
  all: "All",
};

function handleSegmentedKeyDown<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  value: T,
  options: readonly T[],
  onChange: (next: T) => void,
) {
  const currentIndex = options.indexOf(value);
  if (currentIndex === -1) return;

  switch (event.key) {
    case "ArrowLeft":
    case "ArrowUp":
      event.preventDefault();
      onChange(options[(currentIndex + options.length - 1) % options.length]);
      break;
    case "ArrowRight":
    case "ArrowDown":
      event.preventDefault();
      onChange(options[(currentIndex + 1) % options.length]);
      break;
    case "Home":
      event.preventDefault();
      onChange(options[0]);
      break;
    case "End":
      event.preventDefault();
      onChange(options[options.length - 1]);
      break;
    default:
      break;
  }
}

function formatSnapshotLabel(count: number): string {
  return `${count} ranked snapshot${count === 1 ? "" : "s"}`;
}

function describeSeries(series: RankProgressSeries): string {
  if (series.seasonView === "all") {
    return `All seasons • ${formatSnapshotLabel(series.points.length)} across ${series.seasonOrdinals.length} season${series.seasonOrdinals.length === 1 ? "" : "s"}`;
  }

  return `Season ${series.seasonOrdinal} • ${formatSnapshotLabel(series.points.length)}`;
}

function describeSelection(seasonView: SeasonView): string {
  switch (seasonView) {
    case "previous":
      return "Review the most recent completed season for this ladder";
    case "all":
      return "View every recorded season on one timeline";
    default:
      return "Track how your ladder standing moves over time";
  }
}

function emptyStateMessage(seasonView: SeasonView): string {
  switch (seasonView) {
    case "previous":
      return "No previous season snapshots available for this ladder yet.";
    case "all":
      return "No rank snapshots available for this ladder yet.";
    default:
      return "No rank snapshots available for the current season yet.";
  }
}

export function RankProgressPanel() {
  const tabBaseId = useId();
  const theme = useTheme();
  const [ladder, setLadder] = useState<Ladder>("constructed");
  const [seasonView, setSeasonView] = useState<SeasonView>("current");
  const { data, isLoading, error } = useQuery({
    queryKey: ["rank-history"],
    queryFn: api.rankHistory,
  });
  const panelId = `${tabBaseId}-panel`;
  const headingId = `${tabBaseId}-heading`;
  const ladderOptions = ["constructed", "limited"] as const satisfies readonly Ladder[];
  const seasonOptions = ["current", "previous", "all"] as const satisfies readonly SeasonView[];

  const availableSeasons = useMemo(() => (data ? seasonOrdinalsFor(data, ladder) : []), [data, ladder]);
  const hasPreviousSeason = availableSeasons.length > 1;

  useEffect(() => {
    if (seasonView === "previous" && !hasPreviousSeason) {
      setSeasonView("current");
    }
  }, [hasPreviousSeason, seasonView]);

  const series = useMemo(
    () => (data ? buildGraphPoints(data, ladder, seasonView) : null),
    [data, ladder, seasonView],
  );
  const latestPoint = series ? series.points[series.points.length - 1] : null;
  const firstPoint = series?.points[0];
  const currentRank = latestPoint ? latestPoint.rankLabel : "Unranked";
  const currentState = series?.latestState ?? null;
  const currentRecord =
    currentState && currentState.matchesWon != null && currentState.matchesLost != null
      ? `${currentState.matchesWon}W-${currentState.matchesLost}L`
      : null;
  const chartTheme = CHART_THEME_TOKENS[theme];

  const chartOption = useMemo(
    () =>
      series && latestPoint
        ? {
          backgroundColor: "transparent",
          animationDuration: 320,
          grid: { left: 72, right: 28, top: 28, bottom: 34 },
          tooltip: {
            trigger: "axis",
            backgroundColor: chartTheme.tooltipBackground,
            borderColor: chartTheme.tooltipBorder,
            textStyle: {
              color: chartTheme.tooltipText,
              fontFamily: "IBM Plex Mono, Menlo, monospace",
              fontSize: 12,
            },
            axisPointer: {
              type: "line",
              lineStyle: { color: chartTheme.accent, opacity: 0.26 },
            },
            formatter: (params: any) => {
              const point = Array.isArray(params) ? params[0]?.data : params?.data;
              if (!point) return "";
              const resultLabel =
                point.result === "win" ? "Win" : point.result === "loss" ? "Loss" : "Unknown";
              const timestamp = point.observedAt || point.endedAt;
              return [
                `<div style="display:grid;gap:4px;">`,
                `<strong>${point.rankLabel}</strong>`,
                `<span>Season ${point.seasonOrdinal} • Match ${point.matchNumber} • ${resultLabel}</span>`,
                `<span>${point.eventName || "Unknown event"} vs ${point.opponent || "Unknown"}</span>`,
                `<span>${formatDateTime(timestamp)}</span>`,
                `</div>`,
              ].join("");
            },
          },
          xAxis: {
            type: "value",
            min: 1,
            max: Math.max(series.points.length, 1),
            splitNumber: Math.min(Math.max(Math.floor(series.points.length / 4), 4), 8),
            axisLine: { lineStyle: { color: chartTheme.axisLine } },
            axisTick: { show: false },
            axisLabel: {
              color: chartTheme.axisText,
              fontFamily: "IBM Plex Mono, Menlo, monospace",
              formatter: (value: number) => {
                if (value === 1 || value === series.points.length || value % 5 === 0) {
                  return `${Math.round(value)}`;
                }
                return "";
              },
            },
            splitLine: { show: false },
          },
          yAxis: {
            type: "value",
            min: Math.max(0, Math.floor(Math.min(...series.points.map((point) => point.score)))),
            max: Math.min(
              LADDER_CONFIG[ladder].tiers.length - 0.02,
              Math.ceil(Math.max(...series.points.map((point) => point.score))) + 0.25,
            ),
            interval: 1,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              color: chartTheme.axisText,
              fontFamily: "IBM Plex Mono, Menlo, monospace",
              margin: 14,
              formatter: (value: number) => tierLabelAt(value, ladder),
            },
            splitLine: {
              lineStyle: {
                color: chartTheme.splitLine,
                type: "solid",
              },
            },
          },
          series: [
            {
              type: "line",
              data: series.points.map((point) => ({
                ...point,
                value: [point.matchNumber, point.score],
              })),
              smooth: false,
              showSymbol: true,
              symbol: "circle",
              symbolSize: 8,
              lineStyle: {
                color: chartTheme.accent,
                width: 2.4,
                shadowBlur: 10,
                shadowColor: chartTheme.accentGlow,
              },
              itemStyle: {
                color: chartTheme.accent,
                borderColor: chartTheme.pointBorder,
                borderWidth: 1.5,
                shadowBlur: 8,
                shadowColor: chartTheme.accentGlow,
              },
              areaStyle: {
                color: {
                  type: "linear",
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: chartTheme.accentSoft },
                    { offset: 1, color: chartTheme.accentFaint },
                  ],
                },
              },
            },
            {
              type: "scatter",
              data: [
                {
                  ...latestPoint,
                  value: [latestPoint.matchNumber, latestPoint.score],
                },
              ],
              symbolSize: 12,
              itemStyle: {
                color: chartTheme.accent,
                borderColor: chartTheme.hoverBorder,
                borderWidth: 2,
                shadowBlur: 18,
                shadowColor: chartTheme.accentGlow,
              },
              z: 5,
            },
          ],
        }
        : null,
    [chartTheme, ladder, latestPoint, series],
  );

  const readyState =
    series && latestPoint && chartOption
      ? {
          chartOption,
          latestPoint,
          firstPoint,
          series,
        }
      : null;

  return (
    <section className="panel rank-panel">
      <div className="panel-head rank-toolbar">
        <div>
          <h3 id={headingId}>Rank Progress</h3>
          <p>{series ? describeSeries(series) : describeSelection(seasonView)}</p>
        </div>
        <div className="rank-control-stack">
          <div className="rank-control-group">
            <span className="rank-control-label">Ladder</span>
            <div className="tabs rank-toggle" role="group" aria-label="Ladder selector">
              {ladderOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={ladder === value}
                  className={`tab rank-toggle-button ${ladder === value ? "is-active" : ""}`}
                  onClick={() => setLadder(value)}
                  onKeyDown={(event) =>
                    handleSegmentedKeyDown(event, value, ladderOptions, setLadder)
                  }
                >
                  {LADDER_CONFIG[value].label}
                </button>
              ))}
            </div>
          </div>
          <div className="rank-control-group">
            <span className="rank-control-label">Season</span>
            <div className="tabs rank-toggle" role="group" aria-label="Season selector">
              {seasonOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={seasonView === value}
                  disabled={value === "previous" && !hasPreviousSeason}
                  className={`tab rank-toggle-button ${seasonView === value ? "is-active" : ""}`}
                  onClick={() => setSeasonView(value)}
                  onKeyDown={(event) =>
                    handleSegmentedKeyDown(event, value, seasonOptions, setSeasonView)
                  }
                >
                  {SEASON_VIEW_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {readyState ? (
        <div className="rank-summary">
          <div className="rank-chip">
            <span>Rank</span>
            <strong>{currentRank}</strong>
          </div>
          <div className="rank-chip">
            <span>{seasonView === "all" ? "Span" : "Path"}</span>
            <strong>
              {readyState.firstPoint
                ? `${readyState.firstPoint.rankLabel} to ${readyState.latestPoint.rankLabel}`
                : currentRank}
            </strong>
          </div>
          {currentRecord ? (
            <div className="rank-chip">
              <span>{seasonView === "all" ? "Latest Season Record" : "Season Record"}</span>
              <strong>{currentRecord}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className="rank-chart-frame"
        id={panelId}
        role="region"
        aria-labelledby={headingId}
      >
        {isLoading ? <p className="state">Loading ladder data…</p> : null}
        {error ? <p className="state error">{(error as Error).message}</p> : null}
        {!isLoading && !error && !readyState ? (
          <p className="state">{emptyStateMessage(seasonView)}</p>
        ) : null}
        {readyState ? (
          <ReactECharts
            key={`${ladder}-${seasonView}-${theme}`}
            option={readyState.chartOption}
            style={{ height: 320 }}
          />
        ) : null}
      </div>
    </section>
  );
}
