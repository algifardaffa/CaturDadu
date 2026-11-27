// Aturan Dice Chess. Murni (tanpa I/O). Dipakai server sebagai satu-satunya otoritas.
export const RULESET = 'dice3-kingcapture-v1';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const DIE_PIECE = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
export const QUIET_LIMIT = 100; // giliran tanpa makan / gerak pion -> remis

export const squareName = i => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
export const squareIndex = s => (8 - Number(s[1])) * 8 + 'abcdefgh'.indexOf(s[0]);
const colorOf = p => (p === p.toUpperCase() ? 'w' : 'b');

export function parseFen(fen) {
  const [placement, turn, castling, ep, quiet, full] = fen.split(' ');
  const board = [];
  for (const ch of placement.replace(/\//g, '')) {
    if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) board.push(null);
    else board.push(ch);
  }
  return { board, turn, castling: castling === '-' ? '' : castling,
    ep: ep === '-' ? [] : ep.split(','), quiet: +quiet, full: +full };
}

export function toFen(s) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '', n = 0;
    for (let f = 0; f < 8; f++) {
      const p = s.board[r * 8 + f];
      if (!p) { n++; continue; }
      if (n) { row += n; n = 0; }
      row += p;
    }
    rows.push(row + (n || ''));
  }
  // Kolom en passant bisa berisi lebih dari satu petak (dipisah koma).
  return `${rows.join('/')} ${s.turn} ${s.castling || '-'} ${s.ep.join(',') || '-'} ${s.quiet} ${s.full}`;
}

const STEPS = {
  n: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
  k: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
};
STEPS.q = [...STEPS.r, ...STEPS.b];

// Semua gerakan bidak milik pemain aktif, tanpa konsep skak.
function pieceMoves(s, types) {
  const out = [], me = s.turn, b = s.board;
  const at = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1);
  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!piece || colorOf(piece) !== me) continue;
    const type = piece.toLowerCase();
    if (!types.has(type)) continue;
    const f = from % 8, r = Math.floor(from / 8);
    const add = (to, extra = {}) => out.push({ from, to, piece: type,
      captured: b[to] ? b[to].toLowerCase() : null, ...extra });
    if (type === 'p') {
      const dir = me === 'w' ? -1 : 1, startRow = me === 'w' ? 6 : 1, lastRow = me === 'w' ? 0 : 7;
      const push = (to, extra) => {
        if (Math.floor(to / 8) === lastRow) for (const promo of ['q', 'r', 'b', 'n']) add(to, { ...extra, promo });
        else add(to, extra);
      };
      const one = at(f, r + dir);
      if (one >= 0 && !b[one]) {
        push(one);
        const two = at(f, r + 2 * dir);
        if (r === startRow && !b[two]) add(two, { double: true });
      }
      for (const df of [-1, 1]) {
        const to = at(f + df, r + dir);
        if (to < 0) continue;
        if (b[to] && colorOf(b[to]) !== me) push(to);
        else if (!b[to] && s.ep.includes(squareName(to)) && squareName(to)[1] === (me === 'w' ? '6' : '3'))
          add(to, { enPassant: true, captured: 'p' });
      }
    } else {
      const slide = type === 'b' || type === 'r' || type === 'q';
      for (const [df, dr] of STEPS[type]) {
        for (let k = 1; k < 8; k++) {
          const to = at(f + df * k, r + dr * k);
          if (to < 0) break;
          if (b[to] && colorOf(b[to]) === me) break;
          add(to);
          if (b[to] || !slide) break;
        }
      }
    }
  }
  return out;
}

function castleMoves(s) {
  const row = s.turn === 'w' ? 7 : 0, base = row * 8, out = [];
  const K = s.turn === 'w' ? 'K' : 'k', R = s.turn === 'w' ? 'R' : 'r';
  if (s.board[base + 4] !== K) return out;
  const side = (flag, rookFile, empty, kingTo, rookTo) => {
    if (s.castling.includes(flag) && s.board[base + rookFile] === R && empty.every(f => !s.board[base + f]))
      out.push({ from: base + 4, to: base + kingTo, piece: 'k', captured: null,
        castle: { rookFrom: base + rookFile, rookTo: base + rookTo } });
  };
  side(s.turn === 'w' ? 'K' : 'k', 7, [5, 6], 6, 5);
  side(s.turn === 'w' ? 'Q' : 'q', 0, [1, 2, 3], 2, 3);
  return out;
}

