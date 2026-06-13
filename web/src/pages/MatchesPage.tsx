import { Fragment, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type Row } from "@tanstack/react-table";

import { MatchDeckColors } from "../components/MatchDeckColors";
import { ManaSymbol } from "../components/ManaSymbol";
import { ResultPill } from "../components/ResultPill";
import { StatusMessage } from "../components/StatusMessage";
import { api } from "../lib/api";
import { formatCompactDateTime, formatDuration } from "../lib/format";
import type { Match } from "../lib/types";

const columnHelper = createColumnHelper<Match>();
const ROW_INTERACTIVE_SELECTOR =
  "a, button, input, select, textarea, summary, [role='button'], [role='link']";

const FILTER_COLORS = ["W", "U", "B", "R", "G"] as const;

const NO_DECK_LABEL = "No deck";

type MatchFilters = {
  opponent: string;
  event: string;
  deck: string;
  result: string;
  colors: string[];
  dateFrom: string;
  dateTo: string;
};

const EMPTY_FILTERS: MatchFilters = {
  opponent: "",
  event: "",
  deck: "",
  result: "",
  colors: [],
  dateFrom: "",
  dateTo: "",
};

function formatBestOf(value?: Match["bestOf"]): string {
  if (value === "bo3") return "Bo3";
  if (value === "bo1") return "Bo1";
  return "-";
}

function formatPlayDraw(value?: Match["playDraw"]): string {
  if (value === "play") return "Play";
  if (value === "draw") return "Draw";
  return "-";
}

function targetIsInteractive(target: EventTarget | null, currentTarget: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const interactiveTarget = target.closest(ROW_INTERACTIVE_SELECTOR);
  return interactiveTarget != null && interactiveTarget !== currentTarget;
}

function matchDeckLabel(match: Match): string {
  return match.deckName || (match.deckId ? `Deck ${match.deckId}` : NO_DECK_LABEL);
}

/**
 * Collapses Arena's per-run event names (QuickDraft_TMT_20260313,
 * FIN_Quick_Draft, ...) into stable categories so the Event filter stays
 * short no matter how many runs exist. Unrecognized names fall back to the
 * (prettified) raw name so they remain selectable.
 */
function eventCategory(eventName: string): string {
  const name = eventName.trim().toLowerCase().replace(/_/g, "");
  if (!name) return "Unknown";
  if (name.includes("quickdraft")) return "Quick Draft";
  if (name.includes("premierdraft")) return "Premier Draft";
  if (name.includes("traddraft") || name.includes("traditionaldraft")) return "Traditional Draft";
  if (name.includes("draft")) return "Other Draft";
  if (name.includes("tradsealed") || name.includes("traditionalsealed")) return "Traditional Sealed";
  if (name.includes("sealed")) return "Sealed";
  if (name.includes("jumpin")) return "Jump In";
  if (name.includes("tradladder") || name.includes("traditionalladder")) return "Traditional Ladder";
  if (name.includes("ladder")) return "Ranked Ladder";
  if (name.includes("midweek") || name.startsWith("mwm")) return "Midweek Magic";
  if (name.includes("brawl")) return "Brawl";
  if (name === "play") return "Play";
  return eventName.trim().replace(/_/g, " ");
}

function normalizedDeckColors(match: Match): string[] {
  if (!match.deckColorsKnown || !match.deckColors) return [];
  return match.deckColors.map((color) => color.trim().toUpperCase());
}

function matchStartedTime(match: Match): number {
  const time = Date.parse(match.startedAt);
  return Number.isFinite(time) ? time : 0;
}

function hasActiveFilters(filters: MatchFilters): boolean {
  return (
    filters.opponent.trim() !== "" ||
    filters.event !== "" ||
    filters.deck !== "" ||
    filters.result !== "" ||
    filters.colors.length > 0 ||
    filters.dateFrom !== "" ||
    filters.dateTo !== ""
  );
}

function applyFilters(matches: Match[], filters: MatchFilters): Match[] {
  const opponentQuery = filters.opponent.trim().toLowerCase();
  const fromTime = filters.dateFrom ? Date.parse(`${filters.dateFrom}T00:00:00`) : Number.NEGATIVE_INFINITY;
  const toTime = filters.dateTo ? Date.parse(`${filters.dateTo}T23:59:59.999`) : Number.POSITIVE_INFINITY;

  return matches.filter((match) => {
    if (opponentQuery && !match.opponent.toLowerCase().includes(opponentQuery)) return false;
    if (filters.event && eventCategory(match.eventName) !== filters.event) return false;
    if (filters.deck && matchDeckLabel(match) !== filters.deck) return false;
    if (filters.result && match.result !== filters.result) return false;
    if (filters.colors.length > 0) {
      const deckColors = normalizedDeckColors(match);
      if (!filters.colors.every((color) => deckColors.includes(color))) return false;
    }
    const startedTime = matchStartedTime(match);
    if (startedTime < fromTime || startedTime > toTime) return false;
    return true;
  });
}

