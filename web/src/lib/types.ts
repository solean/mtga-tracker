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

export type OpponentObservedCard = {
  cardId: number;
  quantity: number;
  cardName?: string;
};

export type MatchCardPlay = {
  id: number;
  gameNumber?: number;
  instanceId: number;
  cardId: number;
  cardName?: string;
  ownerSeatId?: number;
  playerSide: "self" | "opponent" | "unknown";
  firstPublicZone: string;
  turnNumber?: number;
  phase?: string;
  playedAt?: string;
};

export type MatchReplayChange = {
  instanceId: number;
  cardId: number;
  cardName?: string;
  ownerSeatId?: number;
  playerSide: "self" | "opponent" | "unknown";
  action: string;
  fromZoneId?: number;
  fromZoneType?: string;
  fromZonePosition?: number;
  toZoneId?: number;
  toZoneType?: string;
  toZonePosition?: number;
  isToken: boolean;
};

export type MatchReplayFrameObject = {
  id: number;
  frameId: number;
  instanceId: number;
  cardId: number;
  cardName?: string;
  ownerSeatId?: number;
  controllerSeatId?: number;
  playerSide: "self" | "opponent" | "unknown";
  zoneId?: number;
  zoneType: string;
  zonePosition?: number;
  visibility?: string;
  power?: number;
  toughness?: number;
  attackTargetId?: number;
  blockAttackerIdsJson?: string;
  counterSummaryJson?: string;
  detailsJson?: string;
  attackState?: string;
  blockState?: string;
  isToken: boolean;
  isTapped: boolean;
  hasSummoningSickness: boolean;
};

export type MatchReplayFrame = {
  id: number;
  gameNumber?: number;
  gameStateId?: number;
  prevGameStateId?: number;
  gameStateType?: string;
  turnNumber?: number;
  phase?: string;
  selfLifeTotal?: number;
  opponentLifeTotal?: number;
  recordedAt?: string;
  actionsJson?: string;
  annotationsJson?: string;
  objects?: MatchReplayFrameObject[];
  changes?: MatchReplayChange[];
};

export type MatchDetail = {
  match: Match;
  opponentObservedCards: OpponentObservedCard[];
  cardPlays: MatchCardPlay[];
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
  pickedCards?: DraftPickCard[];
  packCards?: DraftPickCard[];
};

export type DraftPickCard = {
  cardId: number;
  cardName?: string;
};
