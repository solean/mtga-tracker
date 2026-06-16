import { describe, expect, test } from "bun:test";

import {
  battlefieldSectionKind,
  boardZoneKind,
  boardZoneLabel,
  buildReplayTurnBoundaries,
  describeReplayChange,
  filterMeaningfulReplayFrames,
  formatReplayWinReason,
  normalizeReplayWinReason,
  preferredReplayFrameIndex,
  replayFrameHasLifeDelta,
  replayFrameLifeTotalWinner,
  replayLifeDelta,
  replayTurnBoundaryCount,
  replayTurnValue,
  summarizeReplayGame,
} from "../src/lib/replay";
import type { CardPreview } from "../src/lib/scryfall";
import type {
  MatchReplayChange,
  MatchReplayFrame,
  MatchReplayFrameObject,
} from "../src/lib/types";

function change(values: Partial<MatchReplayChange> = {}): MatchReplayChange {
  return {
    instanceId: values.instanceId ?? 1,
    cardId: values.cardId ?? 100,
    cardName: values.cardName,
    playerSide: values.playerSide ?? "self",
    action: values.action ?? "move_public",
    fromZoneType: values.fromZoneType,
    toZoneType: values.toZoneType,
    isToken: values.isToken ?? false,
  };
}

function object(
  values: Partial<MatchReplayFrameObject> = {},
): MatchReplayFrameObject {
  return {
    id: values.id ?? 1,
    frameId: values.frameId ?? 1,
    instanceId: values.instanceId ?? 1,
    cardId: values.cardId ?? 100,
    playerSide: values.playerSide ?? "self",
    zoneType: values.zoneType ?? "Battlefield",
    isToken: values.isToken ?? false,
    isTapped: values.isTapped ?? false,
    hasSummoningSickness: values.hasSummoningSickness ?? false,
  };
}

function frame(values: Partial<MatchReplayFrame> = {}): MatchReplayFrame {
  return { id: values.id ?? 1, ...values };
}

function preview(typeLine: string): CardPreview {
  return { name: "x", imageUrl: "", typeLine };
}

describe("zone classification", () => {
  test("maps Arena zone strings to a board zone kind", () => {
    expect(boardZoneKind("ZoneType_Hand")).toBe("hand");
    expect(boardZoneKind("Battlefield")).toBe("battlefield");
    expect(boardZoneKind("p1_graveyard")).toBe("graveyard");
    expect(boardZoneKind("")).toBe("other");
    expect(boardZoneLabel("graveyard")).toBe("Graveyard");
  });

  test("sorts permanents into battlefield sections by type line", () => {
    expect(battlefieldSectionKind(preview("Basic Land — Forest"))).toBe("lands");
    expect(battlefieldSectionKind(preview("Creature — Otter"))).toBe("creatures");
    expect(battlefieldSectionKind(preview("Legendary Planeswalker — Jace"))).toBe(
      "planeswalkers",
    );
    expect(battlefieldSectionKind(preview("Enchantment — Class"))).toBe(
      "artifacts_enchantments",
    );
    expect(battlefieldSectionKind(null)).toBe("other");
  });
});

describe("turn boundaries", () => {
  test("groups items by turn, preserving first/last index", () => {
    const boundaries = buildReplayTurnBoundaries([
      { turnNumber: 1 },
      { turnNumber: 1 },
      { turnNumber: 2 },
    ]);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toMatchObject({ turnKey: 1, firstIndex: 0, lastIndex: 1 });
    expect(replayTurnBoundaryCount(boundaries[0])).toBe(2);
    expect(boundaries[1]).toMatchObject({ turnKey: 2, firstIndex: 2, lastIndex: 2 });
  });

  test("normalizes missing/zero turns to a sentinel", () => {
    expect(replayTurnValue(undefined)).toBe(-1);
    expect(replayTurnValue(0)).toBe(-1);
    expect(replayTurnValue(3)).toBe(3);
  });
});

