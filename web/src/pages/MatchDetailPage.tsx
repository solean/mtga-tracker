import {
  type CSSProperties,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
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
  | "hand"
  | "battlefield"
  | "stack"
  | "graveyard"
  | "exile"
  | "revealed"
  | "other";
type InspectableZoneKind = "graveyard" | "exile";
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
type ReplayConnectionKind = "combat" | "spellTarget";
type ReplayBoardConnection = {
  kind: ReplayConnectionKind;
  sourceId: number;
  targetId: number;
};
type ReplayAnnotationDetail = {
  key?: string;
  type?: string;
  valueInt32?: number[];
  valueString?: string[];
};
type ReplayAnnotation = {
  affectorId?: number;
  affectedIds?: number[];
  type?: string[];
  details?: ReplayAnnotationDetail[];
};
type ReplayAnnotationPayload = {
  annotations?: ReplayAnnotation[];
  persistentAnnotations?: ReplayAnnotation[];
};
type MatchReplayZoneDialogState =
  | {
      source: "replay";
      side: "self" | "opponent";
      zone: InspectableZoneKind;
      objects: MatchReplayFrameObject[];
    }
  | {
      source: "observed";
      side: "self" | "opponent";
      zone: InspectableZoneKind;
      plays: MatchCardPlay[];
    };

const BOARD_ZONE_ORDER: BoardZoneKind[] = [
  "hand",
  "battlefield",
  "stack",
  "graveyard",
  "exile",
  "revealed",
  "other",
];
const BATTLEFIELD_SECTION_ORDER: BattlefieldSectionKind[] = [
  "lands",
  "other",
  "battles",
  "planeswalkers",
  "artifacts_enchantments",
  "creatures",
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
  if (normalized.includes("hand")) return "hand";
  if (normalized.includes("battlefield")) return "battlefield";
  if (normalized.includes("stack")) return "stack";
  if (normalized.includes("graveyard")) return "graveyard";
  if (normalized.includes("exile")) return "exile";
  if (normalized.includes("reveal")) return "revealed";
  return "other";
}

function boardZoneLabel(kind: BoardZoneKind): string {
  if (kind === "hand") return "Hand";
  if (kind === "battlefield") return "Battlefield";
  if (kind === "stack") return "Stack";
  if (kind === "graveyard") return "Graveyard";
  if (kind === "exile") return "Exile";
  if (kind === "revealed") return "Revealed";
  return "Other";
}

function isInspectableZoneKind(kind: BoardZoneKind): kind is InspectableZoneKind {
  return kind === "graveyard" || kind === "exile";
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

function useFloatingCardPreviewPopover(isEnabled = true) {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPlacement, setPopoverPlacement] =
    useState<PopoverPlacement>("right");
  const [popoverStyle, setPopoverStyle] = useState<{
    top: number;
    left: number;
  }>({ top: 0, left: 0 });
  const wrapperRef = useRef<HTMLDivElement | null>(null);

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
    if (!isEnabled) {
      return;
    }
    updatePopoverPlacement();
    setIsOpen(true);
  };

  const closePopover = () => {
    setIsOpen(false);
  };

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (
      wrapperRef.current &&
      event.relatedTarget instanceof Node &&
      wrapperRef.current.contains(event.relatedTarget)
    ) {
      return;
    }
    closePopover();
  };

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

  useEffect(() => {
    if (isEnabled) {
      return;
    }
    setIsOpen(false);
  }, [isEnabled]);

  return {
    isOpen,
    popoverPlacement,
    popoverStyle,
    wrapperRef,
    openPopover,
    closePopover,
    handleBlur,
  };
}

