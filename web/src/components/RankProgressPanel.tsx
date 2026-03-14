import ReactECharts from "echarts-for-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { RankHistoryPoint, RankState } from "../lib/types";

type Ladder = "constructed" | "limited";

type LadderConfig = {
  label: string;
  tiers: string[];
};

type GraphPoint = {
  matchNumber: number;
  score: number;
  rankLabel: string;
  result: RankHistoryPoint["result"];
  eventName: string;
  opponent: string;
  observedAt: string;
  endedAt: string;
};

const LADDER_CONFIG: Record<Ladder, LadderConfig> = {
  constructed: {
    label: "Constructed",
    tiers: ["Spark", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Mythic"],
  },
  limited: {
    label: "Limited",
    tiers: ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Mythic"],
  },
};

function themeVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function rankStateFor(point: RankHistoryPoint, ladder: Ladder): RankState {
  return ladder === "constructed" ? point.constructed : point.limited;
}

function normalizeRankClass(rankClass: string, ladder: Ladder): string {
  const trimmed = rankClass.trim();
  if (trimmed) return trimmed;
  return ladder === "constructed" ? "Bronze" : "Bronze";
}

function stepsPerLevel(ladder: Ladder, rankClass: string): number {
  if (rankClass === "Mythic") return 1;
  if (ladder === "constructed") {
    if (rankClass === "Spark") return 5;
    return 6;
  }
  if (rankClass === "Bronze") return 4;
  return 5;
}

function formatRankLabel(rank: RankState, ladder: Ladder): string {
  if (rank.level == null || rank.seasonOrdinal == null) return "Unranked";
  const rankClass = normalizeRankClass(rank.rankClass, ladder);
  if (rankClass === "Mythic") return "Mythic";
  return `${rankClass} ${rank.level}`;
}

function rankScore(rank: RankState, ladder: Ladder): number | null {
  if (rank.level == null || rank.seasonOrdinal == null) return null;

  const rankClass = normalizeRankClass(rank.rankClass, ladder);
  const config = LADDER_CONFIG[ladder];
  const tierIndex = config.tiers.indexOf(rankClass);
  if (tierIndex === -1) return null;
  if (rankClass === "Mythic") return tierIndex + 0.92;

  const level = Math.min(Math.max(rank.level, 1), 4);
  const totalSteps = stepsPerLevel(ladder, rankClass);
  const stepProgress =
    rank.step != null ? Math.min(Math.max(rank.step, 0), totalSteps) / totalSteps : 0;

  return tierIndex + ((4 - level) + stepProgress) / 4;
}

function buildGraphPoints(history: RankHistoryPoint[], ladder: Ladder): {
  seasonOrdinal: number;
  points: GraphPoint[];
} | null {
  const rankedPoints = history.filter((point) => rankStateFor(point, ladder).seasonOrdinal != null);
  if (rankedPoints.length === 0) return null;

  const seasonOrdinal = rankStateFor(rankedPoints[rankedPoints.length - 1], ladder).seasonOrdinal;
  if (seasonOrdinal == null) return null;

  const points = rankedPoints
    .filter((point) => rankStateFor(point, ladder).seasonOrdinal === seasonOrdinal)
    .map((point, index) => {
      const rank = rankStateFor(point, ladder);
      const score = rankScore(rank, ladder);
      if (score == null) return null;
      return {
        matchNumber: index + 1,
        score,
        rankLabel: formatRankLabel(rank, ladder),
        result: point.result,
        eventName: point.eventName,
        opponent: point.opponent,
        observedAt: point.observedAt,
        endedAt: point.endedAt,
      } satisfies GraphPoint;
    })
    .filter((point): point is GraphPoint => point !== null);

  if (points.length === 0) return null;
  return { seasonOrdinal, points };
}

function tierLabelAt(value: number, ladder: Ladder): string {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > 0.001) return "";
  return LADDER_CONFIG[ladder].tiers[rounded] ?? "";
}

