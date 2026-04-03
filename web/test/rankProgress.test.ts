import { describe, expect, test } from "bun:test";

import { buildGraphPoints, type Ladder, type SeasonView } from "../src/lib/rankProgress";
import type { RankHistoryPoint, RankState } from "../src/lib/types";

function rankState(values: Partial<Omit<RankState, "rankClass">> & { rankClass?: string } = {}): RankState {
  return {
    seasonOrdinal: values.seasonOrdinal ?? null,
    rankClass: values.rankClass ?? "",
    level: values.level ?? null,
    step: values.step ?? null,
    matchesWon: values.matchesWon ?? null,
    matchesLost: values.matchesLost ?? null,
  };
}

function point(
  matchId: number,
  eventName: string,
  result: RankHistoryPoint["result"],
  constructed: RankState,
  limited: RankState,
): RankHistoryPoint {
  return {
    matchId,
    arenaMatchId: `match-${matchId}`,
    eventName,
    opponent: "Opponent",
    result,
    observedAt: "",
    endedAt: `2026-03-19T00:00:0${matchId}Z`,
    constructed,
    limited,
  };
}

function resultsFor(history: RankHistoryPoint[], ladder: Ladder, seasonView?: SeasonView): string[] {
  return (
    buildGraphPoints(history, ladder, seasonView)?.points.map(
      (entry) => `${entry.eventName}:${entry.result}`,
    ) ?? []
  );
}

describe("buildGraphPoints", () => {
  test("excludes limited-only snapshots from the constructed chart", () => {
    const history: RankHistoryPoint[] = [
      point(
        1,
        "Traditional_Ladder",
        "loss",
        rankState({ seasonOrdinal: 12, rankClass: "Silver", level: 4, step: 2, matchesWon: 1, matchesLost: 1 }),
        rankState(),
      ),
      point(
        2,
        "QuickDraft_TST_20260319",
        "win",
        rankState({ seasonOrdinal: 12, rankClass: "Silver", level: 4, step: 2, matchesWon: 1, matchesLost: 1 }),
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 4, step: 1, matchesWon: 1, matchesLost: 0 }),
      ),
      point(
        3,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 12, rankClass: "Silver", level: 4, step: 3, matchesWon: 2, matchesLost: 1 }),
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 4, step: 1, matchesWon: 1, matchesLost: 0 }),
      ),
    ];

    expect(resultsFor(history, "constructed")).toEqual([
      "Traditional_Ladder:loss",
      "Traditional_Ladder:win",
    ]);
  });

  test("excludes constructed-only snapshots from the limited chart", () => {
    const history: RankHistoryPoint[] = [
      point(
        1,
        "QuickDraft_TST_20260319",
        "loss",
        rankState(),
        rankState({ seasonOrdinal: 18, rankClass: "Bronze", level: 4, step: 0, matchesWon: 0, matchesLost: 1 }),
      ),
      point(
        2,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 18, rankClass: "Gold", level: 2, step: 1, matchesWon: 1, matchesLost: 0 }),
        rankState({ seasonOrdinal: 18, rankClass: "Bronze", level: 4, step: 0, matchesWon: 0, matchesLost: 1 }),
      ),
      point(
        3,
        "QuickDraft_TST_20260319",
        "win",
        rankState({ seasonOrdinal: 18, rankClass: "Gold", level: 2, step: 1, matchesWon: 1, matchesLost: 0 }),
        rankState({ seasonOrdinal: 18, rankClass: "Bronze", level: 3, step: 1, matchesWon: 1, matchesLost: 1 }),
      ),
    ];

    expect(resultsFor(history, "limited")).toEqual([
      "QuickDraft_TST_20260319:loss",
      "QuickDraft_TST_20260319:win",
    ]);
  });

  test("returns only the current season by default", () => {
    const history: RankHistoryPoint[] = [
      point(
        1,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 11, rankClass: "Bronze", level: 4, step: 1, matchesWon: 1, matchesLost: 0 }),
        rankState(),
      ),
      point(
        2,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 11, rankClass: "Bronze", level: 3, step: 0, matchesWon: 2, matchesLost: 0 }),
        rankState(),
      ),
      point(
        3,
        "Traditional_Ladder",
        "loss",
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 4, step: 0, matchesWon: 0, matchesLost: 1 }),
        rankState(),
      ),
      point(
        4,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 3, step: 1, matchesWon: 1, matchesLost: 1 }),
        rankState(),
      ),
    ];

    const series = buildGraphPoints(history, "constructed");

    expect(series?.seasonOrdinal).toBe(12);
    expect(series?.seasonOrdinals).toEqual([11, 12]);
    expect(resultsFor(history, "constructed")).toEqual([
      "Traditional_Ladder:loss",
      "Traditional_Ladder:win",
    ]);
  });

  test("can return the previous season only", () => {
    const history: RankHistoryPoint[] = [
      point(
        1,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 11, rankClass: "Bronze", level: 4, step: 1, matchesWon: 1, matchesLost: 0 }),
        rankState(),
      ),
      point(
        2,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 11, rankClass: "Bronze", level: 3, step: 0, matchesWon: 2, matchesLost: 0 }),
        rankState(),
      ),
      point(
        3,
        "Traditional_Ladder",
        "loss",
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 4, step: 0, matchesWon: 0, matchesLost: 1 }),
        rankState(),
      ),
      point(
        4,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 3, step: 1, matchesWon: 1, matchesLost: 1 }),
        rankState(),
      ),
    ];

    const series = buildGraphPoints(history, "constructed", "previous");

    expect(series?.seasonOrdinal).toBe(11);
    expect(series?.latestState.matchesWon).toBe(2);
    expect(resultsFor(history, "constructed", "previous")).toEqual([
      "Traditional_Ladder:win",
      "Traditional_Ladder:win",
    ]);
  });

  test("can return all seasons on one timeline", () => {
    const history: RankHistoryPoint[] = [
      point(
        1,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 11, rankClass: "Bronze", level: 4, step: 1, matchesWon: 1, matchesLost: 0 }),
        rankState(),
      ),
      point(
        2,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 11, rankClass: "Bronze", level: 3, step: 0, matchesWon: 2, matchesLost: 0 }),
        rankState(),
      ),
      point(
        3,
        "Traditional_Ladder",
        "loss",
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 4, step: 0, matchesWon: 0, matchesLost: 1 }),
        rankState(),
      ),
      point(
        4,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 3, step: 1, matchesWon: 1, matchesLost: 1 }),
        rankState(),
      ),
    ];

    const series = buildGraphPoints(history, "constructed", "all");

    expect(series?.seasonOrdinal).toBeNull();
    expect(series?.seasonOrdinals).toEqual([11, 12]);
    expect(series?.points.map((entry) => entry.seasonOrdinal)).toEqual([11, 11, 12, 12]);
    expect(resultsFor(history, "constructed", "all")).toEqual([
      "Traditional_Ladder:win",
      "Traditional_Ladder:win",
      "Traditional_Ladder:loss",
      "Traditional_Ladder:win",
    ]);
  });

  test("returns null for previous season when only one season exists", () => {
    const history: RankHistoryPoint[] = [
      point(
        1,
        "Traditional_Ladder",
        "win",
        rankState({ seasonOrdinal: 12, rankClass: "Bronze", level: 4, step: 1, matchesWon: 1, matchesLost: 0 }),
        rankState(),
      ),
    ];

    expect(buildGraphPoints(history, "constructed", "previous")).toBeNull();
  });
});