type MatchRecord = {
  wins: number;
  losses: number;
  unknown: number;
};

function tallyRecord(matches: Match[]): MatchRecord {
  const record: MatchRecord = { wins: 0, losses: 0, unknown: 0 };
  for (const match of matches) {
    if (match.result === "win") record.wins += 1;
    else if (match.result === "loss") record.losses += 1;
    else record.unknown += 1;
  }
  return record;
}

function formatRecord(record: MatchRecord): string {
  return `${record.wins}-${record.losses}`;
}

function formatWinRate(record: MatchRecord): string {
  const decided = record.wins + record.losses;
  if (decided === 0) return "-";
  return `${Math.round((record.wins / decided) * 100)}%`;
}

/**
 * Groups rows by consecutive event name (the list is sorted newest-first, so
 * a run of the same event reads as one session, e.g. a draft run).
 */
function groupRowsByEvent(rows: Row<Match>[]): { eventName: string; rows: Row<Match>[] }[] {
  const groups: { eventName: string; rows: Row<Match>[] }[] = [];
  for (const row of rows) {
    const eventName = row.original.eventName || "Unknown event";
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.eventName === eventName) {
      lastGroup.rows.push(row);
    } else {
      groups.push({ eventName, rows: [row] });
    }
  }
  return groups;
}

