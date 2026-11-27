CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot INTEGER NOT NULL UNIQUE CHECK (slot IN (1,2)),   -- hanya dua profil
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  pin_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE game_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_code TEXT NOT NULL UNIQUE,
  player_white INTEGER NOT NULL REFERENCES players(id),
  player_black INTEGER NOT NULL REFERENCES players(id),
  created_by INTEGER NOT NULL REFERENCES players(id),
  winner INTEGER REFERENCES players(id),
  status TEXT NOT NULL CHECK (status IN ('waiting','active','completed','abandoned')),
  result_type TEXT CHECK (result_type IN ('white_win','black_win','draw','abandoned')),
  end_reason TEXT,
  draw_offer_by INTEGER REFERENCES players(id),
  abandon_offer_by INTEGER REFERENCES players(id),
  ruleset_version TEXT NOT NULL,
  starting_fen TEXT NOT NULL,
  current_fen TEXT NOT NULL,
  final_fen TEXT,
  total_moves INTEGER,
  total_dice_rolls INTEGER,
  started_at TEXT,
  finished_at TEXT,
  duration_seconds INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (player_white <> player_black),
  CHECK (winner IS NULL OR winner IN (player_white, player_black))
);
-- paling banyak satu pertandingan terbuka
CREATE UNIQUE INDEX one_open_game ON game_sessions ((1)) WHERE status IN ('waiting','active');
CREATE INDEX games_finished ON game_sessions (status, finished_at);

CREATE TABLE game_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  player_color TEXT NOT NULL CHECK (player_color IN ('w','b')),
  status TEXT NOT NULL CHECK (status IN ('awaiting_roll','moving','completed','passed','interrupted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (game_id, turn_number),
  UNIQUE (id, game_id)
);
CREATE TABLE dice_rolls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  turn_id INTEGER NOT NULL UNIQUE,
  player_id INTEGER NOT NULL REFERENCES players(id),
  roll_number INTEGER NOT NULL,
  dice_values TEXT NOT NULL CHECK (json_valid(dice_values)),
  available_pieces TEXT NOT NULL CHECK (json_valid(available_pieces)),
  selected_piece TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(selected_piece)),
  is_used INTEGER NOT NULL DEFAULT 0 CHECK (is_used IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (game_id, roll_number),
  UNIQUE (id, turn_id),
  FOREIGN KEY (turn_id, game_id) REFERENCES game_turns(id, game_id) ON DELETE CASCADE
);
CREATE TABLE game_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  turn_id INTEGER NOT NULL,
  dice_roll_id INTEGER,
  die_indexes TEXT NOT NULL CHECK (json_valid(die_indexes)),
  move_number INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  player_color TEXT NOT NULL CHECK (player_color IN ('w','b')),
  piece_type TEXT NOT NULL,
  from_square TEXT NOT NULL,
  to_square TEXT NOT NULL,
  move_uci TEXT NOT NULL,
  move_san TEXT NOT NULL,
  captured_piece TEXT,
  promotion TEXT,
  fen_before TEXT NOT NULL,
  fen_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (game_id, move_number),
  FOREIGN KEY (turn_id, game_id) REFERENCES game_turns(id, game_id) ON DELETE CASCADE,
  FOREIGN KEY (dice_roll_id, turn_id) REFERENCES dice_rolls(id, turn_id) ON DELETE CASCADE
);
-- riwayat tidak boleh diubah
CREATE TRIGGER moves_immutable BEFORE UPDATE ON game_moves
BEGIN SELECT RAISE(ABORT, 'move history is immutable'); END;
CREATE TRIGGER finished_game_immutable BEFORE UPDATE ON game_sessions
WHEN OLD.status IN ('completed','abandoned')
BEGIN SELECT RAISE(ABORT, 'finished games are immutable'); END;
CREATE TRIGGER dice_values_immutable BEFORE UPDATE OF dice_values ON dice_rolls
BEGIN SELECT RAISE(ABORT, 'dice values are immutable'); END;
