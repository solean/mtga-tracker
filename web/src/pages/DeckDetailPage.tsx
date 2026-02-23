import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";

import { ResultPill } from "../components/ResultPill";
import { api } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";
import { fetchCardPreview, type CardPreview } from "../lib/scryfall";

type DeckListCard = {
  section: string;
  cardId: number;
  cardName?: string;
  quantity: number;
};

type PopoverPlacement = "left" | "right";
type PopoverPlacementMode = "auto" | "force-right";
type ManaCostPart = { kind: "symbol"; token: string } | { kind: "separator"; value: string };

type MainboardCategory = "creatures" | "spells" | "artifacts" | "enchantments" | "lands";

type MainboardDeckListCard = DeckListCard & {
  manaCost: string;
  manaValue: number | null;
};

type SideboardDeckListCard = DeckListCard & {
  manaCost: string;
};

const MAINBOARD_CATEGORY_ORDER: MainboardCategory[] = ["creatures", "spells", "artifacts", "enchantments", "lands"];
const MAINBOARD_SKELETON_CATEGORY_ORDER: MainboardCategory[] = ["creatures", "spells", "lands"];
const SCRYFALL_SYMBOL_BASE_URL = "https://svgs.scryfall.io/card-symbols";
const BASIC_LAND_ORDER: Record<string, number> = {
  island: 0,
  swamp: 1,
  forest: 2,
  mountain: 3,
  plains: 4,
};

function cardDisplayName(card: DeckListCard): string {
  return card.cardName?.trim() || `Card ${card.cardId}`;
}

function cardPreviewQueryKey(card: DeckListCard): [string, number, string] {
  return ["card-preview", card.cardId, cardDisplayName(card)];
}

function classifyMainboardCard(typeLine?: string): MainboardCategory {
  const lower = typeLine?.toLowerCase() ?? "";
  if (lower.includes("land")) {
    return "lands";
  }
  if (lower.includes("creature")) {
    return "creatures";
  }
  if (lower.includes("artifact")) {
    return "artifacts";
  }
  if (lower.includes("enchantment")) {
    return "enchantments";
  }
  return "spells";
}

function compareMainboardCards(a: MainboardDeckListCard, b: MainboardDeckListCard): number {
  const manaA = a.manaValue ?? Number.POSITIVE_INFINITY;
  const manaB = b.manaValue ?? Number.POSITIVE_INFINITY;
  if (manaA !== manaB) {
    return manaA - manaB;
  }
  const byName = cardDisplayName(a).localeCompare(cardDisplayName(b), undefined, { sensitivity: "base" });
  if (byName !== 0) {
    return byName;
  }
  return a.cardId - b.cardId;
}

function basicLandRank(card: DeckListCard): number {
  const normalized = cardDisplayName(card).trim().toLowerCase();
  const rank = BASIC_LAND_ORDER[normalized];
  if (typeof rank === "number") {
    return rank;
  }
  return Number.POSITIVE_INFINITY;
}

function compareLandCards(a: MainboardDeckListCard, b: MainboardDeckListCard): number {
  const basicRankA = basicLandRank(a);
  const basicRankB = basicLandRank(b);
  if (basicRankA !== basicRankB) {
    return basicRankA - basicRankB;
  }

  const byName = cardDisplayName(a).localeCompare(cardDisplayName(b), undefined, { sensitivity: "base" });
  if (byName !== 0) {
    return byName;
  }
  return a.cardId - b.cardId;
}

