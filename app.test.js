import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as E from '../src/engine.js';
import { openDb, transaction } from '../src/db.js';
import * as P from '../src/players.js';
import * as M from '../src/matches.js';
import { statistics } from '../src/stats.js';
import { createApp } from '../server.js';

const moves = (fen, dice) => E.legalMoves(E.parseFen(fen), dice).map(E.uci).sort();

test('engine: posisi awal dan pemetaan dadu', () => {
  assert.equal(E.toFen(E.parseFen(E.START_FEN)), E.START_FEN);
  assert.equal(moves(E.START_FEN, [2]).length, 4);
  assert.equal(moves(E.START_FEN, [1]).length, 16);
  for (const d of [3, 4, 5, 6]) assert.deepEqual(moves(E.START_FEN, [d]), []);
});

test('engine: wajib memakai dadu sebanyak mungkin', () => {
  // Gajah hanya bisa dipakai setelah pion d/e/b/g membuka jalan.
  assert.deepEqual([...new Set(moves(E.START_FEN, [1, 3]).map(u => u[0]))].sort(), ['b', 'd', 'e', 'g']);
});

test('engine: memakan raja selalu boleh, tidak ada aturan skak', () => {
  assert.ok(moves('4k3/8/8/8/8/8/8/K3R3 w - - 0 1', [4, 6, 6]).includes('e1e8'));
  assert.ok(moves('4r3/8/8/8/8/8/8/3K3k w - - 0 1', [6]).includes('d1e1'));
});

test('engine: rokade butuh dadu raja dan benteng', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  assert.ok(!moves(fen, [6]).includes('e1g1'));
  const castle = E.legalMoves(E.parseFen(fen), [6, 4]).find(m => E.uci(m) === 'e1g1');
  assert.deepEqual(castle.dice, [0, 1]);
  assert.match(E.toFen(E.applyMove(E.parseFen(fen), castle)), /R4RK1 w kq/);
});

test('engine: en passant dan promosi', () => {
  let s = E.parseFen('4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1');
  s = E.endTurn(E.applyMove(s, E.legalMoves(s, [1]).find(m => E.uci(m) === 'd7d5')), true);
  const ep = E.legalMoves(s, [1]).find(m => E.uci(m) === 'e5d6');
  assert.ok(ep.enPassant);
  assert.equal(E.applyMove(s, ep).board[E.squareIndex('d5')], null);
  assert.deepEqual(E.endTurn(s, false).ep, []);
  assert.deepEqual(moves('8/P6k/8/8/8/8/8/7K w - - 0 1', [1]), ['a7a8b', 'a7a8n', 'a7a8q', 'a7a8r']);
});

test('dadu: rentang 1-6 dan semua muka muncul', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) M.secureDice().forEach(d => seen.add(d));
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6]);
});

function setup(file = ':memory:') {
  const db = openDb(file);
  const code = P.accessCode(db);
  const input = { code, pin: '111111', players: [
    { displayName: 'Satu', avatar: '♔' }, { displayName: 'Dua', avatar: '♘' }] };
  P.initialize(db, input);
  const [a, b] = P.publicPlayers(db).map(p => p.id);
  P.login(db, { playerId: b, pin: '222222', code });
  return { db, a, b, input };
}
function start(db, a, b) {
  const id = M.createMatch(db, a, { color: 'w' });
  M.act(db, b, id, 'accept');
  return id;
}
// a (putih) memainkan Kuda b1-c3-d5, lalu memakan raja hitam.
function playToKingCapture(db, a, b, id) {
  const turn = (who, dice, list) => {
    M.act(db, who, id, 'roll', {}, () => dice);
    for (const uci of list) M.act(db, who, id, 'move', { uci });
  };
  turn(a, [2, 2, 2], ['b1c3', 'c3d5', 'd5f6']);
  turn(b, [4, 4, 4], []); // tidak ada langkah legal
  turn(a, [2, 6, 6], ['f6e8']);
}

