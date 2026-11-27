import { randomBytes, scryptSync, timingSafeEqual, createHash, randomInt } from 'node:crypto';
import { now, transaction } from './db.js';
import { AppError, check } from './errors.js';

export const PRESETS = ['♔', '♕', '♖', '♗', '♘', '♙', '★', '♥'];
const sha = s => createHash('sha256').update(s).digest('hex');

function hashPin(pin) {
  check(/^\d{6,12}$/.test(pin || ''), 'PIN harus 6–12 digit angka.');
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pin, salt, 32).toString('hex');
}
function pinMatches(pin, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(String(pin), Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
}
function cleanName(name) {
  const v = String(name ?? '').trim();
  check(v.length >= 1 && v.length <= 24, 'Nama harus 1–24 karakter.');
  return v;
}
function cleanAvatar(a) {
  if (PRESETS.includes(a)) return a;
  check(typeof a === 'string' && a.length < 150_000 &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(a), 'Avatar tidak valid.');
  return a;
}

// Kode akses mencegah orang lain yang menemukan alamat server membuat/mengklaim profil.
export function accessCode(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key='access_code'").get();
  if (row) return row.value;
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  db.prepare("INSERT INTO app_config VALUES ('access_code', ?)").run(code);
  return code;
}

export const publicPlayers = db => db.prepare(
  `SELECT id, slot, username, display_name, avatar, created_at, updated_at,
          pin_hash IS NOT NULL AS claimed FROM players ORDER BY slot`).all();

export function initialize(db, { code, players, pin }) {
  check(code === accessCode(db), 'Kode akses salah.', 403);
  check(Array.isArray(players) && players.length === 2, 'Harus tepat dua profil.');
  const names = players.map(p => cleanName(p.displayName));
  check(names[0].toLowerCase() !== names[1].toLowerCase(), 'Nama kedua pemain harus berbeda.');
  const pinHash = hashPin(pin);
  return transaction(db, () => {
    check(!db.prepare('SELECT 1 FROM players').get(), 'Profil sudah dibuat.', 409);
    const insert = db.prepare(`INSERT INTO players
      (slot, username, display_name, avatar, pin_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`);
    const ids = players.map((p, i) => Number(insert.run(
      i + 1, `player${i + 1}`, names[i], cleanAvatar(p.avatar), i === 0 ? pinHash : null, now(), now()
    ).lastInsertRowid));
    return createSession(db, ids[0]);
  });
}

function createSession(db, playerId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run(sha(token), playerId, now());
  return { token, playerId };
}

// Login. Bila profil belum punya PIN, pemiliknya membuat PIN memakai kode akses.
export function login(db, { playerId, pin, code }) {
  const p = db.prepare('SELECT * FROM players WHERE id=?').get(Number(playerId));
  check(p, 'Profil tidak ditemukan.', 404);
  if (!p.pin_hash) {
    check(code === accessCode(db), 'Kode akses salah.', 403);
    db.prepare('UPDATE players SET pin_hash=?, updated_at=? WHERE id=?').run(hashPin(pin), now(), p.id);
  } else if (!pinMatches(pin, p.pin_hash)) throw new AppError('PIN salah.', 403);
  return createSession(db, p.id);
}

export const playerFromToken = (db, token) => token
  ? db.prepare('SELECT player_id FROM auth_sessions WHERE token_hash=?').get(sha(token))?.player_id ?? null
  : null;
export const logout = (db, token) => db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(sha(token || ''));

export function updateProfile(db, playerId, { displayName, avatar }) {
  const name = cleanName(displayName);
  check(!db.prepare('SELECT 1 FROM players WHERE id<>? AND lower(display_name)=lower(?)').get(playerId, name),
    'Nama itu dipakai pemain lain.');
  db.prepare('UPDATE players SET display_name=?, avatar=?, updated_at=? WHERE id=?')
    .run(name, cleanAvatar(avatar), now(), playerId);
}