describe("meaningful frame filtering", () => {
  test("keeps frames with changes and drops inert ones", () => {
    const f0 = frame({ id: 1 });
    const f1 = frame({ id: 2, changes: [change({ action: "tap" })] });
    const f2 = frame({ id: 3 });
    expect(filterMeaningfulReplayFrames([f0, f1, f2])).toEqual([f1]);
  });

  test("keeps a frame whose only change is a life swing", () => {
    const f0 = frame({ id: 1, selfLifeTotal: 20 });
    const f1 = frame({ id: 2, selfLifeTotal: 18 });
    expect(replayFrameHasLifeDelta(f0, f1)).toBe(true);
    // f0 is inert on its own (no prior frame, no changes) and is dropped; the
    // life-swing frame f1 is retained.
    expect(filterMeaningfulReplayFrames([f0, f1])).toEqual([f1]);
  });

  test("falls back to the last frame when nothing is meaningful", () => {
    const f0 = frame({ id: 1 });
    const f1 = frame({ id: 2 });
    expect(filterMeaningfulReplayFrames([f0, f1])).toEqual([f1]);
  });
});

describe("HUD life delta", () => {
  test("returns the signed change for a side, or null when flat/unknown", () => {
    const prev = frame({ id: 1, selfLifeTotal: 20, opponentLifeTotal: 18 });
    const next = frame({ id: 2, selfLifeTotal: 17, opponentLifeTotal: 18 });
    expect(replayLifeDelta(prev, next, "self")).toBe(-3);
    expect(replayLifeDelta(prev, next, "opponent")).toBeNull();
    expect(replayLifeDelta(null, next, "self")).toBeNull();
    expect(
      replayLifeDelta(frame({ id: 1 }), frame({ id: 2, selfLifeTotal: 5 }), "self"),
    ).toBeNull();
  });
});

describe("preferred starting frame", () => {
  test("prefers the last frame that has visible objects", () => {
    const frames = [
      frame({ id: 1, objects: [] }),
      frame({ id: 2, objects: [object()] }),
      frame({ id: 3, objects: [] }),
    ];
    expect(preferredReplayFrameIndex(frames)).toBe(1);
  });
});

describe("change narration", () => {
  test("renders human-readable beats with the acting player", () => {
    expect(
      describeReplayChange(
        change({ action: "block", playerSide: "opponent", cardName: "Otter" }),
      ),
    ).toBe("Opponent declared Otter as a blocker.");
    expect(
      describeReplayChange(
        change({
          action: "move_public",
          playerSide: "self",
          cardName: "Tarmogoyf",
          fromZoneType: "Hand",
          toZoneType: "Battlefield",
        }),
      ),
    ).toBe("You moved Tarmogoyf from Hand to Battlefield.");
  });

  test("falls back to a card id when the name is unknown", () => {
    expect(
      describeReplayChange(change({ action: "tap", cardId: 42, cardName: undefined })),
    ).toBe("You tapped Card 42.");
  });
});

describe("win reason formatting", () => {
  test("strips Arena prefixes and humanizes the reason", () => {
    expect(normalizeReplayWinReason("ResultReason_Concede")).toBe("Concede");
    expect(formatReplayWinReason("ResultReason_Concede")).toBe("concede");
    expect(normalizeReplayWinReason(null)).toBe("");
  });
});

describe("game result inference", () => {
  test("reads the winner from terminal life totals", () => {
    expect(
      replayFrameLifeTotalWinner(frame({ selfLifeTotal: 0, opponentLifeTotal: 5 })),
    ).toBe("opponent");
    expect(
      replayFrameLifeTotalWinner(frame({ selfLifeTotal: 12, opponentLifeTotal: 0 })),
    ).toBe("self");
    expect(
      replayFrameLifeTotalWinner(frame({ selfLifeTotal: 3, opponentLifeTotal: 4 })),
    ).toBe("unknown");
  });

  test("summarizes a lethal-damage loss", () => {
    const summary = summarizeReplayGame([
      frame({ id: 1, selfLifeTotal: 4, opponentLifeTotal: 6 }),
      frame({ id: 2, selfLifeTotal: 0, opponentLifeTotal: 6 }),
    ]);
    expect(summary).toEqual({ result: "loss", detail: "You went to 0 life." });
  });

  test("summarizes an opponent concession", () => {
    const summary = summarizeReplayGame([
      frame({
        id: 1,
        selfLifeTotal: 20,
        opponentLifeTotal: 20,
        winningPlayerSide: "self",
        winReason: "ResultReason_Concede",
      }),
    ]);
    expect(summary).toEqual({ result: "win", detail: "Opponent conceded." });
  });

  test("lets a known match result override an ambiguous final game", () => {
    const summary = summarizeReplayGame(
      [frame({ id: 1, selfLifeTotal: 6, opponentLifeTotal: 7 })],
      { isFinalGame: true, matchResult: "win" },
    );
    expect(summary?.result).toBe("win");
  });
});