export function RankProgressPanel() {
  const [ladder, setLadder] = useState<Ladder>("constructed");
  const { data, isLoading, error } = useQuery({
    queryKey: ["rank-history"],
    queryFn: api.rankHistory,
  });

  const series = data ? buildGraphPoints(data, ladder) : null;
  const currentPoint = series ? series.points[series.points.length - 1] : null;
  const firstPoint = series?.points[0];
  const currentRank = currentPoint ? currentPoint.rankLabel : "Unranked";
  const currentState = data && currentPoint ? rankStateFor(data[data.length - 1], ladder) : null;
  const currentRecord =
    currentState && currentState.matchesWon != null && currentState.matchesLost != null
      ? `${currentState.matchesWon}W-${currentState.matchesLost}L`
      : null;

  const chartOption =
    series && currentPoint
      ? {
          backgroundColor: "transparent",
          animationDuration: 500,
          grid: { left: 72, right: 28, top: 34, bottom: 42 },
          tooltip: {
            trigger: "axis",
            backgroundColor: themeVar("--popover-bg", "rgba(7, 13, 12, 0.96)"),
            borderColor: themeVar("--line-strong", "rgba(174, 206, 185, 0.48)"),
            textStyle: { color: themeVar("--text", "#e7eee8") },
            axisPointer: {
              type: "line",
              lineStyle: { color: themeVar("--accent", "#d5bc84"), opacity: 0.32 },
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
                `<span>Match ${point.matchNumber} • ${resultLabel}</span>`,
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
            axisLine: { lineStyle: { color: themeVar("--line", "rgba(128, 164, 146, 0.3)") } },
            axisTick: { show: false },
            axisLabel: {
              color: themeVar("--muted-strong", "#c6d2cb"),
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
              color: themeVar("--muted-strong", "#c6d2cb"),
              margin: 14,
              formatter: (value: number) => tierLabelAt(value, ladder),
            },
            splitLine: {
              lineStyle: {
                color: themeVar("--veil-line", "rgba(213, 188, 132, 0.06)"),
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
              symbolSize: 7,
              lineStyle: {
                color: "rgba(246, 244, 239, 0.96)",
                width: 2.4,
              },
              itemStyle: {
                color: "rgba(246, 244, 239, 0.96)",
                borderColor: themeVar("--surface-strong", "#162a25"),
                borderWidth: 1.5,
              },
              areaStyle: {
                color: {
                  type: "linear",
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: "rgba(213, 188, 132, 0.12)" },
                    { offset: 1, color: "rgba(213, 188, 132, 0.01)" },
                  ],
                },
              },
            },
            {
              type: "scatter",
              data: [
                {
                  ...currentPoint,
                  value: [currentPoint.matchNumber, currentPoint.score],
                },
              ],
              symbolSize: 12,
              itemStyle: {
                color: "#4ba3d9",
                borderColor: "#ffffff",
                borderWidth: 2,
                shadowBlur: 18,
                shadowColor: "rgba(75, 163, 217, 0.45)",
              },
              z: 5,
            },
          ],
        }
      : null;
  const readyState =
    series && currentPoint && chartOption
      ? {
          chartOption,
          currentPoint,
          firstPoint,
          series,
        }
      : null;

  return (
    <section className="panel rank-panel">
      <div className="rank-toolbar">
        <div>
          <h3>Ladder Performance</h3>
          <p>
            {series ? `Season ${series.seasonOrdinal} • ${series.points.length} ranked snapshots` : "Rank progress over time"}
          </p>
        </div>
        <div className="rank-toggle" role="tablist" aria-label="Ladder selector">
          {(["constructed", "limited"] as Ladder[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`rank-toggle-button ${ladder === value ? "is-active" : ""}`}
              onClick={() => setLadder(value)}
            >
              {LADDER_CONFIG[value].label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? <p className="state">Loading ladder data…</p> : null}
      {error ? <p className="state error">{(error as Error).message}</p> : null}
      {!isLoading && !error && !series ? (
        <p className="state">No rank snapshots available for this ladder yet.</p>
      ) : null}

      {readyState ? (
        <>
          <div className="rank-summary">
            <div className="rank-chip">
              <span>Current</span>
              <strong>{currentRank}</strong>
            </div>
            <div className="rank-chip">
              <span>Path</span>
              <strong>
                {readyState.firstPoint
                  ? `${readyState.firstPoint.rankLabel} to ${readyState.currentPoint.rankLabel}`
                  : currentRank}
              </strong>
            </div>
            {currentRecord ? (
              <div className="rank-chip">
                <span>Season Record</span>
                <strong>{currentRecord}</strong>
              </div>
            ) : null}
          </div>
          <ReactECharts option={readyState.chartOption} style={{ height: 340 }} />
        </>
      ) : null}
    </section>
  );
}