function CardPreviewName({ card }: { card: PreviewCard }) {
  const name = cardDisplayName(card);
  const fallbackHref = cardFallbackHref(card);
  const {
    isOpen,
    popoverPlacement,
    popoverStyle,
    wrapperRef,
    openPopover,
    closePopover,
    handleBlur,
  } = useFloatingCardPreviewPopover();

  const previewQuery = useQuery({
    queryKey: cardPreviewQueryKey(card),
    queryFn: () => fetchCardPreview(card.cardId, card.cardName),
    enabled: isOpen,
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
  });

  return (
    <div
      className="card-preview-anchor"
      data-popover-placement={popoverPlacement}
      ref={wrapperRef}
      onMouseEnter={openPopover}
      onMouseLeave={closePopover}
    >
      <a
        className="card-preview-trigger"
        href={previewQuery.data?.scryfallUrl ?? fallbackHref}
        target="_blank"
        rel="noreferrer"
        onFocus={openPopover}
        onBlur={handleBlur}
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

function ReplayCardPreviewAnchor({
  preview,
  wrapperClassName,
  wrapperStyle,
  children,
}: {
  preview: CardPreview | null;
  wrapperClassName?: string;
  wrapperStyle?: CSSProperties;
  children: ReactNode;
}) {
  const {
    isOpen,
    popoverPlacement,
    popoverStyle,
    wrapperRef,
    openPopover,
    closePopover,
    handleBlur,
  } = useFloatingCardPreviewPopover(Boolean(preview?.imageUrl));

  if (!preview?.imageUrl) {
    return <>{children}</>;
  }

  return (
    <div
      className={`card-preview-anchor is-replay-card${wrapperClassName ? ` ${wrapperClassName}` : ""}`}
      data-popover-placement={popoverPlacement}
      ref={wrapperRef}
      style={wrapperStyle}
      onMouseEnter={openPopover}
      onMouseLeave={closePopover}
      onFocus={openPopover}
      onBlur={handleBlur}
    >
      {children}
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
              <img
                src={preview.imageUrl}
                alt=""
                width={336}
                height={468}
              />
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

type ReplayTurnBoundary = {
  turnKey: number;
  firstIndex: number;
  lastIndex: number;
};

function buildReplayTurnBoundaries<T extends { turnNumber?: number }>(
  items: T[],
): ReplayTurnBoundary[] {
  const firstByTurn = new Map<number, number>();
  const lastByTurn = new Map<number, number>();

  for (let index = 0; index < items.length; index += 1) {
    const turnKey = replayTurnValue(items[index].turnNumber);
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
}

function replayTurnBoundaryCount(boundary: ReplayTurnBoundary): number {
  return boundary.lastIndex - boundary.firstIndex + 1;
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
  return replayObjectBlockAttackerIDs(object).length;
}

function replayObjectBlockAttackerIDs(object: MatchReplayFrameObject): number[] {
  const raw = object.blockAttackerIdsJson?.trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is number => typeof value === "number")
      : [];
  } catch {
    return [];
  }
}

function replayFrameAnnotations(frame: MatchReplayFrame | null): ReplayAnnotation[] {
  const raw = frame?.annotationsJson?.trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }

    const payload = parsed as ReplayAnnotationPayload;
    const next: ReplayAnnotation[] = [];
    if (Array.isArray(payload.annotations)) {
      next.push(...payload.annotations);
    }
    if (Array.isArray(payload.persistentAnnotations)) {
      next.push(...payload.persistentAnnotations);
    }
    return next.filter(
      (annotation): annotation is ReplayAnnotation =>
        Boolean(annotation) && typeof annotation === "object",
    );
  } catch {
    return [];
  }
}

function replayAnnotationHasType(
  annotation: ReplayAnnotation,
  expectedType: string,
): boolean {
  return Array.isArray(annotation.type) && annotation.type.includes(expectedType);
}

function replayAnnotationDetailIntValue(
  annotation: ReplayAnnotation,
  key: string,
): number | undefined {
  if (!Array.isArray(annotation.details)) {
    return undefined;
  }

  for (const detail of annotation.details) {
    if (detail?.key !== key || !Array.isArray(detail.valueInt32)) {
      continue;
    }
    const value = detail.valueInt32[0];
    if (typeof value === "number") {
      return value;
    }
  }

  return undefined;
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

function replayObjectName(
  object: MatchReplayFrameObject,
  preview: CardPreview | null,
): string {
  return (preview?.name ?? cardDisplayName(object)).trim();
}

function replayObjectIsBasicLand(
  object: MatchReplayFrameObject,
  preview: CardPreview | null,
): boolean {
  const typeLine = preview?.typeLine?.toLowerCase() ?? "";
  if (typeLine.includes("basic")) {
    return true;
  }

  return replayObjectHasType(object, preview, "basic");
}

function replayObjectBasicLandRank(
  object: MatchReplayFrameObject,
  preview: CardPreview | null,
): number {
  const name = replayObjectName(object, preview).toLowerCase();

  if (name === "plains") return 0;
  if (name === "island") return 1;
  if (name === "swamp") return 2;
  if (name === "mountain") return 3;
  if (name === "forest") return 4;
  if (name === "wastes") return 5;
  return 6;
}

function sortBattlefieldSectionObjects(
  kind: BattlefieldSectionKind,
  objects: MatchReplayFrameObject[],
  previewByCardID: Map<number, CardPreview | null>,
): MatchReplayFrameObject[] {
  if (kind !== "lands") {
    return objects;
  }

  return [...objects].sort((a, b) => {
    const aPreview = previewByCardID.get(a.cardId) ?? null;
    const bPreview = previewByCardID.get(b.cardId) ?? null;
    const aBasic = replayObjectIsBasicLand(a, aPreview);
    const bBasic = replayObjectIsBasicLand(b, bPreview);

    if (aBasic !== bBasic) {
      return aBasic ? -1 : 1;
    }

    if (aBasic && bBasic) {
      const basicRankDelta =
        replayObjectBasicLandRank(a, aPreview) -
        replayObjectBasicLandRank(b, bPreview);
      if (basicRankDelta !== 0) {
        return basicRankDelta;
      }
    }

    const nameDelta = replayObjectName(a, aPreview).localeCompare(
      replayObjectName(b, bPreview),
    );
    if (nameDelta !== 0) {
      return nameDelta;
    }

    return sortReplayObjects(a, b);
  });
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
  return "Initial replay snapshot for this game state.";
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
    <ReplayCardPreviewAnchor preview={preview}>
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
    </ReplayCardPreviewAnchor>
  );
}

function MatchReplayObjectCard({
  object,
  preview,
  previewByCardID,
  active = false,
  size = "board",
  chipLabel,
  shellRef,
  connectionHighlighted = false,
  onConnectionFocusChange,
  linkedExileObjects = [],
}: {
  object: MatchReplayFrameObject;
  preview: CardPreview | null;
  previewByCardID?: Map<number, CardPreview | null>;
  active?: boolean;
  size?: "board" | "stack" | "hand";
  chipLabel?: string;
  shellRef?: (element: HTMLDivElement | null) => void;
  connectionHighlighted?: boolean;
  onConnectionFocusChange?: (instanceId: number | null) => void;
  linkedExileObjects?: MatchReplayFrameObject[];
}) {
  const card = { cardId: object.cardId, cardName: object.cardName };
  const name = preview?.name ?? cardDisplayName(card);
  const href = preview?.scryfallUrl ?? cardFallbackHref(card);
  const linkedExileCards = linkedExileObjects.map((linkedObject) => {
    const linkedPreview = previewByCardID?.get(linkedObject.cardId) ?? null;
    return {
      object: linkedObject,
      preview: linkedPreview,
      name: replayObjectName(linkedObject, linkedPreview),
    };
  });
  const linkedExileSummary =
    linkedExileCards.length === 0
      ? null
      : linkedExileCards.length === 1
        ? `Exiling ${linkedExileCards[0]?.name ?? "1 card"}`
        : `Exiling ${linkedExileCards.length} cards`;
  const statusText = [
    replayObjectStatusText(object, preview),
    linkedExileSummary,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" • ");
  const statePills = replayObjectStatePills(object);
  const counterPills = replayObjectCounterSummaries(object);
  const isTappedBoardCard =
    size === "board" &&
    boardZoneKind(object.zoneType) === "battlefield" &&
    object.isTapped;
  const isAttackingBoardCard =
    size === "board" &&
    boardZoneKind(object.zoneType) === "battlefield" &&
    replayObjectIsAttacking(object);
  const statBadge =
    size === "board" && boardZoneKind(object.zoneType) === "battlefield"
      ? replayObjectPTLabel(object, preview)
      : null;
  const visibleLinkedExileCards =
    size === "board" && boardZoneKind(object.zoneType) === "battlefield"
      ? linkedExileCards.slice(0, 2)
      : [];
  const hasLinkedExileCards = visibleLinkedExileCards.length > 0;

  const cardNode = (
    <ReplayCardPreviewAnchor preview={preview}>
      <a
        className={`match-replay-card is-${size} ${active ? "is-active" : ""} ${isTappedBoardCard ? "is-tapped" : ""} ${connectionHighlighted ? "is-connection-highlighted" : ""}`}
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${name} on Scryfall${linkedExileSummary ? `. ${linkedExileSummary}.` : ""}`}
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
        {statBadge ? (
          <span className="match-replay-card-power">{statBadge}</span>
        ) : null}
      </a>
    </ReplayCardPreviewAnchor>
  );

  if (size === "stack" || size === "hand") {
    return cardNode;
  }

  return (
    <div
      className={`match-replay-object ${isTappedBoardCard ? "is-tapped" : ""} ${isAttackingBoardCard ? "is-attacking" : ""} ${connectionHighlighted ? "is-connection-highlighted" : ""} ${hasLinkedExileCards ? "has-linked-exile" : ""}`}
      onMouseEnter={
        onConnectionFocusChange
          ? () => onConnectionFocusChange(object.instanceId)
          : undefined
      }
      onMouseLeave={
        onConnectionFocusChange ? () => onConnectionFocusChange(null) : undefined
      }
      onFocus={
        onConnectionFocusChange
          ? () => onConnectionFocusChange(object.instanceId)
          : undefined
      }
      onBlur={
        onConnectionFocusChange ? () => onConnectionFocusChange(null) : undefined
      }
    >
      <div className="match-replay-card-shell" ref={shellRef}>
        {visibleLinkedExileCards.length > 0 ? (
          <div
            className="match-replay-linked-exile-stack"
          >
            {visibleLinkedExileCards.map((linkedCard, index) => (
              <ReplayCardPreviewAnchor
                key={linkedCard.object.instanceId}
                preview={linkedCard.preview}
                wrapperClassName="match-replay-linked-exile-card"
                wrapperStyle={
                  {
                    "--linked-exile-index": index,
                  } as CSSProperties
                }
              >
                <a
                  className="match-replay-linked-exile-anchor"
                  href={
                    linkedCard.preview?.scryfallUrl ??
                    cardFallbackHref({
                      cardId: linkedCard.object.cardId,
                      cardName: linkedCard.object.cardName,
                    })
                  }
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open exiled card ${linkedCard.name} on Scryfall`}
                  title={`${linkedCard.name} • Exiled by ${name}`}
                >
                  {linkedCard.preview ? (
                    <img
                      src={linkedCard.preview.imageUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      width={244}
                      height={340}
                    />
                  ) : (
                    <div className="match-replay-linked-exile-fallback">
                      <span>{linkedCard.name}</span>
                    </div>
                  )}
                </a>
              </ReplayCardPreviewAnchor>
            ))}
            {linkedExileCards.length > visibleLinkedExileCards.length ? (
              <span className="match-replay-linked-exile-count">
                +{linkedExileCards.length - visibleLinkedExileCards.length}
              </span>
            ) : null}
          </div>
        ) : null}
        {cardNode}
      </div>
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

