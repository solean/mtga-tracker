export type Match = {
  id: number;
  arenaMatchId: string;
  eventName: string;
  opponent: string;
  startedAt: string;
  endedAt: string;
  result: "win" | "loss" | "unknown";
  winReason: string;
  turnCount?: number | null;
  secondsCount?: number | null;
  deckId?: number | null;
  deckName?: string | null;
};

export type Overview = {
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number;
  recent: Match[];
};

export type DeckSummary = {
  deckId: number;
  deckName: string;
  format: string;
  eventName: string;
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
};

export type DeckCard = {
  section: string;
  cardId: number;
  quantity: number;
  cardName?: string;
};

export type DeckDetail = {
  deckId: number;
  arenaDeckId: string;
  name: string;
  format: string;
  eventName: string;
  cards: DeckCard[];
  matches: Match[];
};

export type DraftSession = {
  id: number;
  eventName: string;
  draftId?: string | null;
  isBotDraft: boolean;
  startedAt: string;
  completedAt: string;
  picks: number;
};

export type DraftPick = {
  id: number;
  packNumber: number;
  pickNumber: number;
  pickedCardIds: string;
  packCardIds: string;
  pickTs: string;
};