function formatSectionLabel(section: string): string {
  const trimmed = section.trim();
  if (!trimmed) {
    return "Other";
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function sectionTotal(cards: DeckListCard[]): number {
  return cards.reduce((sum, card) => sum + card.quantity, 0);
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

function manaSymbolURL(token: string): string {
  return `${SCRYFALL_SYMBOL_BASE_URL}/${encodeURIComponent(token)}.svg`;
}

function ManaSymbol({ token }: { token: string }) {
  const [didFail, setDidFail] = useState(false);
  const label = `{${token}}`;

  if (didFail) {
    return (
      <code className="mana-symbol-fallback" aria-label={label}>
        {label}
      </code>
    );
  }

  return (
    <img
      className="mana-symbol-icon"
      src={manaSymbolURL(token)}
      alt={label}
      loading="lazy"
      decoding="async"
      onError={() => setDidFail(true)}
    />
  );
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
    <span className="deck-card-mana-cost deck-card-mana-icons" aria-label={`Mana cost ${trimmed}`}>
      {parts.map((part, index) =>
        part.kind === "symbol" ? (
          <ManaSymbol key={`symbol-${part.token}-${index}`} token={part.token} />
        ) : (
          <span className="mana-symbol-separator" key={`sep-${part.value}-${index}`}>
            {part.value}
          </span>
        ),
      )}
    </span>
  );
}

function DeckCardPreviewName({ card, placementMode = "auto" }: { card: DeckListCard; placementMode?: PopoverPlacementMode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPlacement, setPopoverPlacement] = useState<PopoverPlacement>("right");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const name = cardDisplayName(card);
  const fallbackHref = card.cardName?.trim()
    ? `https://scryfall.com/search?q=${encodeURIComponent(`!"${name}"`)}`
    : `https://scryfall.com/search?q=${encodeURIComponent(`arenaid:${card.cardId}`)}`;

  const updatePopoverPlacement = () => {
    if (placementMode === "force-right") {
      setPopoverPlacement("right");
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const popoverWidth = window.matchMedia("(max-width: 640px)").matches ? 195 : 245;
    const horizontalGap = 14;
    const availableRight = viewportWidth - rect.right;
    const availableLeft = rect.left;

    if (availableRight >= popoverWidth + horizontalGap) {
      setPopoverPlacement("right");
      return;
    }
    if (availableLeft >= popoverWidth + horizontalGap) {
      setPopoverPlacement("left");
      return;
    }
    setPopoverPlacement(availableRight >= availableLeft ? "right" : "left");
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
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isOpen, placementMode]);

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
          if (wrapperRef.current && event.relatedTarget instanceof Node && wrapperRef.current.contains(event.relatedTarget)) {
            return;
          }
          setIsOpen(false);
        }}
        aria-label={`Open ${name} on Scryfall`}
      >
        <code>{name}</code>
      </a>

      {isOpen ? (
        <div className="card-preview-popover" role="tooltip">
          {previewQuery.isLoading ? (
            <p className="card-preview-status">Loading preview…</p>
          ) : previewQuery.data ? (
            <>
              <img src={previewQuery.data.imageUrl} alt={previewQuery.data.name} loading="lazy" />
              <div className="card-preview-meta">
                <p className="card-preview-name">{previewQuery.data.name}</p>
              </div>
            </>
          ) : (
            <p className="card-preview-status">Preview unavailable.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function clampSkeletonRows(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(12, Math.max(3, value));
}

function DeckSectionSkeleton({ rowCount = 7, showMana = true }: { rowCount?: number; showMana?: boolean }) {
  return (
    <article className="deck-card is-skeleton" aria-hidden="true">
      <h4>
        <span className="skeleton-line skeleton-title" />
      </h4>
      <ul>
        {Array.from({ length: rowCount }).map((_, index) => (
          <li key={`deck-skeleton-row-${index}`}>
            <span className="deck-card-qty">
              <span className="skeleton-chip skeleton-qty" />
            </span>
            <span className="skeleton-line skeleton-card-name" />
            {showMana ? (
              <span className="deck-card-mana">
                <span className="skeleton-chip skeleton-mana" />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}

function DeckDetailSkeleton() {
  return (
    <div className="stack-lg deck-detail-stack" aria-busy="true" aria-live="polite">
      <section className="panel decklist-panel">
        <div className="panel-head">
          <div className="deck-skeleton-head">
            <span className="skeleton-line skeleton-heading" />
            <span className="skeleton-line skeleton-subheading" />
          </div>
          <span className="skeleton-line skeleton-link" aria-hidden="true" />
        </div>

        <div className="stack-md">
          <div className="grid-cards deck-mainboard-skeleton-grid">
            {MAINBOARD_SKELETON_CATEGORY_ORDER.map((category) => (
              <DeckSectionSkeleton key={`main-skeleton-${category}`} rowCount={6} />
            ))}
          </div>
          <DeckSectionSkeleton rowCount={5} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="skeleton-line skeleton-heading-sm" aria-hidden="true" />
          <span className="skeleton-line skeleton-count" aria-hidden="true" />
        </div>
        <div className="table-wrap">
          <table className="data-table deck-matches-skeleton-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Event</th>
                <th>Opponent</th>
                <th>Result</th>
                <th>Turns</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, rowIndex) => (
                <tr key={`deck-match-skeleton-${rowIndex}`}>
                  <td>
                    <span className="skeleton-line skeleton-table-line" />
                  </td>
                  <td>
                    <span className="skeleton-line skeleton-table-line is-wide" />
                  </td>
                  <td>
                    <span className="skeleton-line skeleton-table-line is-wide" />
                  </td>
                  <td>
                    <span className="skeleton-line skeleton-table-line is-short" />
                  </td>
                  <td>
                    <span className="skeleton-line skeleton-table-line is-short" />
                  </td>
                  <td>
                    <span className="skeleton-line skeleton-table-line" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function DeckDetailPage() {
  const params = useParams();
  const deckId = Number(params.deckId);

  const { data, isLoading, error } = useQuery({
    queryKey: ["deck", deckId],
    queryFn: () => api.deckDetail(deckId),
    enabled: Number.isFinite(deckId),
  });

  const cards = useMemo(() => {
    return (data?.cards ?? []).map((card) => ({
      section: card.section,
      cardId: card.cardId,
      cardName: card.cardName,
      quantity: card.quantity,
    }));
  }, [data?.cards]);

  const mainboardCards = useMemo(() => {
    return cards.filter((card) => card.section === "main");
  }, [cards]);

  const mainCardPreviewQueries = useQueries({
    queries: mainboardCards.map((card) => ({
      queryKey: cardPreviewQueryKey(card),
      queryFn: () => fetchCardPreview(card.cardId, card.cardName),
      enabled: card.cardId > 0,
      staleTime: 1000 * 60 * 60 * 24,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 1,
    })),
  });

  const mainboardMetadataByCardID = useMemo(() => {
    const out = new Map<number, CardPreview>();
    for (let i = 0; i < mainboardCards.length; i += 1) {
      const card = mainboardCards[i];
      const preview = mainCardPreviewQueries[i]?.data;
      if (!preview) {
        continue;
      }
      out.set(card.cardId, preview);
    }
    return out;
  }, [mainboardCards, mainCardPreviewQueries]);

  const groupedMainboardCards = useMemo(() => {
    const byCategory: Record<MainboardCategory, MainboardDeckListCard[]> = {
      creatures: [],
      spells: [],
      artifacts: [],
      enchantments: [],
      lands: [],
    };

    for (const card of mainboardCards) {
      const metadata = mainboardMetadataByCardID.get(card.cardId);
      const category = classifyMainboardCard(metadata?.typeLine);
      byCategory[category].push({
        ...card,
        manaCost: metadata?.manaCost?.trim() ?? "",
        manaValue:
          typeof metadata?.manaValue === "number" && Number.isFinite(metadata.manaValue) ? metadata.manaValue : null,
      });
    }

    for (const category of MAINBOARD_CATEGORY_ORDER) {
      if (category === "lands") {
        byCategory[category].sort(compareLandCards);
      } else {
        byCategory[category].sort(compareMainboardCards);
      }
    }

    return byCategory;
  }, [mainboardCards, mainboardMetadataByCardID]);

  const nonMainSections = useMemo(() => {
    const bySection: Record<string, DeckListCard[]> = {};
    for (const card of cards) {
      if (card.section === "main") {
        continue;
      }
      if (!bySection[card.section]) {
        bySection[card.section] = [];
      }
      bySection[card.section].push(card);
    }

    for (const entries of Object.values(bySection)) {
      entries.sort((a, b) => cardDisplayName(a).localeCompare(cardDisplayName(b), undefined, { sensitivity: "base" }));
    }

    return bySection;
  }, [cards]);

  const sideboardCards = nonMainSections.sideboard ?? [];
  const auxiliarySections = useMemo(() => {
    return Object.entries(nonMainSections).filter(([section]) => section !== "sideboard");
  }, [nonMainSections]);

  const sideboardPreviewQueries = useQueries({
    queries: sideboardCards.map((card) => ({
      queryKey: cardPreviewQueryKey(card),
      queryFn: () => fetchCardPreview(card.cardId, card.cardName),
      enabled: card.cardId > 0,
      staleTime: 1000 * 60 * 60 * 24,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 1,
    })),
  });

  const sideboardMetadataByCardID = useMemo(() => {
    const out = new Map<number, CardPreview>();
    for (let i = 0; i < sideboardCards.length; i += 1) {
      const card = sideboardCards[i];
      const preview = sideboardPreviewQueries[i]?.data;
      if (!preview) {
        continue;
      }
      out.set(card.cardId, preview);
    }
    return out;
  }, [sideboardCards, sideboardPreviewQueries]);

  const enrichedSideboardCards = useMemo(() => {
    return sideboardCards.map((card): SideboardDeckListCard => {
      const metadata = sideboardMetadataByCardID.get(card.cardId);
      return {
        ...card,
        manaCost: metadata?.manaCost?.trim() ?? "",
      };
    });
  }, [sideboardCards, sideboardMetadataByCardID]);

  const isMainboardMetadataLoading = mainCardPreviewQueries.some((query) => query.isPending);
  const isSideboardMetadataLoading = sideboardPreviewQueries.some((query) => query.isPending);
  const isCardMetadataLoading = isMainboardMetadataLoading || isSideboardMetadataLoading;
  const mainboardSkeletonRows = clampSkeletonRows(Math.ceil(mainboardCards.length / MAINBOARD_CATEGORY_ORDER.length), 6);
  const sideboardSkeletonRows = clampSkeletonRows(sideboardCards.length, 5);

  if (!Number.isFinite(deckId)) return <p className="state error">Invalid deck id.</p>;
  if (isLoading) return <DeckDetailSkeleton />;
  if (error) return <p className="state error">{(error as Error).message}</p>;
  if (!data) return <p className="state">Deck not found.</p>;

  return (
    <div className="stack-lg deck-detail-stack">
      <section className="panel decklist-panel">
        <div className="panel-head">
          <div>
            <h3>{data.name || "Unnamed Deck"}</h3>
            <p>
              {data.format || "Unknown format"} • {data.eventName || "No event"}
            </p>
          </div>
          <Link className="text-link" to="/decks">
            Back to decks
          </Link>
        </div>

        <div className="stack-md">
          {isMainboardMetadataLoading ? (
            <div className="grid-cards deck-mainboard-skeleton-grid">
              {MAINBOARD_SKELETON_CATEGORY_ORDER.map((category) => (
                <DeckSectionSkeleton key={`main-loading-${category}`} rowCount={mainboardSkeletonRows} />
              ))}
            </div>
          ) : (
            <div className="grid-cards">
              {MAINBOARD_CATEGORY_ORDER.map((category) => {
                const categoryCards = groupedMainboardCards[category];
                if (categoryCards.length === 0) {
                  return null;
                }
                return (
                  <article className="deck-card" key={`main-${category}`}>
                    <h4>
                      {formatSectionLabel(category)} ({sectionTotal(categoryCards)})
                    </h4>
                    <ul>
                      {categoryCards.map((card) => (
                        <li key={`main-${category}-${card.cardId}`}>
                          <span className="deck-card-qty">{card.quantity}x</span>
                          <DeckCardPreviewName card={card} />
                          <span className="deck-card-mana">
                            <ManaCostDisplay manaCost={card.manaCost} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          )}

          {sideboardCards.length > 0 ? (
            isSideboardMetadataLoading ? (
              <DeckSectionSkeleton rowCount={sideboardSkeletonRows} />
            ) : (
              <article className="deck-card">
                <h4>
                  {formatSectionLabel("sideboard")} ({sectionTotal(enrichedSideboardCards)})
                </h4>
                <ul>
                  {enrichedSideboardCards.map((card) => (
                    <li key={`sideboard-${card.cardId}`}>
                      <span className="deck-card-qty">{card.quantity}x</span>
                      <DeckCardPreviewName card={card} placementMode="force-right" />
                      <span className="deck-card-mana">
                        <ManaCostDisplay manaCost={card.manaCost} />
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            )
          ) : null}

          {auxiliarySections.length > 0 ? (
            <div className="grid-cards">
              {auxiliarySections.map(([section, sectionCards]) => (
                <article className="deck-card" key={section}>
                  <h4>
                    {formatSectionLabel(section)} ({sectionTotal(sectionCards)})
                  </h4>
                  <ul>
                    {sectionCards.map((card) => (
                      <li key={`${section}-${card.cardId}`}>
                        <span className="deck-card-qty">{card.quantity}x</span>
                        <DeckCardPreviewName card={card} />
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          ) : null}
        </div>
        {isCardMetadataLoading ? (
          <p className="state">Loading deck mana/type details…</p>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Matches with this deck</h3>
          <p>{data.matches.length} matches</p>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Event</th>
                <th>Opponent</th>
                <th>Result</th>
                <th>Turns</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {data.matches.map((match) => (
                <tr key={match.id}>
                  <td>{formatDateTime(match.startedAt)}</td>
                  <td>{match.eventName || "-"}</td>
                  <td>{match.opponent || "-"}</td>
                  <td>
                    <ResultPill result={match.result} />
                  </td>
                  <td>{match.turnCount ?? "-"}</td>
                  <td>{formatDuration(match.secondsCount ?? undefined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