function MatchReplayConnectionOverlay({
  surfaceRef,
  cardShellsRef,
  connections,
  focusedInstanceId,
}: {
  surfaceRef: RefObject<HTMLDivElement | null>;
  cardShellsRef: MutableRefObject<Map<number, HTMLDivElement>>;
  connections: ReplayBoardConnection[];
  focusedInstanceId: number | null;
}) {
  const combatMarkerId = useId();
  const spellTargetMarkerId = useId();
  const [snapshot, setSnapshot] = useState<{
    width: number;
    height: number;
    paths: Array<{
      key: string;
      d: string;
      kind: ReplayConnectionKind;
      highlighted: boolean;
    }>;
  } | null>(null);

  useEffect(() => {
    if (connections.length === 0) {
      setSnapshot(null);
      return;
    }

    const surfaceElement = surfaceRef.current;
    if (!surfaceElement) {
      setSnapshot(null);
      return;
    }

    let frameID = 0;
    let resizeObserver: ResizeObserver | null = null;

    const measure = () => {
      frameID = 0;
      const root = surfaceRef.current;
      if (!root) {
        setSnapshot(null);
        return;
      }

      const surfaceRect = root.getBoundingClientRect();
      if (surfaceRect.width <= 0 || surfaceRect.height <= 0) {
        setSnapshot(null);
        return;
      }

      const paths = connections.flatMap((connection) => {
        const sourceElement = cardShellsRef.current.get(connection.sourceId);
        const targetElement = cardShellsRef.current.get(connection.targetId);
        if (!sourceElement || !targetElement) {
          return [];
        }

        const sourceRect = sourceElement.getBoundingClientRect();
        const targetRect = targetElement.getBoundingClientRect();
        const startX =
          sourceRect.left + sourceRect.width / 2 - surfaceRect.left;
        const startY =
          sourceRect.top + sourceRect.height / 2 - surfaceRect.top;
        const endX = targetRect.left + targetRect.width / 2 - surfaceRect.left;
        const endY = targetRect.top + targetRect.height / 2 - surfaceRect.top;
        const d =
          connection.kind === "spellTarget"
            ? (() => {
                const deltaX = endX - startX;
                const direction = deltaX >= 0 ? 1 : -1;
                const horizontalPull =
                  Math.max(Math.abs(deltaX) * 0.38, 72) * direction;
                return `M ${startX} ${startY} C ${startX + horizontalPull} ${startY}, ${endX - horizontalPull} ${endY}, ${endX} ${endY}`;
              })()
            : (() => {
                const deltaY = endY - startY;
                return `M ${startX} ${startY} C ${startX} ${startY + deltaY * 0.34}, ${endX} ${endY - deltaY * 0.34}, ${endX} ${endY}`;
              })();

        return [
          {
            key: `${connection.kind}-${connection.sourceId}-${connection.targetId}`,
            d,
            kind: connection.kind,
            highlighted:
              focusedInstanceId !== null &&
              (connection.sourceId === focusedInstanceId ||
                connection.targetId === focusedInstanceId),
          },
        ];
      });

      setSnapshot({
        width: surfaceRect.width,
        height: surfaceRect.height,
        paths,
      });
    };

    const scheduleMeasure = () => {
      if (frameID !== 0) {
        return;
      }
      frameID = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        scheduleMeasure();
      });
      resizeObserver.observe(surfaceElement);
      for (const element of cardShellsRef.current.values()) {
        resizeObserver.observe(element);
      }
    }
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      if (frameID !== 0) {
        window.cancelAnimationFrame(frameID);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [surfaceRef, cardShellsRef, connections, focusedInstanceId]);

  if (!snapshot || snapshot.paths.length === 0) {
    return null;
  }

  const shouldMuteIdleLines =
    focusedInstanceId === null && snapshot.paths.length > 3;

  return (
    <svg
      className={`match-replay-connection-overlay ${shouldMuteIdleLines ? "is-muted" : ""}`}
      viewBox={`0 0 ${snapshot.width} ${snapshot.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <marker
          id={combatMarkerId}
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M 0 0 L 10 5 L 0 10 z"
            fill="var(--combat-connection-line)"
          />
        </marker>
        <marker
          id={spellTargetMarkerId}
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M 0 0 L 10 5 L 0 10 z"
            fill="var(--spell-target-connection-line)"
          />
        </marker>
      </defs>
      {snapshot.paths.map((path) => (
        <path
          key={path.key}
          className={`match-replay-connection-path is-${path.kind === "spellTarget" ? "spell-target" : "combat"} ${path.highlighted ? "is-highlighted" : ""}`}
          d={path.d}
          markerEnd={`url(#${path.kind === "spellTarget" ? spellTargetMarkerId : combatMarkerId})`}
        />
      ))}
    </svg>
  );
}

