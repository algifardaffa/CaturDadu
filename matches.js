import { randomInt, randomBytes } from 'node:crypto';
import { now, transaction } from './db.js';
import { check } from './errors.js';
import * as E from './engine.js';

export const secureDice = () => [randomInt(1, 7), randomInt(1, 7), randomInt(1, 7)];

const getGame = (db, id) => {
  const g = db.prepare('SELECT * FROM game_sessions WHERE id=?').get(Number(id));
  check(g, 'Pertandingan tidak ditemukan.', 404);
  return g;
};
const openTurn = (db, gameId) => db.prepare(
  "SELECT * FROM game_turns WHERE game_id=? AND status IN ('awaiting_roll','moving')").get(gameId);
const rollOf = (db, turnId) => db.prepare('SELECT * FROM dice_rolls WHERE turn_id=?').get(turnId);
const usedDice = (db, turnId) => db.prepare('SELECT die_indexes FROM game_moves WHERE turn_id=?')
  .all(turnId).flatMap(r => JSON.parse(r.die_indexes));

function newTurn(db, game, color) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM game_turns WHERE game_id=?').get(game.id).n + 1;
  db.prepare(`INSERT INTO game_turns (game_id, turn_number, player_id, player_color, status, started_at)
    VALUES (?,?,?,?, 'awaiting_roll', ?)`)
    .run(game.id, n, color === 'w' ? game.player_white : game.player_black, color, now());
}

export function createMatch(db, me, { color }) {
  check(['w', 'b', 'random'].includes(color), 'Pilihan warna tidak valid.');
  return transaction(db, () => {
    const other = db.prepare('SELECT id FROM players WHERE id<>?').get(me);
    check(other, 'Profil belum lengkap.');
    check(!db.prepare("SELECT 1 FROM game_sessions WHERE status IN ('waiting','active')").get(),
      'Masih ada pertandingan yang belum selesai.', 409);
    const mine = color === 'random' ? (randomInt(2) ? 'w' : 'b') : color;
    const [white, black] = mine === 'w' ? [me, other.id] : [other.id, me];
    const t = now();
    return Number(db.prepare(`INSERT INTO game_sessions
      (game_code, player_white, player_black, created_by, status, ruleset_version,
       starting_fen, current_fen, created_at, updated_at)
      VALUES (?,?,?,?, 'waiting', ?,?,?,?,?)`)
      .run('DC-' + randomBytes(4).toString('hex').toUpperCase(), white, black, me,
        E.RULESET, E.START_FEN, E.START_FEN, t, t).lastInsertRowid);
  });
}

