import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Link, useParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";

import { MatchDeckColors } from "../components/MatchDeckColors";
import { ManaSymbol } from "../components/ManaSymbol";
import { ResultPill } from "../components/ResultPill";
import { StatusMessage } from "../components/StatusMessage";
import { api } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";
import { fetchCardPreview } from "../lib/scryfall";
import type { CardPreview } from "../lib/scryfall";
import type {
  MatchCardPlay,
  MatchReplayChange,
  MatchReplayFrame,
  MatchReplayFrameObject,
} from "../lib/types";

type OpponentDeckCard = {
  cardId: number;
  cardName?: string;
  quantity: number;
};
type PreviewCard = {
  cardId: number;
  cardName?: string;
};

type PopoverPlacement = "left" | "right";
type ManaCostPart =
  | { kind: "symbol"; token: string }
  | { kind: "separator"; value: string };
type TimelineDisplayMode = "board" | "list";
type BoardZoneKind =
  | "battlefield"
  | "stack"
  | "graveyard"
  | "exile"
  | "revealed"
  | "other";
type BattlefieldSectionKind =
  | "lands"
  | "creatures"
  | "artifacts_enchantments"
  | "planeswalkers"
  | "battles"
  | "other";
type ReplayCounterSummary = {
  label: string;
  count: number;
};

const BOARD_ZONE_ORDER: BoardZoneKind[] = [
  "battlefield",
  "stack",
  "graveyard",
  "exile",
  "revealed",
  "other",
];
const BATTLEFIELD_SECTION_ORDER: BattlefieldSectionKind[] = [
  "lands",
  "creatures",
  "artifacts_enchantments",
  "planeswalkers",
  "battles",
  "other",
];
const SELF_BATTLEFIELD_SECTION_ORDER: BattlefieldSectionKind[] = [
  "creatures",
  "artifacts_enchantments",
  "planeswalkers",
  "battles",
  "other",
  "lands",
];

function cardDisplayName(card: PreviewCard): string {
  return card.cardName?.trim() || `Card ${card.cardId}`;
}

function timelinePlayerLabel(playerSide?: string): string {
  if (playerSide === "self") return "You";
  if (playerSide === "opponent") return "Opponent";
  return "Unknown";
}

