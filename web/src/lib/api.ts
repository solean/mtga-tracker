import type { DeckDetail, DeckSummary, DraftPick, DraftSession, Match, MatchDetail, Overview } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  overview: () => getJSON<Overview>("/api/overview"),
  matches: (limit = 500) => getJSON<Match[]>(`/api/matches?limit=${limit}`),
  matchDetail: (matchId: number) => getJSON<MatchDetail>(`/api/matches/${matchId}`),
  decks: (scope: "constructed" | "draft" | "all" = "constructed") =>
    getJSON<DeckSummary[]>(scope === "constructed" ? "/api/decks" : `/api/decks?scope=${scope}`),
  deckDetail: (deckId: number) => getJSON<DeckDetail>(`/api/decks/${deckId}`),
  drafts: () => getJSON<DraftSession[]>("/api/drafts"),
  draftPicks: (draftId: number) => getJSON<DraftPick[]>(`/api/drafts/${draftId}/picks`),
};
