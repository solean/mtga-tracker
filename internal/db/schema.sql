PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ingest_state (
  log_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  line_no INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_path TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  kind TEXT NOT NULL,
  method_name TEXT,
  request_id TEXT,
  payload_json TEXT,
  raw_text TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_raw_kind ON events_raw(kind);
CREATE INDEX IF NOT EXISTS idx_events_raw_method ON events_raw(method_name);

CREATE TABLE IF NOT EXISTS event_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT NOT NULL UNIQUE,
  event_type TEXT,
  entry_currency_type TEXT,
  entry_currency_paid INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT,
  ended_at TEXT,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arena_deck_id TEXT NOT NULL UNIQUE,
  event_name TEXT,
  name TEXT,
  format TEXT,
  source TEXT,
  last_updated TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decks_event_name ON decks(event_name);

CREATE TABLE IF NOT EXISTS deck_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id INTEGER NOT NULL,
  section TEXT NOT NULL,
  card_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deck_cards_deck_id ON deck_cards(deck_id);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arena_match_id TEXT NOT NULL UNIQUE,
  event_name TEXT,
  format TEXT,
  player_seat_id INTEGER,
  opponent_name TEXT,
  opponent_user_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  result TEXT,
  win_reason TEXT,
  turn_count INTEGER,
  seconds_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_event_name ON matches(event_name);
CREATE INDEX IF NOT EXISTS idx_matches_started_at ON matches(started_at);

CREATE TABLE IF NOT EXISTS match_decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  deck_id INTEGER NOT NULL,
  snapshot_reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(match_id, deck_id),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT,
  draft_id TEXT,
  is_bot_draft INTEGER NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(draft_id, is_bot_draft)
);

CREATE INDEX IF NOT EXISTS idx_draft_sessions_event_name ON draft_sessions(event_name);

CREATE TABLE IF NOT EXISTS draft_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_session_id INTEGER NOT NULL,
  pack_number INTEGER NOT NULL,
  pick_number INTEGER NOT NULL,
  picked_card_ids TEXT NOT NULL,
  pack_card_ids TEXT,
  pick_ts TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(draft_session_id, pack_number, pick_number),
  FOREIGN KEY(draft_session_id) REFERENCES draft_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_draft_picks_session ON draft_picks(draft_session_id);