test('profil: tepat dua, persisten, nama bisa diganti', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dc-')), 'x.db');
  const { db, a, b, input } = setup(file);
  assert.throws(() => P.initialize(db, input), /sudah dibuat/);
  assert.throws(() => db.prepare(`INSERT INTO players (slot,username,display_name,avatar,created_at,updated_at)
    VALUES (3,'x','x','x','x','x')`).run(), /CHECK/);
  assert.throws(() => P.login(db, { playerId: b, pin: '999999' }), /PIN salah/);
  P.updateProfile(db, a, { displayName: 'Baru', avatar: '★' });
  const id = start(db, a, b);
  playToKingCapture(db, a, b, id);
  db.close();
  const again = openDb(file);
  assert.deepEqual(P.publicPlayers(again).map(p => [p.id, p.display_name]), [[a, 'Baru'], [b, 'Dua']]);
  assert.equal(M.gameDetail(again, id).moves.length, 4);
});

test('pertandingan: giliran, gerakan ilegal, hasil, replay, immutability', () => {
  const { db, a, b } = setup();
  const id = M.createMatch(db, a, { color: 'w' });
  assert.throws(() => M.act(db, a, id, 'accept'), /Menunggu/);
  assert.throws(() => M.createMatch(db, b, { color: 'w' }), /belum selesai/);
  M.act(db, b, id, 'accept');
  assert.throws(() => M.act(db, b, id, 'roll'), /giliranmu/);
  assert.throws(() => M.act(db, a, id, 'move', { uci: 'e2e4' }), /Kocok/);
  M.act(db, a, id, 'roll', {}, () => [2, 2, 2]);
  assert.throws(() => M.act(db, a, id, 'roll'), /sudah dikocok/);
  assert.throws(() => M.act(db, a, id, 'move', { uci: 'e2e4' }), /tidak legal/);
  for (const uci of ['b1c3', 'c3d5', 'd5f6']) M.act(db, a, id, 'move', { uci });
  M.act(db, b, id, 'roll', {}, () => [4, 4, 4]);
  M.act(db, a, id, 'roll', {}, () => [2, 6, 6]);
  M.act(db, a, id, 'move', { uci: 'f6e8' });

  const d = M.gameDetail(db, id);
  assert.equal(d.game.winner, a);
  assert.equal(d.game.result_type, 'white_win');
  assert.equal(d.game.total_moves, 4);
  assert.equal(d.game.total_dice_rolls, 3);
  assert.deepEqual(d.turns.map(t => t.status), ['completed', 'passed', 'completed']);
  assert.deepEqual(d.rolls.map(r => r.dice_values), [[2, 2, 2], [4, 4, 4], [2, 6, 6]]);
  assert.equal(d.moves.at(-1).captured_piece, 'k');
  assert.equal(d.moves.at(-1).fen_after, d.game.final_fen);
  // Rantai FEN tersambung (antar giliran hanya posisi bidak yang dibandingkan).
  let previous = d.game.starting_fen;
  for (const m of d.moves) {
    assert.equal(m.fen_before.split(' ')[0], previous.split(' ')[0]);
    previous = m.fen_after;
  }
  assert.throws(() => M.act(db, a, id, 'resign'), /sudah selesai/);
  assert.throws(() => db.exec("UPDATE game_moves SET move_san='x'"), /immutable/);
  assert.throws(() => db.exec("UPDATE game_sessions SET winner=NULL"), /immutable/);
  assert.throws(() => db.exec("UPDATE dice_rolls SET dice_values='[1,1,1]'"), /immutable/);
});