function MatchReplayZoneDialog({
  state,
  previewByCardID,
  onClose,
}: {
  state: MatchReplayZoneDialogState | null;
  previewByCardID: Map<number, CardPreview | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!state) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFrameID = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!dialogRef.current) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-hidden") !== "true",
      );

      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      if (event.shiftKey) {
        if (!activeElement || activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.cancelAnimationFrame(focusFrameID);
      document.body.style.overflow = originalOverflow;
      previousFocusRef.current?.focus();
    };
  }, [onClose, state]);

  if (!state || typeof document === "undefined") {
    return null;
  }

  const title = `${timelinePlayerLabel(state.side)} ${boardZoneLabel(state.zone)}`;
  const cardCount =
    state.source === "replay" ? state.objects.length : state.plays.length;
  const subtitle =
    state.source === "replay"
      ? `${cardCount} card${cardCount === 1 ? "" : "s"} currently in ${boardZoneLabel(state.zone).toLowerCase()} this step.`
      : `${cardCount} observed card${cardCount === 1 ? "" : "s"} first seen in ${boardZoneLabel(state.zone).toLowerCase()} in this game.`;
  const replayObjects =
    state.source === "replay" ? [...state.objects].sort(sortReplayObjects) : [];
  const observedPlays = state.source === "observed" ? [...state.plays] : [];

  return createPortal(
    <div
      className="match-replay-zone-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="match-replay-zone-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="match-replay-zone-dialog-head">
          <div className="match-replay-zone-dialog-head-copy">
            <p className="match-replay-sidebox-label">Zone Viewer</p>
            <h5 id={titleId}>{title}</h5>
            <p
              id={descriptionId}
              className="match-replay-zone-dialog-description"
            >
              {subtitle}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="match-replay-zone-dialog-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="match-replay-zone-dialog-body">
          {state.source === "replay" ? (
            replayObjects.length === 0 ? (
              <p className="match-replay-empty">No cards in this zone.</p>
            ) : (
              <div
                className="match-replay-zone-dialog-grid"
                aria-label={`${title} cards`}
              >
                {replayObjects.map((object) => (
                  <div
                    className="match-replay-zone-dialog-card"
                    key={object.instanceId}
                  >
                    <MatchReplayObjectCard
                      object={object}
                      preview={previewByCardID.get(object.cardId) ?? null}
                      size="hand"
                    />
                  </div>
                ))}
              </div>
            )
          ) : observedPlays.length === 0 ? (
            <p className="match-replay-empty">No cards in this zone.</p>
          ) : (
            <div
              className="match-replay-zone-dialog-grid"
              aria-label={`${title} cards`}
            >
              {observedPlays.map((play) => (
                <div className="match-replay-zone-dialog-card" key={play.id}>
                  <MatchReplayCard
                    play={play}
                    preview={previewByCardID.get(play.cardId) ?? null}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function MatchReplayFrameSideSummary({
  side,
  objects,
  lifeTotal,
  includeHand = false,
  onOpenZone,
}: {
  side: "self" | "opponent";
  objects: MatchReplayFrameObject[];
  lifeTotal?: number;
  includeHand?: boolean;
  onOpenZone?: (state: MatchReplayZoneDialogState) => void;
}) {
  const sideObjects = useMemo(
    () => objects.filter((object) => object.playerSide === side),
    [objects, side],
  );
  const zoneCounts = useMemo(
    () => summarizeReplayFrameZones(sideObjects),
    [sideObjects],
  );
  const stats: BoardZoneKind[] = includeHand
    ? ["hand", "battlefield", "graveyard", "exile", "revealed"]
    : ["battlefield", "graveyard", "exile", "revealed"];

  return (
    <section
      className={`match-replay-sidebox is-${side}`}
      aria-label={`${timelinePlayerLabel(side)} visible summary`}
    >
      <div className="match-replay-sidebox-head">
        <div className="match-replay-sidebox-head-copy">
          <p className="match-replay-sidebox-label">
            {timelinePlayerLabel(side)}
          </p>
          <p className="match-replay-sidebox-total">
            {sideObjects.length} visible card{sideObjects.length === 1 ? "" : "s"}
          </p>
        </div>
        {typeof lifeTotal === "number" ? (
          <div
            className="match-replay-sidebox-life-stat"
            aria-label={`${timelinePlayerLabel(side)} life total ${lifeTotal}`}
          >
            <span className="match-replay-sidebox-life-label">Life</span>
            <span className="match-replay-sidebox-life-value">{lifeTotal}</span>
          </div>
        ) : null}
      </div>
      <dl className="match-replay-stats">
        {stats.map((kind) => {
          const count = zoneCounts.get(kind) ?? 0;
          const canOpen = isInspectableZoneKind(kind) && count > 0 && onOpenZone;
          const content = (
            <>
              <span className="match-replay-stat-term">{boardZoneLabel(kind)}</span>
              <span className="match-replay-stat-value">{count}</span>
              {canOpen ? (
                <span className="match-replay-stat-hint">View cards</span>
              ) : null}
            </>
          );

          if (canOpen) {
            return (
              <button
                type="button"
                className="match-replay-stat match-replay-stat-button"
                key={kind}
                aria-haspopup="dialog"
                aria-label={`View ${timelinePlayerLabel(side)} ${boardZoneLabel(kind).toLowerCase()}, ${count} card${count === 1 ? "" : "s"}`}
                onClick={() =>
                  onOpenZone({
                    source: "replay",
                    side,
                    zone: kind,
                    objects: sideObjects.filter(
                      (object) => boardZoneKind(object.zoneType) === kind,
                    ),
                  })
                }
              >
                {content}
              </button>
            );
          }

          return (
            <div className="match-replay-stat" key={kind}>
              {content}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function MatchReplayFrameBattlefield({
  side,
  objects,
  previewByCardID,
  highlightedInstanceIDs,
  onRegisterCardShell,
  connectionHighlightedInstanceIDs,
  connectionInteractiveInstanceIDs,
  onConnectionFocusChange,
  linkedExileObjectsByParentId,
}: {
  side: "self" | "opponent";
  objects: MatchReplayFrameObject[];
  previewByCardID: Map<number, CardPreview | null>;
  highlightedInstanceIDs: Set<number>;
  onRegisterCardShell?: (instanceId: number, element: HTMLDivElement | null) => void;
  connectionHighlightedInstanceIDs?: Set<number>;
  connectionInteractiveInstanceIDs?: Set<number>;
  onConnectionFocusChange?: (instanceId: number | null) => void;
  linkedExileObjectsByParentId?: Map<number, MatchReplayFrameObject[]>;
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
      objects: sortBattlefieldSectionObjects(
        kind,
        grouped.get(kind) ?? [],
        previewByCardID,
      ),
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
                    previewByCardID={previewByCardID}
                    active={highlightedInstanceIDs.has(object.instanceId)}
                    shellRef={
                      onRegisterCardShell
                        ? (element) =>
                            onRegisterCardShell(object.instanceId, element)
                        : undefined
                    }
                    connectionHighlighted={
                      connectionHighlightedInstanceIDs?.has(object.instanceId) ??
                      false
                    }
                    onConnectionFocusChange={
                      connectionInteractiveInstanceIDs?.has(object.instanceId)
                        ? onConnectionFocusChange
                        : undefined
                    }
                    linkedExileObjects={
                      linkedExileObjectsByParentId?.get(object.instanceId) ?? []
                    }
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

function MatchReplayHand({
  objects,
  previewByCardID,
  highlightedInstanceIDs,
}: {
  objects: MatchReplayFrameObject[];
  previewByCardID: Map<number, CardPreview | null>;
  highlightedInstanceIDs: Set<number>;
}) {
  const handObjects = useMemo(
    () =>
      objects
        .filter(
          (object) =>
            object.playerSide === "self" && boardZoneKind(object.zoneType) === "hand",
        )
        .sort(sortReplayObjects),
    [objects],
  );

  return (
    <section className="match-replay-lane is-hand" aria-label="Your hand">
      <div className="match-replay-lane-head">
        <div>
          <p className="match-replay-lane-title">Your Hand</p>
          <p className="match-replay-lane-subtitle">
            {handObjects.length} card{handObjects.length === 1 ? "" : "s"} currently in
            hand
          </p>
        </div>
      </div>
      {handObjects.length === 0 ? (
        <p className="match-replay-empty">No cards in hand in this step.</p>
      ) : (
        <div className="match-replay-card-row is-hand" aria-label="Current hand">
          {handObjects.map((object) => (
            <MatchReplayObjectCard
              key={object.instanceId}
              object={object}
              preview={previewByCardID.get(object.cardId) ?? null}
              active={highlightedInstanceIDs.has(object.instanceId)}
              size="hand"
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MatchReplayStack({
  frame,
  previewByCardID,
  highlightedInstanceIDs,
  onRegisterCardShell,
  connectionHighlightedInstanceIDs,
  connectionInteractiveInstanceIDs,
  onConnectionFocusChange,
}: {
  frame: MatchReplayFrame;
  previewByCardID: Map<number, CardPreview | null>;
  highlightedInstanceIDs: Set<number>;
  onRegisterCardShell?: (instanceId: number, element: HTMLDivElement | null) => void;
  connectionHighlightedInstanceIDs?: Set<number>;
  connectionInteractiveInstanceIDs?: Set<number>;
  onConnectionFocusChange?: (instanceId: number | null) => void;
}) {
  const stackObjects = useMemo(
    () =>
      [...(frame.objects ?? [])]
        .filter((object) => boardZoneKind(object.zoneType) === "stack")
        .sort(sortReplayObjects),
    [frame],
  );
  const topObject = stackObjects[stackObjects.length - 1] ?? null;

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
        {topObject ? (
          <p className="match-replay-stackbox-player">
            Top • {timelinePlayerLabel(topObject.playerSide)}
          </p>
        ) : null}
      </div>
      <div
        className={`match-replay-stackbox-body is-replay-stack ${stackObjects.length === 0 ? "is-empty" : ""}`}
      >
        <div
          className="match-replay-stack-cards"
          aria-label="Current stack ordered bottom to top"
        >
          {stackObjects.length === 0 ? (
            <p className="match-replay-empty">
              No public stack in this step.
            </p>
          ) : (
            stackObjects.map((object, index) => (
              <div
                className={`match-replay-stack-slot ${
                  connectionHighlightedInstanceIDs?.has(object.instanceId)
                    ? "is-connection-highlighted"
                    : ""
                }`}
                key={object.instanceId}
                onMouseEnter={
                  connectionInteractiveInstanceIDs?.has(object.instanceId) &&
                  onConnectionFocusChange
                    ? () => onConnectionFocusChange(object.instanceId)
                    : undefined
                }
                onMouseLeave={
                  connectionInteractiveInstanceIDs?.has(object.instanceId) &&
                  onConnectionFocusChange
                    ? () => onConnectionFocusChange(null)
                    : undefined
                }
                onFocus={
                  connectionInteractiveInstanceIDs?.has(object.instanceId) &&
                  onConnectionFocusChange
                    ? () => onConnectionFocusChange(object.instanceId)
                    : undefined
                }
                onBlur={
                  connectionInteractiveInstanceIDs?.has(object.instanceId) &&
                  onConnectionFocusChange
                    ? () => onConnectionFocusChange(null)
                    : undefined
                }
              >
                <div
                  className="match-replay-stack-card-shell"
                  ref={
                    onRegisterCardShell
                      ? (element) =>
                          onRegisterCardShell(object.instanceId, element)
                      : undefined
                  }
                >
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
                    connectionHighlighted={
                      connectionHighlightedInstanceIDs?.has(object.instanceId) ??
                      false
                    }
                  />
                </div>
                <p className="match-replay-stack-slot-copy">
                  {timelinePlayerLabel(object.playerSide)}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function MatchReplayTurnSelector({
  turns,
  selectedItemIndex,
  selectedTurnIndex,
  onSelectTurn,
  itemLabel,
}: {
  turns: ReplayTurnBoundary[];
  selectedItemIndex: number;
  selectedTurnIndex: number;
  onSelectTurn: (index: number) => void;
  itemLabel: "step" | "action";
}) {
  if (turns.length === 0) {
    return null;
  }

  return (
    <div className="match-replay-track-scroll">
      <div className="match-replay-turn-track" role="group" aria-label="Replay turns">
        {turns.map((turn, index) => {
          const isCurrent = index === selectedTurnIndex;
          const itemCount = replayTurnBoundaryCount(turn);
          const itemCountLabel = `${itemCount} ${itemLabel}${itemCount === 1 ? "" : "s"}`;
          const currentTurnIndex =
            isCurrent && selectedItemIndex >= turn.firstIndex
              ? selectedItemIndex - turn.firstIndex + 1
              : null;

          return (
            <button
              key={`${turn.turnKey}-${turn.firstIndex}`}
              type="button"
              className={`match-replay-turn-pill ${isCurrent ? "is-current" : ""}`}
              aria-pressed={isCurrent}
              aria-label={`${replayTurnLabel(turn.turnKey)}. ${itemCountLabel}.${currentTurnIndex ? ` Currently on ${itemLabel} ${currentTurnIndex} of ${itemCount}.` : " Jump to the start of this turn."}`}
              onClick={() => onSelectTurn(turn.firstIndex)}
            >
              <span className="match-replay-turn-pill-label">
                {boardTurnLabel(turn.turnKey)}
              </span>
              <span className="match-replay-turn-pill-meta">
                {itemCountLabel}
                {currentTurnIndex
                  ? ` • ${itemLabel} ${currentTurnIndex}/${itemCount}`
                  : ""}
              </span>
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
  const [zoneDialogState, setZoneDialogState] =
    useState<MatchReplayZoneDialogState | null>(null);
  const [focusedConnectionInstanceId, setFocusedConnectionInstanceId] = useState<
    number | null
  >(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const replayCardShellsRef = useRef(new Map<number, HTMLDivElement>());

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
  const turnBoundaries = useMemo(() => buildReplayTurnBoundaries(frames), [frames]);

  const currentTurnBoundaryIndex = currentFrame
    ? turnBoundaries.findIndex(
        (boundary) =>
          boundary.turnKey === replayTurnValue(currentFrame.turnNumber),
      )
    : -1;
  const currentObjects = currentFrame?.objects ?? [];
  const combatConnections = useMemo(() => {
    const battlefieldByID = new Map<number, MatchReplayFrameObject>();
    for (const object of currentObjects) {
      if (boardZoneKind(object.zoneType) !== "battlefield") {
        continue;
      }
      battlefieldByID.set(object.instanceId, object);
    }

    const next: ReplayBoardConnection[] = [];
    for (const object of battlefieldByID.values()) {
      if (!replayObjectIsBlocking(object)) {
        continue;
      }
      for (const attackerId of replayObjectBlockAttackerIDs(object)) {
        const attacker = battlefieldByID.get(attackerId);
        if (!attacker || !replayObjectIsAttacking(attacker)) {
          continue;
        }
        next.push({
          kind: "combat",
          sourceId: object.instanceId,
          targetId: attackerId,
        });
      }
    }
    return next;
  }, [currentObjects]);
  const spellTargetConnections = useMemo(() => {
    const battlefieldByID = new Map<number, MatchReplayFrameObject>();
    const stackByID = new Set<number>();
    for (const object of currentObjects) {
      const kind = boardZoneKind(object.zoneType);
      if (kind === "battlefield") {
        battlefieldByID.set(object.instanceId, object);
      }
      if (kind === "stack") {
        stackByID.add(object.instanceId);
      }
    }

    const seen = new Set<string>();
    const next: ReplayBoardConnection[] = [];
    for (const annotation of replayFrameAnnotations(currentFrame)) {
      if (!replayAnnotationHasType(annotation, "AnnotationType_TargetSpec")) {
        continue;
      }
      if (
        typeof annotation.affectorId !== "number" ||
        !stackByID.has(annotation.affectorId)
      ) {
        continue;
      }

      const affectedIds = Array.isArray(annotation.affectedIds)
        ? annotation.affectedIds
        : [];
      for (const targetId of affectedIds) {
        if (typeof targetId !== "number" || !battlefieldByID.has(targetId)) {
          continue;
        }
        const key = `${annotation.affectorId}-${targetId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        next.push({
          kind: "spellTarget",
          sourceId: annotation.affectorId,
          targetId,
        });
      }
    }

    return next;
  }, [currentFrame, currentObjects]);
  const overlayConnections = useMemo(
    () => [...combatConnections, ...spellTargetConnections],
    [combatConnections, spellTargetConnections],
  );
  const linkedExileObjectsByParentId = useMemo(() => {
    const currentObjectsById = new Map<number, MatchReplayFrameObject>();
    for (const object of currentObjects) {
      currentObjectsById.set(object.instanceId, object);
    }

    const linkedIdsByParentId = new Map<number, Set<number>>();
    for (let frameIndex = 0; frameIndex <= selectedFrameIndex; frameIndex += 1) {
      const frame = frames[frameIndex] ?? null;
      for (const annotation of replayFrameAnnotations(frame)) {
        if (
          !replayAnnotationHasType(annotation, "AnnotationType_DisplayCardUnderCard")
        ) {
          continue;
        }
        if (typeof annotation.affectorId !== "number") {
          continue;
        }
        const affectedIds = Array.isArray(annotation.affectedIds)
          ? annotation.affectedIds.filter(
              (value): value is number => typeof value === "number",
            )
          : [];
        if (affectedIds.length === 0) {
          continue;
        }

        const isDisabled =
          replayAnnotationDetailIntValue(annotation, "Disable") === 1;
        if (isDisabled) {
          const existing = linkedIdsByParentId.get(annotation.affectorId);
          if (!existing) {
            continue;
          }
          for (const affectedId of affectedIds) {
            existing.delete(affectedId);
          }
          if (existing.size === 0) {
            linkedIdsByParentId.delete(annotation.affectorId);
          }
          continue;
        }

        let nextLinkedIds = linkedIdsByParentId.get(annotation.affectorId);
        if (!nextLinkedIds) {
          nextLinkedIds = new Set<number>();
          linkedIdsByParentId.set(annotation.affectorId, nextLinkedIds);
        }
        for (const affectedId of affectedIds) {
          nextLinkedIds.add(affectedId);
        }
      }
    }

    const next = new Map<number, MatchReplayFrameObject[]>();
    for (const [parentId, linkedIds] of linkedIdsByParentId) {
      const parentObject = currentObjectsById.get(parentId);
      if (!parentObject || boardZoneKind(parentObject.zoneType) !== "battlefield") {
        continue;
      }

      const linkedObjects = [...linkedIds]
        .map((linkedId) => currentObjectsById.get(linkedId) ?? null)
        .filter(
          (linkedObject): linkedObject is MatchReplayFrameObject =>
            linkedObject !== null &&
            boardZoneKind(linkedObject.zoneType) === "exile",
        )
        .sort(sortReplayObjects);
      if (linkedObjects.length > 0) {
        next.set(parentId, linkedObjects);
      }
    }

    return next;
  }, [currentObjects, frames, selectedFrameIndex]);
  const overlayInteractiveInstanceIDs = useMemo(() => {
    const ids = new Set<number>();
    for (const connection of overlayConnections) {
      ids.add(connection.sourceId);
      ids.add(connection.targetId);
    }
    return ids;
  }, [overlayConnections]);
  const overlayHighlightedInstanceIDs = useMemo(() => {
    if (focusedConnectionInstanceId === null) {
      return new Set<number>();
    }

    const ids = new Set<number>([focusedConnectionInstanceId]);
    for (const connection of overlayConnections) {
      if (
        connection.sourceId === focusedConnectionInstanceId ||
        connection.targetId === focusedConnectionInstanceId
      ) {
        ids.add(connection.sourceId);
        ids.add(connection.targetId);
      }
    }
    return ids;
  }, [overlayConnections, focusedConnectionInstanceId]);
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
  const frameVisibilitySummary = `${currentObjects.length} tracked card${
    currentObjects.length === 1 ? "" : "s"
  } visible${
    stackCount > 0 ? ` • ${stackCount} currently on the stack` : " • stack empty"
  }${
    replayFrameLifeTotalsSummary(currentFrame)
      ? ` • ${replayFrameLifeTotalsSummary(currentFrame)}`
      : ""
  }${
    unknownObjectsCount > 0
      ? ` • ${unknownObjectsCount} with unknown owner`
      : ""
  }.`;

  useEffect(() => {
    setFocusedConnectionInstanceId(null);
  }, [currentFrame?.id]);

  function registerCardShell(instanceId: number, element: HTMLDivElement | null) {
    if (element) {
      replayCardShellsRef.current.set(instanceId, element);
      return;
    }
    replayCardShellsRef.current.delete(instanceId);
  }

  if (!currentFrame) {
    return (
      <article className="panel inner match-replay-game">
        <h4>Game {gameNumber}</h4>
        <StatusMessage>No replay steps for this game.</StatusMessage>
      </article>
    );
  }

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
        <p className="match-replay-kicker">Replay</p>
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
          <MatchReplayTurnSelector
            turns={turnBoundaries}
            selectedItemIndex={selectedFrameIndex}
            selectedTurnIndex={currentTurnBoundaryIndex}
            onSelectTurn={setSelectedFrameIndex}
            itemLabel="step"
          />
        </div>
      </div>

      <div className="match-replay-canvas" ref={canvasRef}>
        <MatchReplayConnectionOverlay
          surfaceRef={canvasRef}
          cardShellsRef={replayCardShellsRef}
          connections={overlayConnections}
          focusedInstanceId={focusedConnectionInstanceId}
        />
        <aside className="match-replay-sidebar">
          <MatchReplayFrameSideSummary
            side="opponent"
            objects={currentObjects}
            lifeTotal={currentFrame.opponentLifeTotal}
            onOpenZone={setZoneDialogState}
          />

          <MatchReplayStack
            frame={currentFrame}
            previewByCardID={previewByCardID}
            highlightedInstanceIDs={changedInstanceIDs}
            onRegisterCardShell={registerCardShell}
            connectionHighlightedInstanceIDs={overlayHighlightedInstanceIDs}
            connectionInteractiveInstanceIDs={overlayInteractiveInstanceIDs}
            onConnectionFocusChange={setFocusedConnectionInstanceId}
          />

          <MatchReplayFrameSideSummary
            side="self"
            objects={currentObjects}
            lifeTotal={currentFrame.selfLifeTotal}
            includeHand
            onOpenZone={setZoneDialogState}
          />
        </aside>

        <div className="match-replay-board-column">
          <section
            className="match-replay-statusbar"
            aria-label="Replay status"
          >
            <div className="match-replay-statusbar-head">
              <p className="match-replay-sidebox-label">Replay Step</p>
              <p className="match-replay-statusbar-title">
                {replayFrameMomentLabel(currentFrame)}
              </p>
            </div>
            <p className="match-replay-statusbar-copy">{primarySummary}</p>
            <p className="match-replay-statusbar-copy">
              {frameVisibilitySummary}
            </p>
            {notableChanges.length > 0 ? (
              <div
                className="match-replay-change-list is-statusbar"
                aria-label="Frame changes"
              >
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

          <div className="match-replay-board is-combat-board">
            <MatchReplayFrameBattlefield
              side="opponent"
              objects={currentObjects}
              previewByCardID={previewByCardID}
              highlightedInstanceIDs={changedInstanceIDs}
              onRegisterCardShell={registerCardShell}
              connectionHighlightedInstanceIDs={overlayHighlightedInstanceIDs}
              connectionInteractiveInstanceIDs={overlayInteractiveInstanceIDs}
              onConnectionFocusChange={setFocusedConnectionInstanceId}
              linkedExileObjectsByParentId={linkedExileObjectsByParentId}
            />

            <MatchReplayFrameBattlefield
              side="self"
              objects={currentObjects}
              previewByCardID={previewByCardID}
              highlightedInstanceIDs={changedInstanceIDs}
              onRegisterCardShell={registerCardShell}
              connectionHighlightedInstanceIDs={overlayHighlightedInstanceIDs}
              connectionInteractiveInstanceIDs={overlayInteractiveInstanceIDs}
              onConnectionFocusChange={setFocusedConnectionInstanceId}
              linkedExileObjectsByParentId={linkedExileObjectsByParentId}
            />

            <MatchReplayHand
              objects={currentObjects}
              previewByCardID={previewByCardID}
              highlightedInstanceIDs={changedInstanceIDs}
            />
          </div>
        </div>
      </div>

      <MatchReplayZoneDialog
        state={zoneDialogState}
        previewByCardID={previewByCardID}
        onClose={() => setZoneDialogState(null)}
      />
    </article>
  );
}

function MatchReplaySideSummary({
  side,
  plays,
  onOpenZone,
}: {
  side: "self" | "opponent";
  plays: MatchCardPlay[];
  onOpenZone?: (state: MatchReplayZoneDialogState) => void;
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
        {stats.map((kind) => {
          const count = zoneCounts.get(kind) ?? 0;
          const canOpen = isInspectableZoneKind(kind) && count > 0 && onOpenZone;
          const content = (
            <>
              <span className="match-replay-stat-term">{boardZoneLabel(kind)}</span>
              <span className="match-replay-stat-value">{count}</span>
              {canOpen ? (
                <span className="match-replay-stat-hint">View cards</span>
              ) : null}
            </>
          );

          if (canOpen) {
            return (
              <button
                type="button"
                className="match-replay-stat match-replay-stat-button"
                key={kind}
                aria-haspopup="dialog"
                aria-label={`View ${timelinePlayerLabel(side)} ${boardZoneLabel(kind).toLowerCase()}, ${count} card${count === 1 ? "" : "s"}`}
                onClick={() =>
                  onOpenZone({
                    source: "observed",
                    side,
                    zone: kind,
                    plays: plays.filter(
                      (play) => boardZoneKind(play.firstPublicZone) === kind,
                    ),
                  })
                }
              >
                {content}
              </button>
            );
          }

          return (
            <div className="match-replay-stat" key={kind}>
              {content}
            </div>
          );
        })}
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
  const [zoneDialogState, setZoneDialogState] =
    useState<MatchReplayZoneDialogState | null>(null);

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
  const turnBoundaries = useMemo(() => buildReplayTurnBoundaries(plays), [plays]);

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
          <MatchReplayTurnSelector
            turns={turnBoundaries}
            selectedItemIndex={selectedActionIndex}
            selectedTurnIndex={currentTurnBoundaryIndex}
            onSelectTurn={setSelectedActionIndex}
            itemLabel="action"
          />
        </div>
      </div>

      <div className="match-replay-canvas">
        <aside className="match-replay-sidebar">
          <MatchReplaySideSummary
            side="opponent"
            plays={opponentVisiblePlays}
            onOpenZone={setZoneDialogState}
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

          <MatchReplaySideSummary
            side="self"
            plays={selfVisiblePlays}
            onOpenZone={setZoneDialogState}
          />
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

      <MatchReplayZoneDialog
        state={zoneDialogState}
        previewByCardID={previewByCardID}
        onClose={() => setZoneDialogState(null)}
      />
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
            {!hasReplayFrames ? (
              <p className="match-board-disclaimer">
                Replay frames are not available for this match yet, so this fallback board still uses first public sightings and cannot show a true stack.
              </p>
            ) : null}
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
