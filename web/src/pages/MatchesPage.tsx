import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";

import { ResultPill } from "../components/ResultPill";
import { api } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";
import type { Match } from "../lib/types";

const columnHelper = createColumnHelper<Match>();

export function MatchesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["matches"],
    queryFn: () => api.matches(1000),
  });

  const columns = useMemo(
    () => [
      columnHelper.accessor("startedAt", {
        header: "Started",
        cell: (info) => formatDateTime(info.getValue()),
      }),
      columnHelper.accessor("eventName", {
        header: "Event",
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
      columnHelper.accessor("winReason", {
        header: "Reason",
        cell: (info) => info.getValue() || "-",
      }),
      columnHelper.display({
        id: "details",
        header: "Details",
        cell: (info) => (
          <Link className="text-link" to={`/matches/${info.row.original.id}`}>
            View
          </Link>
        ),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (isLoading) return <p className="state">Loading matches…</p>;
  if (error) return <p className="state error">{(error as Error).message}</p>;

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Match History</h3>
        <p>{data?.length ?? 0} matches</p>
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
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