// Indeks dadu yang dipakai sebuah gerakan (rokade memakai dadu Raja + Benteng).
function diceFor(move, dice) {
  const k = dice.findIndex(d => DIE_PIECE[d] === move.piece);
  if (k < 0) return null;
  if (!move.castle) return [k];
  const r = dice.findIndex(d => DIE_PIECE[d] === 'r');
  return r < 0 ? null : [k, r];
}

export function applyMove(s, m) {
  const n = { ...s, board: s.board.slice(), ep: s.ep.slice() };
  const piece = n.board[m.from];
  n.board[m.from] = null;
  n.board[m.to] = m.promo ? (n.turn === 'w' ? m.promo.toUpperCase() : m.promo) : piece;
  if (m.enPassant) n.board[m.to + (n.turn === 'w' ? 8 : -8)] = null;
  if (m.castle) {
    n.board[m.castle.rookTo] = n.board[m.castle.rookFrom];
    n.board[m.castle.rookFrom] = null;
  }
  // Pion yang bergerak lagi / petak yang sudah dipakai tidak bisa lagi ditangkap en passant.
  n.ep = n.ep.filter(sq => {
    const i = squareIndex(sq), pawnAt = i + (sq[1] === '3' ? -8 : 8);
    return pawnAt !== m.from && pawnAt !== m.to && i !== m.to && n.board[pawnAt]?.toLowerCase() === 'p';
  });
  if (m.double) n.ep.push(squareName((m.from + m.to) / 2));
  const lost = { 60: 'KQ', 63: 'K', 56: 'Q', 4: 'kq', 7: 'k', 0: 'q' };
  for (const sq of [m.from, m.to])
    for (const flag of lost[sq] || '') n.castling = n.castling.replace(flag, '');
  if (m.piece === 'p' || m.captured) n.quiet = 0;
  return n;
}

export function endTurn(s, hadProgress) {
  const enemyRank = s.turn === 'w' ? '6' : '3'; // kesempatan en passant pemain ini hangus
  return { ...s, turn: s.turn === 'w' ? 'b' : 'w',
    ep: s.ep.filter(sq => sq[1] !== enemyRank),
    quiet: hadProgress ? 0 : s.quiet + 1,
    full: s.full + (s.turn === 'b' ? 1 : 0) };
}

function candidates(s, dice) {
  const types = new Set(dice.map(d => DIE_PIECE[d]));
  const list = pieceMoves(s, types);
  if (types.has('k') && types.has('r')) list.push(...castleMoves(s));
  return list.map(m => ({ ...m, dice: diceFor(m, dice) })).filter(m => m.dice);
}

const without = (dice, idx) => dice.filter((_, i) => !idx.includes(i));

// Jumlah dadu terbanyak yang masih bisa dipakai. Memakan raja = nilai penuh.
function maxUsable(s, dice, memo) {
  if (!dice.length) return 0;
  const key = toFen(s) + '|' + [...dice].sort().join('');
  if (memo.has(key)) return memo.get(key);
  let best = 0;
  for (const m of candidates(s, dice)) {
    const v = m.captured === 'k' ? dice.length
      : m.dice.length + maxUsable(applyMove(s, m), without(dice, m.dice), memo);
    if (v > best) best = v;
    if (best === dice.length) break;
  }
  memo.set(key, best);
  return best;
}

// Gerakan legal untuk sisa dadu: wajib memakai dadu sebanyak mungkin,
// kecuali gerakan yang langsung memakan raja.
export function legalMoves(s, dice) {
  const memo = new Map(), best = maxUsable(s, dice, memo);
  return candidates(s, dice).filter(m => m.captured === 'k' ||
    m.dice.length + maxUsable(applyMove(s, m), without(dice, m.dice), memo) === best);
}

export const uci = m => squareName(m.from) + squareName(m.to) + (m.promo || '');

export function notation(m) {
  if (m.castle) return m.to % 8 === 6 ? 'O-O' : 'O-O-O';
  const letter = m.piece === 'p' ? '' : m.piece.toUpperCase();
  // Notasi panjang: selalu tidak ambigu.
  return letter + squareName(m.from) + (m.captured ? 'x' : '-') + squareName(m.to) +
    (m.promo ? '=' + m.promo.toUpperCase() : '') + (m.enPassant ? ' e.p.' : '') + (m.captured === 'k' ? '#' : '');
}

export const bareKings = s => s.board.every(p => !p || p.toLowerCase() === 'k');