test('database: foreign key, nomor unik, rollback', () => {
  const { db, a, b } = setup();
  const id = start(db, a, b);
  assert.throws(() => db.prepare(`INSERT INTO dice_rolls (game_id,turn_id,player_id,roll_number,dice_values,available_pieces,created_at)
    VALUES (?,999,?,1,'[1]','[]','x')`).run(id, a), /FOREIGN KEY/);
  assert.throws(() => transaction(db, () => {
    db.exec("UPDATE players SET display_name='Z'");
    throw new Error('batal');
  }), /batal/);
  assert.equal(P.publicPlayers(db)[0].display_name, 'Satu');
  M.act(db, a, id, 'roll', {}, () => [2, 2, 2]);
  M.act(db, a, id, 'move', { uci: 'b1c3' });
  assert.throws(() => db.exec(`INSERT INTO game_moves SELECT NULL,game_id,turn_id,dice_roll_id,die_indexes,move_number,
    player_id,player_color,piece_type,from_square,to_square,move_uci,move_san,captured_piece,promotion,fen_before,
    fen_after,created_at FROM game_moves`), /UNIQUE/);
});

test('statistik: menang, remis, abandoned, streak, filter', () => {
  const { db, a, b } = setup();
  playToKingCapture(db, a, b, start(db, a, b));
  let id = start(db, a, b); M.act(db, b, id, 'resign');
  id = start(db, a, b); M.act(db, a, id, 'draw'); M.act(db, b, id, 'draw');
  id = start(db, a, b); M.act(db, a, id, 'resign');
  id = start(db, a, b); M.act(db, a, id, 'abandon');
  assert.equal(M.gameDetail(db, id).game.status, 'active'); // butuh persetujuan lawan
  M.act(db, b, id, 'abandon');
  const s = statistics(db);
  const A = s.players[a], B = s.players[b];
  assert.deepEqual([A.total, A.wins, A.losses, A.draws, A.longestStreak, A.currentStreak], [4, 2, 1, 1, 2, 0]);
  assert.deepEqual([B.wins, B.losses, B.currentStreak, B.winRate], [1, 2, 1, .25]);
  assert.equal(s.headToHead.mostRecentWinner, b);
  assert.equal(s.headToHead.abandoned, 1);
  for (const [filter, n] of [['all', 5], ['p1', 2], ['p2', 1], ['draw', 1], ['abandoned', 1]])
    assert.equal(M.listGames(db, { filter }).total, n, filter);
});

test('fuzz: 150 pertandingan acak selalu konsisten', () => {
  const { db, a, b } = setup();
  for (let n = 0; n < 150; n++) {
    const id = start(db, a, b);
    let live, guard = 0;
    while ((live = M.liveState(db, a)) && guard++ < 1500) {
      const mover = live.turn.player_id;
      if (live.turn.status === 'awaiting_roll') M.act(db, mover, id, 'roll');
      else {
        const { legal } = M.liveState(db, mover);
        assert.ok(legal.length);
        M.act(db, mover, id, 'move', { uci: legal[Math.floor(Math.random() * legal.length)].uci });
      }
    }
    const d = M.gameDetail(db, id);
    assert.equal(d.game.status, 'completed');
    if (d.moves.length) assert.equal(d.moves.at(-1).fen_after.split(' ')[0], d.game.final_fen.split(' ')[0]);
  }
});

test('API: autentikasi dan validasi server', async () => {
  const db = openDb(':memory:');
  const server = createApp(db).listen(0);
  const url = `http://localhost:${server.address().port}/api/`;
  const call = (path, body, cookie) => fetch(url + path, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
    body: body && JSON.stringify(body) });
  try {
    assert.equal((await call('stats')).status, 401);
    const players = [{ displayName: 'A', avatar: '♔' }, { displayName: 'B', avatar: '♘' }];
    assert.equal((await call('setup', { code: 'salah', pin: '123456', players })).status, 403);
    const res = await call('setup', { code: P.accessCode(db), pin: '123456', players });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('games', { color: 'w' }, cookie)).status, 200);
    assert.equal((await call('games/1/roll', {}, cookie)).status, 409);
    assert.equal((await call('profile', { displayName: 'A', avatar: '<img>' }, cookie)).status, 400);
    const boot = await (await call('bootstrap')).json();
    assert.ok(!('pin_hash' in boot.players[0]));
  } finally { server.closeAllConnections(); server.close(); }
});
