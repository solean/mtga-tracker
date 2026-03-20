import type { RankHistoryPoint, RankState } from "./types";

export type Ladder = "constructed" | "limited";

type LadderConfig = {
  label: string;
  tiers: string[];
};

export type GraphPoint = {
  matchNumber: number;
  score: number;
  rankLabel: string;
  result: RankHistoryPoint["result"];
  eventName: string;
  opponent: string;
  observedAt: string;
  endedAt: string;
};

export const LADDER_CONFIG: Record<Ladder, LadderConfig> = {
  constructed: {
    label: "Constructed",
    tiers: ["Spark", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Mythic"],
  },
  limited: {
    label: "Limited",
    tiers: ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Mythic"],
  },
};

export function rankStateFor(point: RankHistoryPoint, ladder: Ladder): RankState {
  return ladder === "constructed" ? point.constructed : point.limited;
}

function normalizeRankClass(rankClass: string): string {
  const trimmed = rankClass.trim();
  return trimmed || "Bronze";
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

function formatRankLabel(rank: RankState): string {
  if (rank.level == null || rank.seasonOrdinal == null) return "Unranked";
  const rankClass = normalizeRankClass(rank.rankClass);
  if (rankClass === "Mythic") return "Mythic";
  return `${rankClass} ${rank.level}`;
}

function rankScore(rank: RankState, ladder: Ladder): number | null {
  if (rank.level == null || rank.seasonOrdinal == null) return null;

  const rankClass = normalizeRankClass(rank.rankClass);
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

function sameNullableNumber(a?: number | null, b?: number | null): boolean {
  return a == null ? b == null : a === b;
}

function sameRankState(a: RankState | null | undefined, b: RankState | null | undefined): boolean {
  if (!a || !b) return a === b;

  return (
    sameNullableNumber(a.seasonOrdinal, b.seasonOrdinal) &&
    normalizeRankClass(a.rankClass) === normalizeRankClass(b.rankClass) &&
    sameNullableNumber(a.level, b.level) &&
    sameNullableNumber(a.step, b.step) &&
    sameNullableNumber(a.matchesWon, b.matchesWon) &&
    sameNullableNumber(a.matchesLost, b.matchesLost)
  );
}

function ladderStateChanged(
  previousPoint: RankHistoryPoint | null,
  point: RankHistoryPoint,
  ladder: Ladder,
): boolean {
  const current = rankStateFor(point, ladder);
  if (current.seasonOrdinal == null) return false;
  if (!previousPoint) return true;
  return !sameRankState(rankStateFor(previousPoint, ladder), current);
}

export function buildGraphPoints(history: RankHistoryPoint[], ladder: Ladder): {
  seasonOrdinal: number;
  points: GraphPoint[];
} | null {
  const changedPoints = history.filter((point, index) =>
    ladderStateChanged(index > 0 ? history[index - 1] : null, point, ladder),
  );
  if (changedPoints.length === 0) return null;

  const seasonOrdinal = rankStateFor(changedPoints[changedPoints.length - 1], ladder).seasonOrdinal;
  if (seasonOrdinal == null) return null;

  const points = changedPoints
    .filter((point) => rankStateFor(point, ladder).seasonOrdinal === seasonOrdinal)
    .map((point, index) => {
      const rank = rankStateFor(point, ladder);
      const score = rankScore(rank, ladder);
      if (score == null) return null;
      return {
        matchNumber: index + 1,
        score,
        rankLabel: formatRankLabel(rank),
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

export function tierLabelAt(value: number, ladder: Ladder): string {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > 0.001) return "";
  return LADDER_CONFIG[ladder].tiers[rounded] ?? "";
}
