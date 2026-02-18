import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";

export function DraftDetailPage() {
  const params = useParams();
  const draftId = Number(params.draftId);

  const picksQuery = useQuery({
    queryKey: ["draft-picks", draftId],
    queryFn: () => api.draftPicks(draftId),
    enabled: Number.isFinite(draftId),
  });

  const picksByPack = useMemo(() => {
    const map = new Map<number, { pickNumber: number; pickedCardIds: string; packCardIds: string }[]>();
    for (const pick of picksQuery.data ?? []) {
      const existing = map.get(pick.packNumber) ?? [];
      existing.push({ pickNumber: pick.pickNumber, pickedCardIds: pick.pickedCardIds, packCardIds: pick.packCardIds });
      map.set(pick.packNumber, existing);
    }
    return map;
  }, [picksQuery.data]);

  if (!Number.isFinite(draftId)) return <p className="state error">Invalid draft id.</p>;
  if (picksQuery.isLoading) return <p className="state">Loading draft picks…</p>;
  if (picksQuery.error) return <p className="state error">{(picksQuery.error as Error).message}</p>;

  return (
    <div className="stack-lg">
      <section className="panel">
        <div className="panel-head">
          <h3>Draft Session #{draftId}</h3>
          <Link className="text-link" to="/drafts">
            Back to drafts
          </Link>
        </div>

        <div className="stack-md">
          {[...picksByPack.entries()].map(([pack, picks]) => (
            <article className="panel inner" key={pack}>
              <h4>Pack {pack + 1}</h4>
              <div className="table-wrap">
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th>Pick</th>
                      <th>Selected Card IDs</th>
                      <th>Pack Card IDs (when available)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {picks
                      .sort((a, b) => a.pickNumber - b.pickNumber)
                      .map((pick) => (
                        <tr key={`${pack}-${pick.pickNumber}`}>
                          <td>{pick.pickNumber + 1}</td>
                          <td>
                            <code>{pick.pickedCardIds}</code>
                          </td>
                          <td>
                            <code>{pick.packCardIds}</code>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