function finish(db, game, { result, reason, fen }) {
  const t = now();
  const status = result === 'abandoned' ? 'abandoned' : 'completed';
  const winner = result === 'white_win' ? game.player_white : result === 'black_win' ? game.player_black : null;
  db.prepare(`UPDATE game_turns SET status='interrupted', finished_at=?
    WHERE game_id=? AND status IN ('awaiting_roll','moving')`).run(t, game.id);
  const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE game_id=?`).get(game.id).n;
  const duration = game.started_at ? Math.round((Date.parse(t) - Date.parse(game.started_at)) / 1000) : 0;
  db.prepare(`UPDATE game_sessions SET status=?, result_type=?, end_reason=?, winner=?, current_fen=?,
    final_fen=?, total_moves=?, total_dice_rolls=?, finished_at=?, duration_seconds=?,
    draw_offer_by=NULL, abandon_offer_by=NULL, updated_at=? WHERE id=?`)
    .run(status, result, reason, winner, fen, fen, count('game_moves'), count('dice_rolls'), t, duration, t, game.id);
}

// Satu pintu untuk semua aksi pemain; semuanya atomik.
export function act(db, me, gameId, action, body = {}, rollDice = secureDice) {
  return transaction(db, () => {
    const game = getGame(db, gameId);
    check(me === game.player_white || me === game.player_black, 'Bukan pertandinganmu.', 403);
    check(game.status === 'waiting' || game.status === 'active', 'Pertandingan sudah selesai.', 409);
    const set = (sql, ...args) => db.prepare(`UPDATE game_sessions SET ${sql}, updated_at=? WHERE id=?`)
      .run(...args, now(), game.id);

    if (action === 'accept') {
      check(game.status === 'waiting' && me !== game.created_by, 'Menunggu konfirmasi lawan.', 409);
      set("status='active', started_at=?", now());
      return newTurn(db, game, 'w');
    }
    if (action === 'cancel') {
      check(game.status === 'waiting', 'Pertandingan sudah dimulai.', 409);
      return finish(db, game, { result: 'abandoned', reason: 'cancelled', fen: game.current_fen });
    }
    check(game.status === 'active', 'Pertandingan belum dimulai.', 409);
    const fen = game.current_fen;

    if (action === 'resign')
      return finish(db, game, { fen, reason: 'resignation',
        result: me === game.player_white ? 'black_win' : 'white_win' });

    // Remis dan penghentian pertandingan butuh persetujuan kedua pemain.
    if (action === 'draw' || action === 'abandon') {
      const column = action === 'draw' ? 'draw_offer_by' : 'abandon_offer_by';
      if (game[column] && game[column] !== me)
        return finish(db, game, action === 'draw'
          ? { fen, result: 'draw', reason: 'agreement' }
          : { fen, result: 'abandoned', reason: 'mutual_abandon' });
      return set(`${column}=?`, me);
    }
    if (action === 'decline') return set('draw_offer_by=NULL, abandon_offer_by=NULL');

    const turn = openTurn(db, game.id);
    check(turn.player_id === me, 'Bukan giliranmu.', 409);
    let state = E.parseFen(fen);

    const closeTurn = (status) => {
      db.prepare('UPDATE game_turns SET status=?, finished_at=? WHERE id=?').run(status, now(), turn.id);
      const progress = db.prepare(`SELECT 1 FROM game_moves WHERE turn_id=?
        AND (piece_type='p' OR captured_piece IS NOT NULL)`).get(turn.id);
      state = E.endTurn(state, !!progress);
      const next = E.toFen(state);
      if (state.quiet >= E.QUIET_LIMIT) return finish(db, game, { fen: next, result: 'draw', reason: 'turn_limit' });
      set('current_fen=?', next);
      newTurn(db, game, state.turn);
    };

    if (action === 'roll') {
      check(turn.status === 'awaiting_roll', 'Dadu sudah dikocok.', 409);
      const dice = rollDice();
      const moves = E.legalMoves(state, dice);
      const number = db.prepare('SELECT COUNT(*) AS n FROM dice_rolls WHERE game_id=?').get(game.id).n + 1;
      db.prepare(`INSERT INTO dice_rolls
        (game_id, turn_id, player_id, roll_number, dice_values, available_pieces, created_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(game.id, turn.id, me, number, JSON.stringify(dice),
          JSON.stringify([...new Set(moves.map(m => m.piece))]), now());
      if (!moves.length) return closeTurn('passed');
      return db.prepare("UPDATE game_turns SET status='moving' WHERE id=?").run(turn.id);
    }

    check(action === 'move', 'Aksi tidak dikenal.', 404);
    check(turn.status === 'moving', 'Kocok dadu dulu.', 409);
    const roll = rollOf(db, turn.id), dice = JSON.parse(roll.dice_values);
    const used = usedDice(db, turn.id);
    const free = dice.map((value, index) => ({ value, index })).filter(d => !used.includes(d.index));
    const move = E.legalMoves(state, free.map(d => d.value)).find(m => E.uci(m) === body.uci);
    check(move, 'Gerakan tidak legal.', 422);
    const indexes = move.dice.map(i => free[i].index);
    const after = E.applyMove(state, move);
    const number = db.prepare('SELECT COUNT(*) AS n FROM game_moves WHERE game_id=?').get(game.id).n + 1;
    db.prepare(`INSERT INTO game_moves (game_id, turn_id, dice_roll_id, die_indexes, move_number, player_id,
      player_color, piece_type, from_square, to_square, move_uci, move_san, captured_piece, promotion,
      fen_before, fen_after, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(game.id, turn.id, roll.id, JSON.stringify(indexes), number, me, state.turn, move.piece,
        E.squareName(move.from), E.squareName(move.to), E.uci(move), E.notation(move), move.captured,
        move.promo || null, fen, E.toFen(after), now());
    const pieces = JSON.parse(roll.selected_piece).concat(indexes.map(i => E.DIE_PIECE[dice[i]]));
    db.prepare('UPDATE dice_rolls SET selected_piece=?, is_used=1 WHERE id=?').run(JSON.stringify(pieces), roll.id);
    state = after;
    set('current_fen=?, draw_offer_by=NULL', E.toFen(state));

    const won = move.captured === 'k';
    if (won || E.bareKings(state)) {
      db.prepare("UPDATE game_turns SET status='completed', finished_at=? WHERE id=?").run(now(), turn.id);
      return finish(db, game, { fen: E.toFen(state),
        reason: won ? 'king_captured' : 'bare_kings',
        result: won ? (state.turn === 'w' ? 'white_win' : 'black_win') : 'draw' });
    }
    const rest = free.filter(d => !indexes.includes(d.index)).map(d => d.value);
    if (!rest.length || !E.legalMoves(state, rest).length) closeTurn('completed');
  });
}

export function listGames(db, { filter = 'all', sort = 'newest', page = 1 } = {}) {
  const [p1, p2] = db.prepare('SELECT id FROM players ORDER BY slot').all().map(p => p.id);
  const where = {
    all: ['1=1'], p1: ['winner=?', p1], p2: ['winner=?', p2],
    draw: ["result_type='draw'"], abandoned: ["status='abandoned'"],
  }[filter];
  const order = {
    newest: 'finished_at DESC, id DESC', oldest: 'finished_at ASC, id ASC',
    longest: 'duration_seconds DESC, id DESC', shortest: 'duration_seconds ASC, id ASC',
  }[sort];
  check(where && order, 'Filter tidak valid.');
  const [cond, ...args] = where;
  const base = `FROM game_sessions WHERE status IN ('completed','abandoned') AND ${cond}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args).n;
  const size = 8, pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const games = db.prepare(`SELECT * ${base} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, size, (current - 1) * size);
  return { games, total, page: current, pages };
}

export function gameDetail(db, id) {
  const game = getGame(db, id);
  const turns = db.prepare('SELECT * FROM game_turns WHERE game_id=? ORDER BY turn_number').all(game.id);
  const rolls = db.prepare('SELECT * FROM dice_rolls WHERE game_id=? ORDER BY roll_number').all(game.id)
    .map(r => ({ ...r, dice_values: JSON.parse(r.dice_values),
      available_pieces: JSON.parse(r.available_pieces), selected_piece: JSON.parse(r.selected_piece) }));
  const moves = db.prepare('SELECT * FROM game_moves WHERE game_id=? ORDER BY move_number').all(game.id)
    .map(m => ({ ...m, die_indexes: JSON.parse(m.die_indexes) }));
  return { game, turns, rolls, moves };
}

// Keadaan pertandingan terbuka, termasuk gerakan legal yang dihitung server.
export function liveState(db, me) {
  const open = db.prepare("SELECT id FROM game_sessions WHERE status IN ('waiting','active')").get();
  if (!open) return null;
  const detail = gameDetail(db, open.id);
  const turn = openTurn(db, open.id) || null;
  let roll = null, used = [], legal = [];
  if (turn?.status === 'moving') {
    roll = detail.rolls.find(r => r.turn_id === turn.id);
    used = usedDice(db, turn.id);
    if (turn.player_id === me) {
      const rest = roll.dice_values.filter((_, i) => !used.includes(i));
      legal = E.legalMoves(E.parseFen(detail.game.current_fen), rest)
        .map(m => ({ uci: E.uci(m), from: E.squareName(m.from), to: E.squareName(m.to), promo: m.promo || null }));
    }
  }
  return { ...detail, turn, roll, used, legal };
}