export function MatchesPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ["matches"],
    queryFn: () => api.matches(1000),
  });

  const [filters, setFilters] = useState<MatchFilters>(EMPTY_FILTERS);
  const [groupByEvent, setGroupByEvent] = useState(true);

  const matches = useMemo(() => data ?? [], [data]);

  const eventOptions = useMemo(
    () => [...new Set(matches.map((match) => eventCategory(match.eventName)))].sort(),
    [matches],
  );
  const deckOptions = useMemo(
    () => [...new Set(matches.map(matchDeckLabel))].sort(),
    [matches],
  );

  const filtered = useMemo(() => applyFilters(matches, filters), [matches, filters]);
  const filteredRecord = useMemo(() => tallyRecord(filtered), [filtered]);

  function updateFilters(patch: Partial<MatchFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function toggleColor(color: string) {
    setFilters((current) => ({
      ...current,
      colors: current.colors.includes(color)
        ? current.colors.filter((value) => value !== color)
        : [...current.colors, color],
    }));
  }

  const columns = useMemo(
    () => [
      columnHelper.accessor("startedAt", {
        header: "Started",
        cell: (info) => formatCompactDateTime(info.getValue()),
      }),
      columnHelper.accessor("eventName", {
        header: "Event",
      }),
      columnHelper.accessor("bestOf", {
        header: "Best Of",
        cell: (info) => formatBestOf(info.getValue()),
      }),
      columnHelper.accessor("playDraw", {
        header: "G1",
        cell: (info) => formatPlayDraw(info.getValue()),
      }),
      columnHelper.accessor("opponent", {
        header: "Opponent",
        cell: (info) => info.getValue() || "Unknown",
      }),
      columnHelper.accessor("result", {
        header: "Result",
        cell: (info) => <ResultPill result={info.getValue()} />,
      }),
      columnHelper.accessor("turnCount", {
        header: "Turns",
        cell: (info) => info.getValue() ?? "-",
      }),
      columnHelper.accessor("secondsCount", {
        header: "Duration",
        cell: (info) => formatDuration(info.getValue()),
      }),
      columnHelper.accessor("deckName", {
        header: "Deck",
        cell: (info) => {
          const deckId = info.row.original.deckId;
          const deckName = info.getValue();
          const label = deckName || (deckId ? `Deck ${deckId}` : "-");
          if (!deckId) return label;
          return (
            <Link className="text-link" to={`/decks/${deckId}`}>
              {label}
            </Link>
          );
        },
      }),
      columnHelper.display({
        id: "deckColors",
        header: "Colors",
        cell: (info) => (
          <MatchDeckColors
            className="match-deck-colors-table"
            deckColors={info.row.original.deckColors}
            deckColorsKnown={info.row.original.deckColorsKnown}
            opponentDeckColors={info.row.original.opponentDeckColors}
            opponentDeckColorsKnown={info.row.original.opponentDeckColorsKnown}
          />
        ),
      }),
      columnHelper.accessor("winReason", {
        header: "Reason",
        cell: (info) => info.getValue() || "-",
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  function openMatchDetails(matchId: Match["id"], newTab = false) {
    const href = `/matches/${matchId}`;
    if (newTab) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    navigate(href);
  }

  function handleRowClick(event: MouseEvent<HTMLTableRowElement>, matchId: Match["id"]) {
    if (event.defaultPrevented || targetIsInteractive(event.target, event.currentTarget)) return;
    openMatchDetails(matchId, event.metaKey || event.ctrlKey);
  }

  function handleRowAuxClick(event: MouseEvent<HTMLTableRowElement>, matchId: Match["id"]) {
    if (
      event.defaultPrevented ||
      targetIsInteractive(event.target, event.currentTarget) ||
      event.button !== 1
    ) {
      return;
    }
    openMatchDetails(matchId, true);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, matchId: Match["id"]) {
    if (event.defaultPrevented || targetIsInteractive(event.target, event.currentTarget)) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openMatchDetails(matchId);
  }

  if (isLoading) return <StatusMessage>Loading matches…</StatusMessage>;
  if (error) return <StatusMessage tone="error">{(error as Error).message}</StatusMessage>;

  const filtersActive = hasActiveFilters(filters);
  const rows = table.getRowModel().rows;
  const summary = filtersActive
    ? `${filtered.length} of ${matches.length} matches • ${formatRecord(filteredRecord)} (${formatWinRate(filteredRecord)})`
    : `${matches.length} matches • ${formatRecord(filteredRecord)} (${formatWinRate(filteredRecord)})`;

  function renderRow(row: Row<Match>) {
    return (
      <tr
        key={row.id}
        className="data-table-row-link"
        onClick={(event) => handleRowClick(event, row.original.id)}
        onAuxClick={(event) => handleRowAuxClick(event, row.original.id)}
        onKeyDown={(event) => handleRowKeyDown(event, row.original.id)}
        role="link"
        tabIndex={0}
      >
        {row.getVisibleCells().map((cell) => (
          <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
        ))}
      </tr>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Match History</h3>
        <p>{summary}</p>
      </div>

      <div className="match-filter-bar" aria-label="Match filters">
        <label className="match-filter-field match-filter-search">
          <span>Opponent</span>
          <input
            className="settings-input"
            type="search"
            value={filters.opponent}
            onChange={(event) => updateFilters({ opponent: event.target.value })}
            placeholder="Search opponent…"
            spellCheck={false}
          />
        </label>

        <label className="match-filter-field">
          <span>Event</span>
          <select
            className="settings-input"
            value={filters.event}
            onChange={(event) => updateFilters({ event: event.target.value })}
          >
            <option value="">All events</option>
            {eventOptions.map((eventName) => (
              <option key={eventName} value={eventName}>
                {eventName}
              </option>
            ))}
          </select>
        </label>

        <label className="match-filter-field">
          <span>Deck</span>
          <select
            className="settings-input"
            value={filters.deck}
            onChange={(event) => updateFilters({ deck: event.target.value })}
          >
            <option value="">All decks</option>
            {deckOptions.map((deck) => (
              <option key={deck} value={deck}>
                {deck}
              </option>
            ))}
          </select>
        </label>

        <label className="match-filter-field">
          <span>Result</span>
          <select
            className="settings-input"
            value={filters.result}
            onChange={(event) => updateFilters({ result: event.target.value })}
          >
            <option value="">All results</option>
            <option value="win">Win</option>
            <option value="loss">Loss</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>

        <div className="match-filter-field">
          <span>Your Colors</span>
          <div className="match-filter-colors" role="group" aria-label="Filter by deck colors">
            {FILTER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`match-filter-color-chip${filters.colors.includes(color) ? " is-active" : ""}`}
                aria-pressed={filters.colors.includes(color)}
                onClick={() => toggleColor(color)}
              >
                <ManaSymbol token={color} />
              </button>
            ))}
          </div>
        </div>

        <label className="match-filter-field">
          <span>From</span>
          <input
            className="settings-input"
            type="date"
            value={filters.dateFrom}
            onChange={(event) => updateFilters({ dateFrom: event.target.value })}
          />
        </label>

        <label className="match-filter-field">
          <span>To</span>
          <input
            className="settings-input"
            type="date"
            value={filters.dateTo}
            onChange={(event) => updateFilters({ dateTo: event.target.value })}
          />
        </label>

        <div className="match-filter-actions">
          <button
            type="button"
            className={`control-button match-filter-toggle${groupByEvent ? " is-active" : ""}`}
            aria-pressed={groupByEvent}
            onClick={() => setGroupByEvent((current) => !current)}
          >
            Group by Event
          </button>
          <button
            type="button"
            className="control-button"
            onClick={() => setFilters(EMPTY_FILTERS)}
            disabled={!filtersActive}
          >
            Clear Filters
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id}>
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <span className="match-filter-empty">No matches found for the current filters.</span>
                </td>
              </tr>
            ) : groupByEvent ? (
              groupRowsByEvent(rows).map((group, index) => {
                const record = tallyRecord(group.rows.map((row) => row.original));
                return (
                  <Fragment key={`${group.eventName}-${index}`}>
                    <tr className="match-group-row">
                      <td colSpan={columns.length}>
                        <span className="match-group-name">{group.eventName}</span>
                        <span className="match-group-record">
                          {formatRecord(record)}
                          {record.unknown > 0 ? ` (+${record.unknown}?)` : ""}
                        </span>
                        <span className="match-group-count">
                          {group.rows.length} {group.rows.length === 1 ? "match" : "matches"}
                        </span>
                      </td>
                    </tr>
                    {group.rows.map(renderRow)}
                  </Fragment>
                );
              })
            ) : (
              rows.map(renderRow)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