function timelineZoneLabel(zone: string): string {
  const trimmed = zone.trim();
  if (!trimmed) return "-";
  return trimmed
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function timelinePhaseLabel(phase: string | undefined): string {
  const trimmed = phase?.trim() ?? "";
  if (!trimmed) return "-";
  return trimmed
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function cardPreviewQueryKey(card: PreviewCard): [string, number, string] {
  return ["card-preview", card.cardId, cardDisplayName(card)];
}

function cardFallbackHref(card: PreviewCard): string {
  const name = cardDisplayName(card);
  return card.cardName?.trim()
    ? `https://scryfall.com/search?q=${encodeURIComponent(`!"${name}"`)}`
    : `https://scryfall.com/search?q=${encodeURIComponent(`arenaid:${card.cardId}`)}`;
}

function parseManaCostParts(manaCost: string): ManaCostPart[] {
  const trimmed = manaCost.trim();
  if (!trimmed) {
    return [];
  }

  const parts: ManaCostPart[] = [];
  const tokenPattern = /\{([^}]+)\}/g;
  let lastIndex = 0;

  while (true) {
    const match = tokenPattern.exec(trimmed);
    if (!match) {
      break;
    }

    const between = trimmed.slice(lastIndex, match.index).trim();
    if (between) {
      parts.push({ kind: "separator", value: between });
    }

    const token = match[1]?.trim();
    if (token) {
      parts.push({ kind: "symbol", token });
    }

    lastIndex = tokenPattern.lastIndex;
  }

  const tail = trimmed.slice(lastIndex).trim();
  if (tail) {
    parts.push({ kind: "separator", value: tail });
  }

  return parts;
}

function boardZoneKind(zone: string): BoardZoneKind {
  const normalized = zone.trim().toLowerCase();
  if (!normalized) return "other";
  if (normalized.includes("battlefield")) return "battlefield";
  if (normalized.includes("stack")) return "stack";
  if (normalized.includes("graveyard")) return "graveyard";
  if (normalized.includes("exile")) return "exile";
  if (normalized.includes("reveal")) return "revealed";
  return "other";
}

function boardZoneLabel(kind: BoardZoneKind): string {
  if (kind === "battlefield") return "Battlefield";
  if (kind === "stack") return "Stack";
  if (kind === "graveyard") return "Graveyard";
  if (kind === "exile") return "Exile";
  if (kind === "revealed") return "Revealed";
  return "Other";
}

function boardTurnLabel(turnNumber?: number): string {
  return turnNumber && turnNumber > 0 ? `T${turnNumber}` : "T?";
}

function boardPlayMeta(play: MatchCardPlay): string {
  const parts = [boardTurnLabel(play.turnNumber)];
  const phase = timelinePhaseLabel(play.phase);
  if (phase !== "-") {
    parts.push(phase);
  }
  return parts.join(" • ");
}

function ManaCostDisplay({ manaCost }: { manaCost: string }) {
  const trimmed = manaCost.trim();
  if (!trimmed) {
    return <code className="deck-card-mana-cost">-</code>;
  }

  const parts = parseManaCostParts(trimmed);
  if (parts.length === 0) {
    return <code className="deck-card-mana-cost">{trimmed}</code>;
  }

  return (
    <span
      className="deck-card-mana-cost deck-card-mana-icons"
      aria-label={`Mana cost ${trimmed}`}
    >
      {parts.map((part, index) =>
        part.kind === "symbol" ? (
          <ManaSymbol
            key={`symbol-${part.token}-${index}`}
            token={part.token}
          />
        ) : (
          <span
            className="mana-symbol-separator"
            key={`sep-${part.value}-${index}`}
          >
            {part.value}
          </span>
        ),
      )}
    </span>
  );
}

function CardPreviewName({ card }: { card: PreviewCard }) {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPlacement, setPopoverPlacement] =
    useState<PopoverPlacement>("right");
  const [popoverStyle, setPopoverStyle] = useState<{
    top: number;
    left: number;
  }>({ top: 0, left: 0 });
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const name = cardDisplayName(card);
  const fallbackHref = cardFallbackHref(card);

  const updatePopoverPlacement = () => {
    if (typeof window === "undefined") {
      return;
    }

    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const popoverWidth = 336;
    const popoverHeight = 468;
    const horizontalGap = 14;
    const verticalMargin = 10;
    const availableRight = viewportWidth - rect.right;
    const availableLeft = rect.left;
    let placement: PopoverPlacement;

    if (availableRight >= popoverWidth + horizontalGap) {
      placement = "right";
    } else if (availableLeft >= popoverWidth + horizontalGap) {
      placement = "left";
    } else {
      placement = availableRight >= availableLeft ? "right" : "left";
    }

    const left =
      placement === "right"
        ? rect.right + horizontalGap
        : rect.left - popoverWidth - horizontalGap;
    const maxTop = Math.max(
      verticalMargin,
      viewportHeight - popoverHeight - verticalMargin,
    );
    const centeredTop = rect.top + rect.height / 2 - popoverHeight / 2;
    const top = Math.max(verticalMargin, Math.min(centeredTop, maxTop));

    setPopoverPlacement(placement);
    setPopoverStyle({ top, left });
  };

  const openPopover = () => {
    updatePopoverPlacement();
    setIsOpen(true);
  };

  const previewQuery = useQuery({
    queryKey: cardPreviewQueryKey(card),
    queryFn: () => fetchCardPreview(card.cardId, card.cardName),
    enabled: isOpen,
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onResize = () => updatePopoverPlacement();
    const onScroll = () => updatePopoverPlacement();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [isOpen]);

  return (
    <div
      className="card-preview-anchor"
      data-popover-placement={popoverPlacement}
      ref={wrapperRef}
      onMouseEnter={openPopover}
      onMouseLeave={() => setIsOpen(false)}
    >
      <a
        className="card-preview-trigger"
        href={previewQuery.data?.scryfallUrl ?? fallbackHref}
        target="_blank"
        rel="noreferrer"
        onFocus={openPopover}
        onBlur={(event) => {
          if (
            wrapperRef.current &&
            event.relatedTarget instanceof Node &&
            wrapperRef.current.contains(event.relatedTarget)
          ) {
            return;
          }
          setIsOpen(false);
        }}
        aria-label={`Open ${name} on Scryfall`}
      >
        <code>{name}</code>
      </a>

      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="card-preview-popover card-preview-popover-floating"
              style={{
                top: `${popoverStyle.top}px`,
                left: `${popoverStyle.left}px`,
              }}
              role="tooltip"
            >
              {previewQuery.isLoading ? (
                <p className="card-preview-status">Loading preview…</p>
              ) : previewQuery.data ? (
                <img
                  src={previewQuery.data.imageUrl}
                  alt={previewQuery.data.name}
                  loading="lazy"
                />
              ) : (
                <p className="card-preview-status">Preview unavailable.</p>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function replayTurnValue(turnNumber?: number): number {
  return typeof turnNumber === "number" && turnNumber > 0 ? turnNumber : -1;
}

function replayTurnLabel(turnNumber?: number): string {
  return typeof turnNumber === "number" && turnNumber > 0
    ? `Turn ${turnNumber}`
    : "Unknown turn";
}

function replayMomentLabel(play: MatchCardPlay): string {
  const phase = timelinePhaseLabel(play.phase);
  if (phase === "-") {
    return replayTurnLabel(play.turnNumber);
  }
  return `${replayTurnLabel(play.turnNumber)} - ${phase}`;
}

function replayFrameMomentLabel(frame: MatchReplayFrame): string {
  const phase = timelinePhaseLabel(frame.phase);
  if (phase === "-") {
    return replayTurnLabel(frame.turnNumber);
  }
  return `${replayTurnLabel(frame.turnNumber)} - ${phase}`;
}

function replayObjectSortValue(object: MatchReplayFrameObject): number {
  return typeof object.zonePosition === "number"
    ? object.zonePosition
    : Number.MAX_SAFE_INTEGER;
}

function sortReplayObjects(
  a: MatchReplayFrameObject,
  b: MatchReplayFrameObject,
): number {
  return (
    replayObjectSortValue(a) - replayObjectSortValue(b) ||
    a.instanceId - b.instanceId
  );
}

function replayChangePriority(action: string): number {
  switch (action) {
    case "leave_public":
      return 100;
    case "move_public":
      return 95;
    case "enter_public":
      return 90;
    case "controller_change":
      return 85;
    case "attack":
    case "stop_attack":
    case "block":
    case "stop_block":
      return 80;
    case "tap":
    case "untap":
      return 70;
    case "counters_change":
      return 65;
    case "stat_change":
      return 60;
    case "summoning_sickness_change":
      return 50;
    default:
      return 10;
  }
}

function replayObjectDetails(
  object: MatchReplayFrameObject,
): Record<string, unknown> | null {
  const raw = object.detailsJson?.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function replayObjectCardTypes(object: MatchReplayFrameObject): string[] {
  const details = replayObjectDetails(object);
  const raw = details?.["cardTypes"];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((value): value is string => typeof value === "string");
}

function replayObjectHasType(
  object: MatchReplayFrameObject,
  preview: CardPreview | null,
  type: string,
): boolean {
  const typeLine = preview?.typeLine?.toLowerCase() ?? "";
  if (typeLine.includes(type)) {
    return true;
  }

  const normalized = type.toLowerCase();
  return replayObjectCardTypes(object).some((value) =>
    value.toLowerCase().includes(normalized),
  );
}

function replayObjectIsAttacking(object: MatchReplayFrameObject): boolean {
  return Boolean(object.attackState?.trim());
}

function replayObjectIsBlocking(object: MatchReplayFrameObject): boolean {
  return Boolean(object.blockState?.trim());
}

function replayObjectPTLabel(
  object: MatchReplayFrameObject,
  preview: CardPreview | null,
): string | null {
  if (
    typeof object.power !== "number" ||
    typeof object.toughness !== "number" ||
    !replayObjectHasType(object, preview, "creature")
  ) {
    return null;
  }
  return `${object.power}/${object.toughness}`;
}

function replayObjectCounterSummaries(
  object: MatchReplayFrameObject,
): ReplayCounterSummary[] {
  const raw = object.counterSummaryJson?.trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const label =
          typeof (entry as { label?: unknown }).label === "string"
            ? (entry as { label: string }).label.trim()
            : "";
        const count =
          typeof (entry as { count?: unknown }).count === "number"
            ? (entry as { count: number }).count
            : Number.NaN;
        if (!label || !Number.isFinite(count) || count === 0) {
          return null;
        }
        return { label, count };
      })
      .filter((entry): entry is ReplayCounterSummary => entry !== null);
  } catch {
    return [];
  }
}

function replayObjectBlockCount(object: MatchReplayFrameObject): number {
  const raw = object.blockAttackerIdsJson?.trim();
  if (!raw) {
    return 0;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function replayObjectStatePills(
  object: MatchReplayFrameObject,
): ReplayCounterSummary[] {
  const pills: ReplayCounterSummary[] = [];

  if (object.isTapped) {
    pills.push({ label: "Tapped", count: 1 });
  }
  if (replayObjectIsAttacking(object)) {
    pills.push({ label: "Attacking", count: 1 });
  }
  if (replayObjectIsBlocking(object)) {
    const blockCount = replayObjectBlockCount(object);
    pills.push({
      label: blockCount > 1 ? `Blocking ${blockCount}` : "Blocking",
      count: 1,
    });
  }
  if (object.hasSummoningSickness) {
    pills.push({ label: "Summoning Sick", count: 1 });
  }
  if (
    typeof object.ownerSeatId === "number" &&
    typeof object.controllerSeatId === "number" &&
    object.ownerSeatId !== object.controllerSeatId
  ) {
    pills.push({ label: "Stolen", count: 1 });
  }

  return pills;
}

function replayObjectStatusText(
  object: MatchReplayFrameObject,
  preview: CardPreview | null,
): string {
  const parts = [
    timelinePlayerLabel(object.playerSide),
    timelineZoneLabel(object.zoneType),
  ];
  const ptLabel = replayObjectPTLabel(object, preview);
  if (ptLabel) {
    parts.push(ptLabel);
  }
  if (object.isTapped) {
    parts.push("Tapped");
  }
  if (replayObjectIsAttacking(object)) {
    parts.push("Attacking");
  }
  if (replayObjectIsBlocking(object)) {
    parts.push("Blocking");
  }
  if (object.hasSummoningSickness) {
    parts.push("Summoning sick");
  }
  for (const counter of replayObjectCounterSummaries(object)) {
    parts.push(`${counter.label} x${counter.count}`);
  }
  return parts.join(" • ");
}

function replayFrameLifeTotalForSide(
  frame: MatchReplayFrame | null | undefined,
  side: "self" | "opponent",
): number | undefined {
  if (!frame) {
    return undefined;
  }
  return side === "self" ? frame.selfLifeTotal : frame.opponentLifeTotal;
}

function replayFrameLifeTotalsSummary(
  frame: MatchReplayFrame | null | undefined,
): string | null {
  const selfLifeTotal = replayFrameLifeTotalForSide(frame, "self");
  const opponentLifeTotal = replayFrameLifeTotalForSide(frame, "opponent");
  if (
    typeof selfLifeTotal !== "number" &&
    typeof opponentLifeTotal !== "number"
  ) {
    return null;
  }

  const parts: string[] = [];
  if (typeof selfLifeTotal === "number") {
    parts.push(`You ${selfLifeTotal}`);
  }
  if (typeof opponentLifeTotal === "number") {
    parts.push(`Opponent ${opponentLifeTotal}`);
  }
  return parts.join(" • ");
}

function replayFrameHasLifeDelta(
  previousFrame: MatchReplayFrame | null,
  frame: MatchReplayFrame,
): boolean {
  if (!previousFrame) {
    return false;
  }
  return (
    replayFrameLifeTotalForSide(previousFrame, "self") !==
      replayFrameLifeTotalForSide(frame, "self") ||
    replayFrameLifeTotalForSide(previousFrame, "opponent") !==
      replayFrameLifeTotalForSide(frame, "opponent")
  );
}

function isMeaningfulReplayFrame(
  frame: MatchReplayFrame,
  previousFrame: MatchReplayFrame | null,
): boolean {
  return (
    (frame.changes?.length ?? 0) > 0 || replayFrameHasLifeDelta(previousFrame, frame)
  );
}

function filterMeaningfulReplayFrames(
  frames: MatchReplayFrame[],
): MatchReplayFrame[] {
  if (frames.length <= 1) {
    return frames;
  }

  const meaningfulFrames: MatchReplayFrame[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const previousFrame = index > 0 ? frames[index - 1] ?? null : null;
    if (isMeaningfulReplayFrame(frame, previousFrame)) {
      meaningfulFrames.push(frame);
    }
  }

  if (meaningfulFrames.length > 0) {
    return meaningfulFrames;
  }

  const lastFrame = frames[frames.length - 1];
  return lastFrame ? [lastFrame] : [];
}

function summarizeReplayFrameZones(
  objects: MatchReplayFrameObject[],
): Map<BoardZoneKind, number> {
  const counts = new Map<BoardZoneKind, number>();
  for (const kind of BOARD_ZONE_ORDER) {
    counts.set(kind, 0);
  }

  for (const object of objects) {
    const kind = boardZoneKind(object.zoneType);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return counts;
}

function replayFramePrimaryChange(
  frame: MatchReplayFrame | null,
): MatchReplayChange | null {
  const changes = frame?.changes ?? [];
  if (changes.length === 0) {
    return null;
  }
  return [...changes].sort(
    (a, b) =>
      replayChangePriority(b.action) - replayChangePriority(a.action),
  )[0] ?? null;
}

function replayFramePrimarySummary(
  frame: MatchReplayFrame | null,
  previousFrame: MatchReplayFrame | null,
): string {
  const primaryChange = replayFramePrimaryChange(frame);
  if (primaryChange) {
    return describeReplayChange(primaryChange);
  }
  if (frame && replayFrameHasLifeDelta(previousFrame, frame)) {
    const summary = replayFrameLifeTotalsSummary(frame);
    return summary ? `Life totals changed. ${summary}.` : "Life totals changed.";
  }
  return "Initial public replay snapshot for this game state.";
}

function describeReplayChange(change: MatchReplayChange): string {
  const actor = timelinePlayerLabel(change.playerSide);
  const name = cardDisplayName({
    cardId: change.cardId,
    cardName: change.cardName,
  });

  if (change.action === "enter_public") {
    return `${actor} showed ${name} in ${timelineZoneLabel(change.toZoneType ?? "")}.`;
  }
  if (change.action === "move_public") {
    return `${actor} moved ${name} from ${timelineZoneLabel(change.fromZoneType ?? "")} to ${timelineZoneLabel(change.toZoneType ?? "")}.`;
  }
  if (change.action === "leave_public") {
    return `${actor} lost public visibility of ${name} from ${timelineZoneLabel(change.fromZoneType ?? "")}.`;
  }
  if (change.action === "controller_change") {
    return `${actor} took control of ${name}.`;
  }
  if (change.action === "tap") {
    return `${actor} tapped ${name}.`;
  }
  if (change.action === "untap") {
    return `${actor} untapped ${name}.`;
  }
  if (change.action === "attack") {
    return `${actor} attacked with ${name}.`;
  }
  if (change.action === "stop_attack") {
    return `${name} stopped attacking.`;
  }
  if (change.action === "block") {
    return `${actor} declared ${name} as a blocker.`;
  }
  if (change.action === "stop_block") {
    return `${name} stopped blocking.`;
  }
  if (change.action === "summoning_sickness_change") {
    return `${name}'s summoning-sickness state changed.`;
  }
  if (change.action === "stat_change") {
    return `${name}'s power and toughness changed.`;
  }
  if (change.action === "counters_change") {
    return `${name}'s counters changed.`;
  }
  return `${actor} changed ${name}.`;
}

function previewIsPermanent(preview: CardPreview | null): boolean {
  const typeLine = preview?.typeLine?.toLowerCase() ?? "";
  if (!typeLine) {
    return false;
  }

  return (
    typeLine.includes("artifact") ||
    typeLine.includes("battle") ||
    typeLine.includes("creature") ||
    typeLine.includes("enchantment") ||
    typeLine.includes("land") ||
    typeLine.includes("planeswalker")
  );
}

function shouldRenderOnBattlefield(
  play: MatchCardPlay,
  preview: CardPreview | null,
  activePlayID: number,
): boolean {
  const zone = boardZoneKind(play.firstPublicZone);
  if (zone === "battlefield") {
    return true;
  }

  // Reconstruct likely permanent resolution: if a permanent first appeared on
  // the stack and it is no longer the current action, show it on the board.
  if (
    zone === "stack" &&
    play.id !== activePlayID &&
    previewIsPermanent(preview)
  ) {
    return true;
  }

  return false;
}

function battlefieldSectionKind(
  preview: CardPreview | null,
  object?: MatchReplayFrameObject,
): BattlefieldSectionKind {
  const typeLine = preview?.typeLine?.toLowerCase() ?? "";
  const fallbackTypes = object
    ? replayObjectCardTypes(object).map((value) => value.toLowerCase())
    : [];
  const hasType = (type: string) =>
    typeLine.includes(type) ||
    fallbackTypes.some((value) => value.includes(type));

  if (!typeLine && fallbackTypes.length === 0) {
    return "other";
  }
  if (hasType("land")) {
    return "lands";
  }
  if (hasType("creature")) {
    return "creatures";
  }
  if (hasType("planeswalker")) {
    return "planeswalkers";
  }
  if (hasType("battle")) {
    return "battles";
  }
  if (hasType("artifact") || hasType("enchantment")) {
    return "artifacts_enchantments";
  }
  return "other";
}

function battlefieldSectionLabel(kind: BattlefieldSectionKind): string {
  switch (kind) {
    case "lands":
      return "Lands";
    case "creatures":
      return "Creatures";
    case "artifacts_enchantments":
      return "Artifacts + Enchantments";
    case "planeswalkers":
      return "Planeswalkers";
    case "battles":
      return "Battles";
    default:
      return "Other Permanents";
  }
}

function battlefieldSectionOrder(
  side: "self" | "opponent",
): BattlefieldSectionKind[] {
  return side === "self"
    ? SELF_BATTLEFIELD_SECTION_ORDER
    : BATTLEFIELD_SECTION_ORDER;
}

function summarizeReplayZones(
  plays: MatchCardPlay[],
): Map<BoardZoneKind, number> {
  const counts = new Map<BoardZoneKind, number>();
  for (const kind of BOARD_ZONE_ORDER) {
    counts.set(kind, 0);
  }

  for (const play of plays) {
    const kind = boardZoneKind(play.firstPublicZone);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return counts;
}

function MatchReplayCard({
  play,
  preview,
  active = false,
  size = "board",
}: {
  play: MatchCardPlay;
  preview: CardPreview | null;
  active?: boolean;
  size?: "board" | "stack";
}) {
  const card = { cardId: play.cardId, cardName: play.cardName };
  const name = preview?.name ?? cardDisplayName(card);
  const href = preview?.scryfallUrl ?? cardFallbackHref(card);

  return (
    <a
      className={`match-replay-card is-${size} ${active ? "is-active" : ""}`}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${name} on Scryfall`}
      title={`${name} • ${timelinePlayerLabel(play.playerSide)} • ${timelineZoneLabel(play.firstPublicZone)} • ${
        play.playedAt ? formatDateTime(play.playedAt) : "Unknown time"
      }`}
    >
      {preview ? (
        <img
          src={preview.imageUrl}
          alt=""
          loading={size === "stack" ? "eager" : "lazy"}
          decoding="async"
          width={244}
          height={340}
        />
      ) : (
        <div className="match-replay-card-fallback">
          <strong>{name}</strong>
          <span>{timelineZoneLabel(play.firstPublicZone)}</span>
          <span>{boardPlayMeta(play)}</span>
        </div>
      )}
      <span className="match-replay-card-chip">
        {boardTurnLabel(play.turnNumber)}
      </span>
    </a>
  );
}

function MatchReplayObjectCard({
  object,
  preview,
  active = false,
  size = "board",
  chipLabel,
}: {
  object: MatchReplayFrameObject;
  preview: CardPreview | null;
  active?: boolean;
  size?: "board" | "stack";
  chipLabel?: string;
}) {
  const card = { cardId: object.cardId, cardName: object.cardName };
  const name = preview?.name ?? cardDisplayName(card);
  const href = preview?.scryfallUrl ?? cardFallbackHref(card);
  const statusText = replayObjectStatusText(object, preview);
  const ptLabel = replayObjectPTLabel(object, preview);
  const statePills = replayObjectStatePills(object);
  const counterPills = replayObjectCounterSummaries(object);
  const isTappedBoardCard =
    size === "board" &&
    boardZoneKind(object.zoneType) === "battlefield" &&
    object.isTapped;

  const cardNode = (
    <a
      className={`match-replay-card is-${size} ${active ? "is-active" : ""} ${isTappedBoardCard ? "is-tapped" : ""}`}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${name} on Scryfall`}
      title={`${name} • ${statusText}`}
    >
      {preview ? (
        <img
          src={preview.imageUrl}
          alt=""
          loading={size === "stack" ? "eager" : "lazy"}
          decoding="async"
          width={244}
          height={340}
        />
      ) : (
        <div className="match-replay-card-fallback">
          <strong>{name}</strong>
          <span>{timelineZoneLabel(object.zoneType)}</span>
          <span>{timelinePlayerLabel(object.playerSide)}</span>
        </div>
      )}
      {chipLabel ? (
        <span className="match-replay-card-chip">{chipLabel}</span>
      ) : null}
      {ptLabel ? <span className="match-replay-card-power">{ptLabel}</span> : null}
    </a>
  );

  if (size === "stack") {
    return cardNode;
  }

  return (
    <div className={`match-replay-object ${isTappedBoardCard ? "is-tapped" : ""}`}>
      <div className="match-replay-card-shell">{cardNode}</div>
      {statePills.length > 0 || counterPills.length > 0 ? (
        <div className="match-replay-card-statusrow">
          {statePills.map((pill) => (
            <span
              className="match-replay-state-pill"
              key={`${object.instanceId}-${pill.label}`}
            >
              {pill.label}
            </span>
          ))}
          {counterPills.map((counter) => (
            <span
              className="match-replay-state-pill is-counter"
              key={`${object.instanceId}-${counter.label}`}
            >
              {counter.count > 1 ? `${counter.label} x${counter.count}` : counter.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MatchReplayFrameSideSummary({
  side,
  objects,
  lifeTotal,
}: {
  side: "self" | "opponent";
  objects: MatchReplayFrameObject[];
  lifeTotal?: number;
}) {
  const sideObjects = useMemo(
    () => objects.filter((object) => object.playerSide === side),
    [objects, side],
  );
  const zoneCounts = useMemo(
    () => summarizeReplayFrameZones(sideObjects),
    [sideObjects],
  );
  const battlefieldObjects = useMemo(
    () =>
      sideObjects.filter(
        (object) => boardZoneKind(object.zoneType) === "battlefield",
      ),
    [sideObjects],
  );
  const tappedCount = battlefieldObjects.filter((object) => object.isTapped).length;
  const attackingCount = battlefieldObjects.filter(replayObjectIsAttacking).length;
  const blockingCount = battlefieldObjects.filter(replayObjectIsBlocking).length;
  const stats: BoardZoneKind[] = [
    "battlefield",
    "graveyard",
    "exile",
    "revealed",
  ];

  return (
    <section
      className={`match-replay-sidebox is-${side}`}
      aria-label={`${timelinePlayerLabel(side)} public summary`}
    >
      <div className="match-replay-sidebox-head">
        <div>
          <p className="match-replay-sidebox-label">
            {timelinePlayerLabel(side)}
          </p>
          <p className="match-replay-sidebox-total">
            {sideObjects.length} public card{sideObjects.length === 1 ? "" : "s"}
          </p>
          {typeof lifeTotal === "number" ? (
            <p className="match-replay-sidebox-life">Life {lifeTotal}</p>
          ) : null}
          <p className="match-replay-sidebox-status">
            {battlefieldObjects.length} on board
            {tappedCount > 0 ? ` • ${tappedCount} tapped` : ""}
            {attackingCount > 0 ? ` • ${attackingCount} attacking` : ""}
            {blockingCount > 0 ? ` • ${blockingCount} blocking` : ""}
          </p>
        </div>
      </div>
      <dl className="match-replay-stats">
        {stats.map((kind) => (
          <div className="match-replay-stat" key={kind}>
            <dt>{boardZoneLabel(kind)}</dt>
            <dd>{zoneCounts.get(kind) ?? 0}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function MatchReplayFrameBattlefield({
  side,
  objects,
  previewByCardID,
  highlightedInstanceIDs,
}: {
  side: "self" | "opponent";
  objects: MatchReplayFrameObject[];
  previewByCardID: Map<number, CardPreview | null>;
  highlightedInstanceIDs: Set<number>;
}) {
  const sideObjects = useMemo(
    () => objects.filter((object) => object.playerSide === side),
    [objects, side],
  );
  const battlefieldObjects = useMemo(
    () =>
      sideObjects
        .filter((object) => boardZoneKind(object.zoneType) === "battlefield")
        .sort(sortReplayObjects),
    [sideObjects],
  );
  const battlefieldSections = useMemo(() => {
    const sectionOrder = battlefieldSectionOrder(side);
    const grouped = new Map<BattlefieldSectionKind, MatchReplayFrameObject[]>();
    for (const kind of sectionOrder) {
      grouped.set(kind, []);
    }

    for (const object of battlefieldObjects) {
      const preview = previewByCardID.get(object.cardId) ?? null;
      grouped.get(battlefieldSectionKind(preview, object))?.push(object);
    }

    return sectionOrder.map((kind) => ({
      kind,
      label: battlefieldSectionLabel(kind),
      objects: grouped.get(kind) ?? [],
    })).filter((section) => section.objects.length > 0);
  }, [battlefieldObjects, previewByCardID, side]);
  const zoneCounts = useMemo(
    () => summarizeReplayFrameZones(sideObjects),
    [sideObjects],
  );
  const tappedCount = battlefieldObjects.filter((object) => object.isTapped).length;
  const attackingCount = battlefieldObjects.filter(replayObjectIsAttacking).length;
  const blockingCount = battlefieldObjects.filter(replayObjectIsBlocking).length;
  const sideBadges = (
    ["graveyard", "exile", "revealed"] as BoardZoneKind[]
  ).filter((kind) => (zoneCounts.get(kind) ?? 0) > 0);

  return (
    <section
      className={`match-replay-lane is-${side}`}
      aria-label={`${timelinePlayerLabel(side)} battlefield`}
    >
      <div className="match-replay-lane-head">
        <div>
          <p className="match-replay-lane-title">
            {timelinePlayerLabel(side)} Battlefield
          </p>
          <p className="match-replay-lane-subtitle">
            {battlefieldObjects.length} current on board
            {tappedCount > 0 ? ` • ${tappedCount} tapped` : ""}
            {attackingCount > 0 ? ` • ${attackingCount} attacking` : ""}
            {blockingCount > 0 ? ` • ${blockingCount} blocking` : ""}
            {sideBadges.length > 0
              ? ` • ${sideBadges.map((kind) => `${zoneCounts.get(kind)} ${boardZoneLabel(kind).toLowerCase()}`).join(" • ")}`
              : ""}
          </p>
        </div>
      </div>
      {battlefieldObjects.length === 0 ? (
        <p className="match-replay-empty">
          No battlefield cards in this frame.
        </p>
      ) : (
        <div className="match-replay-zone-groups">
          {battlefieldSections.map((section) => (
            <section
              key={section.kind}
              className="match-replay-zone-group"
              aria-label={`${timelinePlayerLabel(side)} ${section.label.toLowerCase()}`}
            >
              <div className="match-replay-zone-group-head">
                <p className="match-replay-zone-group-title">{section.label}</p>
                <p className="match-replay-zone-group-count">
                  {section.objects.length}
                </p>
              </div>
              <div className="match-replay-card-row is-sectioned">
                {section.objects.map((object) => (
                  <MatchReplayObjectCard
                    key={object.instanceId}
                    object={object}
                    preview={previewByCardID.get(object.cardId) ?? null}
                    active={highlightedInstanceIDs.has(object.instanceId)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function MatchReplayStack({
  frame,
  frameSummary,
  previewByCardID,
  highlightedInstanceIDs,
}: {
  frame: MatchReplayFrame;
  frameSummary: string;
  previewByCardID: Map<number, CardPreview | null>;
  highlightedInstanceIDs: Set<number>;
}) {
  const stackObjects = useMemo(
    () =>
      [...(frame.objects ?? [])]
        .filter((object) => boardZoneKind(object.zoneType) === "stack")
        .sort(sortReplayObjects),
    [frame],
  );
  const topObject = stackObjects[stackObjects.length - 1] ?? null;
  const topName = topObject
    ? cardDisplayName({
        cardId: topObject.cardId,
        cardName: topObject.cardName,
      })
    : null;

  return (
    <section className="match-replay-stackbox" aria-label="Current stack">
      <div className="match-replay-stackbox-head">
        <div>
          <p className="match-replay-sidebox-label">Stack</p>
          <p className="match-replay-sidebox-total">
            {stackObjects.length === 0
              ? "Empty"
              : `${stackObjects.length} public card${stackObjects.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <p className="match-replay-stackbox-player">
          {topObject ? `${timelinePlayerLabel(topObject.playerSide)} on top` : "No active stack"}
        </p>
      </div>
      <div
        className={`match-replay-stackbox-body ${stackObjects.length > 1 ? "is-live-stack" : ""}`}
      >
        <div
          className="match-replay-stack-cards"
          aria-label="Current stack ordered bottom to top"
        >
          {stackObjects.length === 0 ? (
            <p className="match-replay-empty">
              No public cards on the stack in this frame.
            </p>
          ) : (
            stackObjects.map((object, index) => (
              <div className="match-replay-stack-slot" key={object.instanceId}>
                <MatchReplayObjectCard
                  object={object}
                  preview={previewByCardID.get(object.cardId) ?? null}
                  active={
                    highlightedInstanceIDs.has(object.instanceId) ||
                    index === stackObjects.length - 1
                  }
                  size="stack"
                  chipLabel={
                    index === stackObjects.length - 1
                      ? "Top"
                      : `${index + 1}`
                  }
                />
                <p className="match-replay-stack-slot-copy">
                  {timelinePlayerLabel(object.playerSide)}
                </p>
              </div>
            ))
          )}
        </div>
        <div className="match-replay-stackbox-copy">
          <p className="match-replay-stackbox-player">
            {topObject
              ? timelinePlayerLabel(topObject.playerSide)
              : "Replay step"}
          </p>
          <h5>{topName ?? "Stack empty"}</h5>
          <p>{replayFrameMomentLabel(frame)}</p>
          <p>
            {topObject
              ? `Top of stack is ${topName}.`
              : "No public stack objects are visible in this frame."}
          </p>
          <p>{frameSummary}</p>
          {frame.recordedAt ? <p>{formatDateTime(frame.recordedAt)}</p> : null}
        </div>
      </div>
    </section>
  );
}

function MatchReplayFrameTrack({
  frames,
  selectedFrameIndex,
  onSelectFrame,
}: {
  frames: MatchReplayFrame[];
  selectedFrameIndex: number;
  onSelectFrame: (index: number) => void;
}) {
  return (
    <div className="match-replay-track-scroll">
      <div
        className="match-replay-track"
        style={{
          gridTemplateColumns: `repeat(${frames.length}, minmax(3rem, 1fr))`,
        }}
      >
        {frames.map((frame, index) => {
          const isCurrent = index === selectedFrameIndex;
          const isTurnStart =
            index === 0 ||
            replayTurnValue(frames[index - 1].turnNumber) !==
              replayTurnValue(frame.turnNumber);
          const turnText = isTurnStart
            ? boardTurnLabel(frame.turnNumber)
            : "\u00a0";
          const frameSummary = replayFramePrimarySummary(
            frame,
            index > 0 ? frames[index - 1] ?? null : null,
          );

          return (
            <button
              key={frame.id}
              type="button"
              className={`match-replay-step ${isCurrent ? "is-current" : ""} ${isTurnStart ? "is-turn-start" : ""}`}
              aria-pressed={isCurrent}
              aria-label={`Step ${index + 1}: ${replayFrameMomentLabel(frame)}. ${frameSummary}`}
              onClick={() => onSelectFrame(index)}
            >
              <span className="match-replay-step-turn">{turnText}</span>
              <span className="match-replay-step-bar" />
              <span className="match-replay-step-index">{index + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MatchReplayFrameBoard({
  gameNumber,
  frames,
  previewByCardID,
}: {
  gameNumber: number;
  frames: MatchReplayFrame[];
  previewByCardID: Map<number, CardPreview | null>;
}) {
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(
    frames.length > 0 ? frames.length - 1 : 0,
  );
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (frames.length === 0) {
      setSelectedFrameIndex(0);
      setIsPlaying(false);
      return;
    }

    setSelectedFrameIndex((currentIndex) =>
      Math.min(currentIndex, frames.length - 1),
    );
  }, [frames]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    if (selectedFrameIndex >= frames.length - 1) {
      setIsPlaying(false);
      return;
    }

    const timeoutID = window.setTimeout(() => {
      setSelectedFrameIndex((currentIndex) =>
        Math.min(currentIndex + 1, frames.length - 1),
      );
    }, 1200);

    return () => window.clearTimeout(timeoutID);
  }, [frames.length, isPlaying, selectedFrameIndex]);

  const currentFrame = frames[selectedFrameIndex] ?? null;
  const previousFrame =
    selectedFrameIndex > 0 ? frames[selectedFrameIndex - 1] ?? null : null;
  const turnBoundaries = useMemo(() => {
    const firstByTurn = new Map<number, number>();
    const lastByTurn = new Map<number, number>();

    for (let index = 0; index < frames.length; index += 1) {
      const turnKey = replayTurnValue(frames[index].turnNumber);
      if (!firstByTurn.has(turnKey)) {
        firstByTurn.set(turnKey, index);
      }
      lastByTurn.set(turnKey, index);
    }

    return Array.from(firstByTurn.entries())
      .map(([turnKey, firstIndex]) => ({
        turnKey,
        firstIndex,
        lastIndex: lastByTurn.get(turnKey) ?? firstIndex,
      }))
      .sort((a, b) => a.firstIndex - b.firstIndex);
  }, [frames]);

  const currentTurnBoundaryIndex = currentFrame
    ? turnBoundaries.findIndex(
        (boundary) =>
          boundary.turnKey === replayTurnValue(currentFrame.turnNumber),
      )
    : -1;

  if (!currentFrame) {
    return (
      <article className="panel inner match-replay-game">
        <h4>Game {gameNumber}</h4>
        <StatusMessage>No replay steps for this game.</StatusMessage>
      </article>
    );
  }

  const currentObjects = currentFrame.objects ?? [];
  const changedInstanceIDs = new Set(
    (currentFrame.changes ?? []).map((change) => change.instanceId),
  );
  const unknownObjectsCount = currentObjects.filter(
    (object) => object.playerSide === "unknown",
  ).length;
  const stackCount = currentObjects.filter(
    (object) => boardZoneKind(object.zoneType) === "stack",
  ).length;
  const primarySummary = replayFramePrimarySummary(currentFrame, previousFrame);
  const notableChanges = [...(currentFrame.changes ?? [])]
    .sort(
      (a, b) =>
        replayChangePriority(b.action) - replayChangePriority(a.action),
    )
    .slice(0, 4);
  const canStepBackward = selectedFrameIndex > 0;
  const canStepForward = selectedFrameIndex < frames.length - 1;
  const canJumpPrevTurn = currentTurnBoundaryIndex > 0;
  const canJumpNextTurn =
    currentTurnBoundaryIndex >= 0 &&
    currentTurnBoundaryIndex < turnBoundaries.length - 1;

  return (
    <article className="panel inner match-replay-game">
      <div className="match-replay-head">
        <div className="match-replay-head-copy">
          <h4>Game {gameNumber}</h4>
          <p className="match-replay-caption">
            {replayFrameMomentLabel(currentFrame)} • Step{" "}
            {selectedFrameIndex + 1} of {frames.length}
          </p>
        </div>
        <p className="match-replay-kicker">Public replay</p>
      </div>

      <div className="match-replay-controls">
        <div
          className="match-replay-button-row"
          role="group"
          aria-label={`Game ${gameNumber} replay controls`}
        >
          <button
            type="button"
            className="match-replay-button"
            onClick={() => setIsPlaying((currentValue) => !currentValue)}
            aria-pressed={isPlaying}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className="match-replay-button"
            onClick={() => {
              setIsPlaying(false);
              setSelectedFrameIndex(
                turnBoundaries[currentTurnBoundaryIndex - 1]?.firstIndex ?? 0,
              );
            }}
            disabled={!canJumpPrevTurn}
          >
            Previous Turn
          </button>
          <button
            type="button"
            className="match-replay-button"
            onClick={() => {
              setIsPlaying(false);
              setSelectedFrameIndex((currentIndex) =>
                Math.max(currentIndex - 1, 0),
              );
            }}
            disabled={!canStepBackward}
          >
            Previous Step
          </button>
          <button
            type="button"
            className="match-replay-button"
            onClick={() => {
              setIsPlaying(false);
              setSelectedFrameIndex((currentIndex) =>
                Math.min(currentIndex + 1, frames.length - 1),
              );
            }}
            disabled={!canStepForward}
          >
            Next Step
          </button>
          <button
            type="button"
            className="match-replay-button"
            onClick={() => {
              setIsPlaying(false);
              setSelectedFrameIndex(
                turnBoundaries[currentTurnBoundaryIndex + 1]?.firstIndex ??
                  frames.length - 1,
              );
            }}
            disabled={!canJumpNextTurn}
          >
            Next Turn
          </button>
        </div>

        <div className="match-replay-track-panel">
          <MatchReplayFrameTrack
            frames={frames}
            selectedFrameIndex={selectedFrameIndex}
            onSelectFrame={setSelectedFrameIndex}
          />
        </div>
      </div>

      <div className="match-replay-canvas">
        <aside className="match-replay-sidebar">
          <MatchReplayFrameSideSummary
            side="opponent"
            objects={currentObjects}
            lifeTotal={currentFrame.opponentLifeTotal}
          />

          <MatchReplayStack
            frame={currentFrame}
            frameSummary={primarySummary}
            previewByCardID={previewByCardID}
            highlightedInstanceIDs={changedInstanceIDs}
          />

          <MatchReplayFrameSideSummary
            side="self"
            objects={currentObjects}
            lifeTotal={currentFrame.selfLifeTotal}
          />
        </aside>

        <div className="match-replay-board">
          <MatchReplayFrameBattlefield
            side="opponent"
            objects={currentObjects}
            previewByCardID={previewByCardID}
            highlightedInstanceIDs={changedInstanceIDs}
          />

          <section
            className="match-replay-centerline"
            aria-label="Replay status"
          >
            <p className="match-replay-centerline-title">
              {replayFrameMomentLabel(currentFrame)}
            </p>
            <p className="match-replay-centerline-copy">{primarySummary}</p>
            <p className="match-replay-centerline-copy">
              {currentObjects.length} public object
              {currentObjects.length === 1 ? "" : "s"} visible
              {stackCount > 0
                ? ` • ${stackCount} currently on the stack`
                : " • stack empty"}
              {replayFrameLifeTotalsSummary(currentFrame)
                ? ` • ${replayFrameLifeTotalsSummary(currentFrame)}`
                : ""}
              {unknownObjectsCount > 0
                ? ` • ${unknownObjectsCount} with unknown owner`
                : ""}
              .
            </p>
            {notableChanges.length > 0 ? (
              <div className="match-replay-change-list" aria-label="Frame changes">
                {notableChanges.map((change, index) => (
                  <span
                    className="match-replay-change-pill"
                    key={`${change.instanceId}-${change.action}-${index}`}
                  >
                    {describeReplayChange(change)}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          <MatchReplayFrameBattlefield
            side="self"
            objects={currentObjects}
            previewByCardID={previewByCardID}
            highlightedInstanceIDs={changedInstanceIDs}
          />
        </div>
      </div>
    </article>
  );
}

function MatchReplaySideSummary({
  side,
  plays,
}: {
  side: "self" | "opponent";
  plays: MatchCardPlay[];
}) {
  const zoneCounts = useMemo(() => summarizeReplayZones(plays), [plays]);
  const stats: BoardZoneKind[] = [
    "battlefield",
    "graveyard",
    "exile",
    "revealed",
  ];

  return (
    <section
      className={`match-replay-sidebox is-${side}`}
      aria-label={`${timelinePlayerLabel(side)} observed summary`}
    >
      <div className="match-replay-sidebox-head">
        <div>
          <p className="match-replay-sidebox-label">
            {timelinePlayerLabel(side)}
          </p>
          <p className="match-replay-sidebox-total">
            {plays.length} observed card{plays.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      <dl className="match-replay-stats">
        {stats.map((kind) => (
          <div className="match-replay-stat" key={kind}>
            <dt>{boardZoneLabel(kind)}</dt>
            <dd>{zoneCounts.get(kind) ?? 0}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function MatchReplayBattlefield({
  side,
  plays,
  activePlayID,
  previewByCardID,
}: {
  side: "self" | "opponent";
  plays: MatchCardPlay[];
  activePlayID: number;
  previewByCardID: Map<number, CardPreview | null>;
}) {
  const battlefieldPlays = useMemo(
    () =>
      plays.filter((play) =>
        shouldRenderOnBattlefield(
          play,
          previewByCardID.get(play.cardId) ?? null,
          activePlayID,
        ),
      ),
    [activePlayID, plays, previewByCardID],
  );
  const battlefieldSections = useMemo(() => {
    const sectionOrder = battlefieldSectionOrder(side);
    const grouped = new Map<BattlefieldSectionKind, MatchCardPlay[]>();
    for (const kind of sectionOrder) {
      grouped.set(kind, []);
    }

    for (const play of battlefieldPlays) {
      const preview = previewByCardID.get(play.cardId) ?? null;
      grouped.get(battlefieldSectionKind(preview))?.push(play);
    }

    return sectionOrder.map((kind) => ({
      kind,
      label: battlefieldSectionLabel(kind),
      plays: grouped.get(kind) ?? [],
    })).filter((section) => section.plays.length > 0);
  }, [battlefieldPlays, previewByCardID, side]);
  const zoneCounts = useMemo(() => summarizeReplayZones(plays), [plays]);
  const sideBadges = (
    ["graveyard", "exile", "revealed"] as BoardZoneKind[]
  ).filter((kind) => (zoneCounts.get(kind) ?? 0) > 0);

  return (
    <section
      className={`match-replay-lane is-${side}`}
      aria-label={`${timelinePlayerLabel(side)} battlefield`}
    >
      <div className="match-replay-lane-head">
        <div>
          <p className="match-replay-lane-title">
            {timelinePlayerLabel(side)} Battlefield
          </p>
          <p className="match-replay-lane-subtitle">
            {battlefieldPlays.length} observed on board
            {sideBadges.length > 0
              ? ` • ${sideBadges.map((kind) => `${zoneCounts.get(kind)} ${boardZoneLabel(kind).toLowerCase()}`).join(" • ")}`
              : ""}
          </p>
        </div>
      </div>
      {battlefieldPlays.length === 0 ? (
        <p className="match-replay-empty">No battlefield cards observed yet.</p>
      ) : (
        <div className="match-replay-zone-groups">
          {battlefieldSections.map((section) => (
            <section
              key={section.kind}
              className="match-replay-zone-group"
              aria-label={`${timelinePlayerLabel(side)} ${section.label.toLowerCase()}`}
            >
              <div className="match-replay-zone-group-head">
                <p className="match-replay-zone-group-title">{section.label}</p>
                <p className="match-replay-zone-group-count">
                  {section.plays.length}
                </p>
              </div>
              <div className="match-replay-card-row is-sectioned">
                {section.plays.map((play) => (
                  <MatchReplayCard
                    key={play.id}
                    play={play}
                    preview={previewByCardID.get(play.cardId) ?? null}
                    active={play.id === activePlayID}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function MatchReplayTrack({
  plays,
  selectedActionIndex,
  onSelectAction,
}: {
  plays: MatchCardPlay[];
  selectedActionIndex: number;
  onSelectAction: (index: number) => void;
}) {
  return (
    <div className="match-replay-track-scroll">
      <div
        className="match-replay-track"
        style={{
          gridTemplateColumns: `repeat(${plays.length}, minmax(3rem, 1fr))`,
        }}
      >
        {plays.map((play, index) => {
          const isCurrent = index === selectedActionIndex;
          const isTurnStart =
            index === 0 ||
            replayTurnValue(plays[index - 1].turnNumber) !==
              replayTurnValue(play.turnNumber);
          const turnText = isTurnStart
            ? boardTurnLabel(play.turnNumber)
            : "\u00a0";

          return (
            <button
              key={play.id}
              type="button"
              className={`match-replay-step ${isCurrent ? "is-current" : ""} ${isTurnStart ? "is-turn-start" : ""}`}
              aria-pressed={isCurrent}
              aria-label={`Action ${index + 1}: ${cardDisplayName({ cardId: play.cardId, cardName: play.cardName })}, ${timelinePlayerLabel(
                play.playerSide,
              )}, ${replayMomentLabel(play)}`}
              onClick={() => onSelectAction(index)}
            >
              <span className="match-replay-step-turn">{turnText}</span>
              <span className="match-replay-step-bar" />
              <span className="match-replay-step-index">{index + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MatchTimelineBoard({
  gameNumber,
  plays,
  previewByCardID,
}: {
  gameNumber: number;
  plays: MatchCardPlay[];
  previewByCardID: Map<number, CardPreview | null>;
}) {
  const [selectedActionIndex, setSelectedActionIndex] = useState(
    plays.length > 0 ? plays.length - 1 : 0,
  );
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (plays.length === 0) {
      setSelectedActionIndex(0);
      setIsPlaying(false);
      return;
    }

    setSelectedActionIndex((currentIndex) =>
      Math.min(currentIndex, plays.length - 1),
    );
  }, [plays]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    if (selectedActionIndex >= plays.length - 1) {
      setIsPlaying(false);
      return;
    }

    const timeoutID = window.setTimeout(() => {
      setSelectedActionIndex((currentIndex) =>
        Math.min(currentIndex + 1, plays.length - 1),
      );
    }, 1200);

    return () => window.clearTimeout(timeoutID);
  }, [isPlaying, plays.length, selectedActionIndex]);

  const currentAction = plays[selectedActionIndex] ?? null;
  const visiblePlays = useMemo(
    () => plays.slice(0, selectedActionIndex + 1),
    [plays, selectedActionIndex],
  );
  const opponentVisiblePlays = visiblePlays.filter(
    (play) => play.playerSide === "opponent",
  );
  const selfVisiblePlays = visiblePlays.filter(
    (play) => play.playerSide === "self",
  );
  const unknownVisiblePlays = visiblePlays.filter(
    (play) => play.playerSide === "unknown",
  );
  const turnBoundaries = useMemo(() => {
    const firstByTurn = new Map<number, number>();
    const lastByTurn = new Map<number, number>();

    for (let index = 0; index < plays.length; index += 1) {
      const turnKey = replayTurnValue(plays[index].turnNumber);
      if (!firstByTurn.has(turnKey)) {
        firstByTurn.set(turnKey, index);
      }
      lastByTurn.set(turnKey, index);
    }

    return Array.from(firstByTurn.entries())
      .map(([turnKey, firstIndex]) => ({
        turnKey,
        firstIndex,
        lastIndex: lastByTurn.get(turnKey) ?? firstIndex,
      }))
      .sort((a, b) => a.firstIndex - b.firstIndex);
  }, [plays]);

  const currentTurnBoundaryIndex = currentAction
    ? turnBoundaries.findIndex(
        (boundary) =>
          boundary.turnKey === replayTurnValue(currentAction.turnNumber),
      )
    : -1;

  if (!currentAction) {
    return (
      <article className="panel inner match-replay-game">
        <h4>Game {gameNumber}</h4>
        <StatusMessage>No observed card plays for this game.</StatusMessage>
      </article>
    );
  }

  const currentPreview = previewByCardID.get(currentAction.cardId) ?? null;
  const currentName =
    currentPreview?.name ??
    cardDisplayName({
      cardId: currentAction.cardId,
      cardName: currentAction.cardName,
    });
  const canStepBackward = selectedActionIndex > 0;
  const canStepForward = selectedActionIndex < plays.length - 1;
  const canJumpPrevTurn = currentTurnBoundaryIndex > 0;
  const canJumpNextTurn =
    currentTurnBoundaryIndex >= 0 &&
    currentTurnBoundaryIndex < turnBoundaries.length - 1;

  return (
    <article className="panel inner match-replay-game">
      <div className="match-replay-head">
        <div className="match-replay-head-copy">
          <h4>Game {gameNumber}</h4>
          <p className="match-replay-caption">
            {replayMomentLabel(currentAction)} • Action{" "}
            {selectedActionIndex + 1} of {plays.length}
          </p>
        </div>
        <p className="match-replay-kicker">Observed replay</p>
      </div>

      <div className="match-replay-controls">
        <div
          className="match-replay-button-row"
          role="group"
          aria-label={`Game ${gameNumber} replay controls`}
        >
          <button
            type="button"
            className="match-replay-button"
            onClick={() => setIsPlaying((currentValue) => !currentValue)}
            aria-pressed={isPlaying}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className="match-replay-button"
            onClick={() => {
              setIsPlaying(false);
              setSelectedActionIndex(
                turnBoundaries[currentTurnBoundaryIndex - 1]?.firstIndex ?? 0,
              );
            }}
            disabled={!canJumpPrevTurn}
          >
            Previous Turn
          </button>
          <button
            type="button"
            className="match-replay-button"
            onClick={() => {
              setIsPlaying(false);
              setSelectedActionIndex((currentIndex) =>
                Math.max(currentIndex - 1, 0),
              );
            }}
            disabled={!canStepBackward}
          >
            Previous Action
          </button>
          <button
            type="button"
            className="match-replay-button"
            onClick={() => {
              setIsPlaying(false);
              setSelectedActionIndex((currentIndex) =>
                Math.min(currentIndex + 1, plays.length - 1),
              );
            }}
            disabled={!canStepForward}
          >
            Next Action
          </button>
          <button
            type="button"
            className="match-replay-button"
            onClick={() => {
              setIsPlaying(false);
              setSelectedActionIndex(
                turnBoundaries[currentTurnBoundaryIndex + 1]?.firstIndex ??
                  plays.length - 1,
              );
            }}
            disabled={!canJumpNextTurn}
          >
            Next Turn
          </button>
        </div>

        <div className="match-replay-track-panel">
          <MatchReplayTrack
            plays={plays}
            selectedActionIndex={selectedActionIndex}
            onSelectAction={setSelectedActionIndex}
          />
        </div>
      </div>

      <div className="match-replay-canvas">
        <aside className="match-replay-sidebar">
          <MatchReplaySideSummary
            side="opponent"
            plays={opponentVisiblePlays}
          />

          <section
            className="match-replay-stackbox"
            aria-label={`Game ${gameNumber} current action`}
          >
            <div className="match-replay-stackbox-head">
              <p className="match-replay-sidebox-label">Current Action</p>
              <p className="match-replay-sidebox-total">
                #{selectedActionIndex + 1}
              </p>
            </div>
            <div className="match-replay-stackbox-body">
              <MatchReplayCard
                play={currentAction}
                preview={currentPreview}
                active
                size="stack"
              />
              <div className="match-replay-stackbox-copy">
                <p className="match-replay-stackbox-player">
                  {timelinePlayerLabel(currentAction.playerSide)}
                </p>
                <h5>{currentName}</h5>
                <p>{timelineZoneLabel(currentAction.firstPublicZone)}</p>
                <p>{boardPlayMeta(currentAction)}</p>
                <p>
                  {currentAction.playedAt
                    ? formatDateTime(currentAction.playedAt)
                    : "Unknown time"}
                </p>
              </div>
            </div>
          </section>

          <MatchReplaySideSummary side="self" plays={selfVisiblePlays} />
        </aside>

        <div className="match-replay-board">
          <MatchReplayBattlefield
            side="opponent"
            plays={opponentVisiblePlays}
            activePlayID={currentAction.id}
            previewByCardID={previewByCardID}
          />

          <section
            className="match-replay-centerline"
            aria-label="Replay status"
          >
            <p className="match-replay-centerline-title">
              {replayMomentLabel(currentAction)}
            </p>
            <p className="match-replay-centerline-copy">
              {timelinePlayerLabel(currentAction.playerSide)} first showed{" "}
              {currentName} in{" "}
              {timelineZoneLabel(currentAction.firstPublicZone)}.
            </p>
            {unknownVisiblePlays.length > 0 ? (
              <p className="match-replay-centerline-copy">
                {unknownVisiblePlays.length} observation
                {unknownVisiblePlays.length === 1 ? "" : "s"} still have an
                unknown owner.
              </p>
            ) : null}
          </section>

          <MatchReplayBattlefield
            side="self"
            plays={selfVisiblePlays}
            activePlayID={currentAction.id}
            previewByCardID={previewByCardID}
          />
        </div>
      </div>
    </article>
  );
}

export function MatchDetailPage() {
  const params = useParams();
  const matchId = Number(params.matchId);
  const isValidMatchID = Number.isFinite(matchId);
  const [timelineDisplayMode, setTimelineDisplayMode] =
    useState<TimelineDisplayMode>("board");
  const [selectedTimelineGameNumber, setSelectedTimelineGameNumber] =
    useState<number | null>(null);
  const timelineGameTabBaseId = useId();

  const query = useQuery({
    queryKey: ["match-detail", matchId],
    queryFn: () => api.matchDetail(matchId),
    enabled: isValidMatchID,
  });
  const timelineQuery = useQuery({
    queryKey: ["match-timeline", matchId],
    queryFn: () => api.matchTimeline(matchId),
    enabled: isValidMatchID,
  });
  const replayQuery = useQuery({
    queryKey: ["match-replay", matchId],
    queryFn: () => api.matchReplay(matchId),
    enabled: isValidMatchID && timelineDisplayMode === "board",
  });

  const opponentObservedCards = query.data?.opponentObservedCards ?? [];
  const opponentCards = useMemo<OpponentDeckCard[]>(() => {
    return opponentObservedCards.map((card) => ({
      cardId: card.cardId,
      cardName: card.cardName,
      quantity: card.quantity,
    }));
  }, [opponentObservedCards]);

  const opponentCardPreviewQueries = useQueries({
    queries: opponentCards.map((card) => ({
      queryKey: cardPreviewQueryKey(card),
      queryFn: () => fetchCardPreview(card.cardId, card.cardName),
      enabled: card.cardId > 0,
      staleTime: 1000 * 60 * 60 * 24,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 1,
    })),
  });

  const opponentManaCostsByCardID = useMemo(() => {
    const out = new Map<number, string>();
    for (let i = 0; i < opponentCards.length; i += 1) {
      const card = opponentCards[i];
      const preview = opponentCardPreviewQueries[i]?.data;
      out.set(card.cardId, preview?.manaCost?.trim() ?? "");
    }
    return out;
  }, [opponentCards, opponentCardPreviewQueries]);

  const isOpponentCardMetadataLoading = opponentCardPreviewQueries.some(
    (previewQuery) => previewQuery.isPending,
  );
  const timelineRows = timelineQuery.data ?? query.data?.cardPlays ?? [];
  const replayFrames = replayQuery.data ?? [];
  const replayGroups = useMemo(() => {
    const byGame = new Map<number, MatchReplayFrame[]>();
    for (const frame of replayFrames) {
      const gameNumber =
        frame.gameNumber && frame.gameNumber > 0 ? frame.gameNumber : 1;
      const rows = byGame.get(gameNumber);
      if (rows) {
        rows.push(frame);
      } else {
        byGame.set(gameNumber, [frame]);
      }
    }

    return Array.from(byGame.entries())
      .map(([gameNumber, frames]) => [
        gameNumber,
        filterMeaningfulReplayFrames(frames),
      ] as const)
      .filter(([, frames]) => frames.length > 0)
      .sort((a, b) => a[0] - b[0]);
  }, [replayFrames]);
  const visibleReplayFrames = useMemo(
    () => replayGroups.flatMap(([, frames]) => frames),
    [replayGroups],
  );
  const hasReplayFrames = visibleReplayFrames.length > 0;
  const boardPreviewCards = useMemo<PreviewCard[]>(() => {
    const uniqueCards = new Map<number, PreviewCard>();

    if (hasReplayFrames) {
      for (const frame of visibleReplayFrames) {
        for (const object of frame.objects ?? []) {
          if (!uniqueCards.has(object.cardId)) {
            uniqueCards.set(object.cardId, {
              cardId: object.cardId,
              cardName: object.cardName,
            });
          }
        }
        for (const change of frame.changes ?? []) {
          if (!uniqueCards.has(change.cardId)) {
            uniqueCards.set(change.cardId, {
              cardId: change.cardId,
              cardName: change.cardName,
            });
          }
        }
      }
    } else {
      for (const play of timelineRows) {
        if (!uniqueCards.has(play.cardId)) {
          uniqueCards.set(play.cardId, {
            cardId: play.cardId,
            cardName: play.cardName,
          });
        }
      }
    }

    return Array.from(uniqueCards.values());
  }, [hasReplayFrames, timelineRows, visibleReplayFrames]);
  const boardCardPreviewQueries = useQueries({
    queries: boardPreviewCards.map((card) => ({
      queryKey: cardPreviewQueryKey(card),
      queryFn: () => fetchCardPreview(card.cardId, card.cardName),
      enabled: timelineDisplayMode === "board" && card.cardId > 0,
      staleTime: 1000 * 60 * 60 * 24,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 1,
    })),
  });
  const boardPreviewByCardID = useMemo(() => {
    const out = new Map<number, CardPreview | null>();
    for (let index = 0; index < boardPreviewCards.length; index += 1) {
      const card = boardPreviewCards[index];
      out.set(card.cardId, boardCardPreviewQueries[index]?.data ?? null);
    }
    return out;
  }, [boardPreviewCards, boardCardPreviewQueries]);
  const isBoardCardPreviewLoading =
    timelineDisplayMode === "board" &&
    boardCardPreviewQueries.some((queryRow) => queryRow.isPending);
  const timelineGroups = useMemo(() => {
    const byGame = new Map<number, MatchCardPlay[]>();
    for (const play of timelineRows) {
      const gameNumber =
        play.gameNumber && play.gameNumber > 0 ? play.gameNumber : 1;
      const rows = byGame.get(gameNumber);
      if (rows) {
        rows.push(play);
      } else {
        byGame.set(gameNumber, [play]);
      }
    }

    return Array.from(byGame.entries()).sort((a, b) => a[0] - b[0]);
  }, [timelineRows]);
  const timelineSummary = hasReplayFrames
    ? `${visibleReplayFrames.length} public replay step${visibleReplayFrames.length === 1 ? "" : "s"} across ${replayGroups.length} game${replayGroups.length === 1 ? "" : "s"}`
    : `${timelineRows.length} observed play${timelineRows.length === 1 ? "" : "s"}${timelineRows.length > 0 ? ` across ${timelineGroups.length} game${timelineGroups.length === 1 ? "" : "s"}` : ""}`;
  const timelineGameNumbers = useMemo(
    () =>
      (timelineDisplayMode === "board" && hasReplayFrames
        ? replayGroups
        : timelineGroups
      ).map(([gameNumber]) => gameNumber),
    [hasReplayFrames, replayGroups, timelineDisplayMode, timelineGroups],
  );
  const activeTimelineGameNumber =
    selectedTimelineGameNumber ?? timelineGameNumbers[0] ?? null;
  const activeReplayGroup =
    activeTimelineGameNumber === null
      ? null
      : replayGroups.find(([gameNumber]) => gameNumber === activeTimelineGameNumber) ??
        null;
  const activeTimelineGroup =
    activeTimelineGameNumber === null
      ? null
      : timelineGroups.find(
          ([gameNumber]) => gameNumber === activeTimelineGameNumber,
        ) ?? null;
  const activeTimelinePlays = activeTimelineGroup?.[1] ?? null;
  const showTimelineGameTabs = timelineGameNumbers.length > 1;
  const activeTimelineGameTabID =
    activeTimelineGameNumber === null
      ? undefined
      : `${timelineGameTabBaseId}-tab-${activeTimelineGameNumber}`;
  const activeTimelineGamePanelID =
    activeTimelineGameNumber === null
      ? undefined
      : `${timelineGameTabBaseId}-panel-${activeTimelineGameNumber}`;

  useEffect(() => {
    if (timelineGameNumbers.length === 0) {
      setSelectedTimelineGameNumber(null);
      return;
    }

    setSelectedTimelineGameNumber((currentGameNumber) =>
      currentGameNumber !== null &&
      timelineGameNumbers.includes(currentGameNumber)
        ? currentGameNumber
        : timelineGameNumbers[0],
    );
  }, [timelineGameNumbers]);

  function handleTimelineGameTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    gameNumber: number,
  ) {
    const currentIndex = timelineGameNumbers.indexOf(gameNumber);
    if (currentIndex === -1) return;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        setSelectedTimelineGameNumber(
          timelineGameNumbers[
            (currentIndex + timelineGameNumbers.length - 1) %
              timelineGameNumbers.length
          ],
        );
        break;
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        setSelectedTimelineGameNumber(
          timelineGameNumbers[
            (currentIndex + 1) % timelineGameNumbers.length
          ],
        );
        break;
      case "Home":
        event.preventDefault();
        setSelectedTimelineGameNumber(timelineGameNumbers[0]);
        break;
      case "End":
        event.preventDefault();
        setSelectedTimelineGameNumber(
          timelineGameNumbers[timelineGameNumbers.length - 1],
        );
        break;
      default:
        break;
    }
  }

  if (!isValidMatchID)
    return <StatusMessage tone="error">Invalid match id.</StatusMessage>;
  if (query.isLoading) return <StatusMessage>Loading match…</StatusMessage>;
  if (query.error)
    return (
      <StatusMessage tone="error">
        {(query.error as Error).message}
      </StatusMessage>
    );
  if (!query.data) return <StatusMessage>Match not found.</StatusMessage>;

  const { match } = query.data;

  return (
    <div className="stack-lg">
      <section className="panel match-detail-overview-panel">
        <div className="panel-head">
          <h3>Match #{match.id}</h3>
          <Link className="text-link" to="/matches">
            Back to matches
          </Link>
        </div>
        <dl className="match-detail-summary" aria-label="Match overview">
          <div className="match-detail-summary-item">
            <dt>Event</dt>
            <dd>{match.eventName || "-"}</dd>
          </div>
          <div className="match-detail-summary-item">
            <dt>Deck</dt>
            <dd>
              {match.deckId ? (
                <Link className="text-link" to={`/decks/${match.deckId}`}>
                  {match.deckName || `Deck ${match.deckId}`}
                </Link>
              ) : (
                "-"
              )}
            </dd>
          </div>
          <div className="match-detail-summary-item">
            <dt>Opponent</dt>
            <dd>{match.opponent || "Unknown"}</dd>
          </div>
          <div className="match-detail-summary-item">
            <dt>Deck Colors</dt>
            <dd>
              <MatchDeckColors
                className="match-deck-colors-detail"
                deckColors={match.deckColors}
                deckColorsKnown={match.deckColorsKnown}
                opponentDeckColors={match.opponentDeckColors}
                opponentDeckColorsKnown={match.opponentDeckColorsKnown}
              />
            </dd>
          </div>
          <div className="match-detail-summary-item match-detail-summary-item-mono">
            <dt>Started</dt>
            <dd>{formatDateTime(match.startedAt)}</dd>
          </div>
          <div className="match-detail-summary-item">
            <dt>Result</dt>
            <dd>
              <ResultPill result={match.result} />
            </dd>
          </div>
          <div className="match-detail-summary-item">
            <dt>Reason</dt>
            <dd>{match.winReason || "-"}</dd>
          </div>
          <div className="match-detail-summary-item match-detail-summary-item-mono">
            <dt>Turns</dt>
            <dd>{match.turnCount ?? "-"}</dd>
          </div>
          <div className="match-detail-summary-item match-detail-summary-item-mono">
            <dt>Duration</dt>
            <dd>{formatDuration(match.secondsCount ?? undefined)}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <div className="panel-head match-timeline-toolbar">
          <div className="match-timeline-heading">
            <h3>Card Play Timeline</h3>
            <p>{timelineSummary}</p>
          </div>
          <div
            className="tabs"
            role="group"
            aria-label="Card play timeline display"
          >
            <button
              type="button"
              className={`tab match-timeline-button ${timelineDisplayMode === "board" ? "is-active" : ""}`}
              aria-pressed={timelineDisplayMode === "board"}
              onClick={() => setTimelineDisplayMode("board")}
            >
              Board
            </button>
            <button
              type="button"
              className={`tab match-timeline-button ${timelineDisplayMode === "list" ? "is-active" : ""}`}
              aria-pressed={timelineDisplayMode === "list"}
              onClick={() => setTimelineDisplayMode("list")}
            >
              List
            </button>
          </div>
        </div>
        {showTimelineGameTabs ? (
          <div
            className="tabs match-timeline-game-tabs"
            role="tablist"
            aria-label="Timeline game selector"
          >
            {timelineGameNumbers.map((gameNumber) => (
              <button
                key={gameNumber}
                type="button"
                id={`${timelineGameTabBaseId}-tab-${gameNumber}`}
                role="tab"
                aria-selected={activeTimelineGameNumber === gameNumber}
                aria-controls={`${timelineGameTabBaseId}-panel-${gameNumber}`}
                tabIndex={activeTimelineGameNumber === gameNumber ? 0 : -1}
                className={`tab match-timeline-button ${activeTimelineGameNumber === gameNumber ? "is-active" : ""}`}
                onClick={() => setSelectedTimelineGameNumber(gameNumber)}
                onKeyDown={(event) =>
                  handleTimelineGameTabKeyDown(event, gameNumber)
                }
              >
                Game {gameNumber}
              </button>
            ))}
          </div>
        ) : null}
        {timelineDisplayMode === "board" ? (
          <div className="stack-md">
            <p className="match-board-disclaimer">
              {hasReplayFrames
                ? "This view uses stored public replay frames, so the stack and battlefield follow public GRE state at each step. Hidden cards, targets, and private-zone interactions can still be incomplete."
                : "Replay frames are not available for this match yet, so this fallback board still uses first public sightings and cannot show a true stack."}
            </p>
            {replayQuery.isPending ? (
              <StatusMessage>Loading replay frames…</StatusMessage>
            ) : hasReplayFrames ? (
              activeReplayGroup ? (
                <div
                  id={showTimelineGameTabs ? activeTimelineGamePanelID : undefined}
                  role={showTimelineGameTabs ? "tabpanel" : undefined}
                  aria-labelledby={
                    showTimelineGameTabs ? activeTimelineGameTabID : undefined
                  }
                >
                  <MatchReplayFrameBoard
                    gameNumber={activeReplayGroup[0]}
                    frames={activeReplayGroup[1]}
                    previewByCardID={boardPreviewByCardID}
                  />
                </div>
              ) : (
                <StatusMessage>
                  No observed replay data for this match yet.
                </StatusMessage>
              )
            ) : timelineQuery.error ? (
              <StatusMessage tone="error">
                {(timelineQuery.error as Error).message}
              </StatusMessage>
            ) : timelineRows.length === 0 ? (
              <StatusMessage>
                No observed replay data for this match yet.
              </StatusMessage>
            ) : (
              activeTimelineGroup ? (
                <div
                  id={showTimelineGameTabs ? activeTimelineGamePanelID : undefined}
                  role={showTimelineGameTabs ? "tabpanel" : undefined}
                  aria-labelledby={
                    showTimelineGameTabs ? activeTimelineGameTabID : undefined
                  }
                >
                  <MatchTimelineBoard
                    gameNumber={activeTimelineGroup[0]}
                    plays={activeTimelineGroup[1]}
                    previewByCardID={boardPreviewByCardID}
                  />
                </div>
              ) : (
                <StatusMessage>
                  No observed replay data for this match yet.
                </StatusMessage>
              )
            )}
            {replayQuery.error && !hasReplayFrames ? (
              <StatusMessage tone="error">
                {(replayQuery.error as Error).message}
              </StatusMessage>
            ) : null}
            {isBoardCardPreviewLoading ? (
              <StatusMessage>Loading replay card art…</StatusMessage>
            ) : null}
          </div>
        ) : timelineQuery.error ? (
          <StatusMessage tone="error">
            {(timelineQuery.error as Error).message}
          </StatusMessage>
        ) : timelineRows.length === 0 ? (
          <StatusMessage>
            No observed card plays for this match yet.
          </StatusMessage>
        ) : (
          <div
            className="stack-md"
            id={showTimelineGameTabs ? activeTimelineGamePanelID : undefined}
            role={showTimelineGameTabs ? "tabpanel" : undefined}
            aria-labelledby={
              showTimelineGameTabs ? activeTimelineGameTabID : undefined
            }
          >
            {activeTimelineGameNumber !== null && activeTimelinePlays ? (
              <div className="stack-md">
                <h4>Game {activeTimelineGameNumber}</h4>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Turn</th>
                        <th>Player</th>
                        <th>Card</th>
                        <th>Zone</th>
                        <th>Phase</th>
                        <th>Seen At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeTimelinePlays.map((play, index) => (
                        <tr key={play.id}>
                          <td>{index + 1}</td>
                          <td>{play.turnNumber ?? "-"}</td>
                          <td>{timelinePlayerLabel(play.playerSide)}</td>
                          <td>
                            <CardPreviewName
                              card={{
                                cardId: play.cardId,
                                cardName: play.cardName,
                              }}
                            />
                          </td>
                          <td>{timelineZoneLabel(play.firstPublicZone)}</td>
                          <td>{timelinePhaseLabel(play.phase)}</td>
                          <td>{formatDateTime(play.playedAt ?? "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <StatusMessage>
                No observed card plays for this match yet.
              </StatusMessage>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Observed Opponent Cards</h3>
          <p>{opponentObservedCards.length} unique cards</p>
        </div>
        {opponentObservedCards.length === 0 ? (
          <StatusMessage>
            No public opponent cards observed for this match yet.
          </StatusMessage>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Qty</th>
                  <th>Card</th>
                  <th>Mana</th>
                </tr>
              </thead>
              <tbody>
                {opponentCards.map((card) => (
                  <tr key={card.cardId}>
                    <td>{card.quantity}</td>
                    <td>
                      <CardPreviewName card={card} />
                    </td>
                    <td>
                      <span className="deck-card-mana">
                        <ManaCostDisplay
                          manaCost={
                            opponentManaCostsByCardID.get(card.cardId) ?? ""
                          }
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {isOpponentCardMetadataLoading ? (
          <StatusMessage>Loading card previews and mana details…</StatusMessage>
        ) : null}
      </section>
    </div>
  );
}
