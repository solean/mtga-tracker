import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";

export function DraftsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["drafts"],
    queryFn: api.drafts,
  });

  if (isLoading) return <p className="state">Loading drafts…</p>;
  if (error) return <p className="state error">{(error as Error).message}</p>;

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Draft Sessions</h3>
        <p>{data?.length ?? 0} sessions</p>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Event</th>
              <th>Mode</th>
              <th>Picks</th>
              <th>Started</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((draft) => (
              <tr key={draft.id}>
                <td>
                  <Link to={`/drafts/${draft.id}`} className="text-link">
                    {draft.id}
                  </Link>
                </td>
                <td>{draft.eventName || "-"}</td>
                <td>{draft.isBotDraft ? "Bot Draft" : "Player Draft"}</td>
                <td>{draft.picks}</td>
                <td>{formatDateTime(draft.startedAt)}</td>
                <td>{formatDateTime(draft.completedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
