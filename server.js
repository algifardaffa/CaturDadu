import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './src/db.js';
import * as P from './src/players.js';
import * as M from './src/matches.js';
import { statistics } from './src/stats.js';
import { AppError, check } from './src/errors.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css'],
};

export function createApp(db, { rollDice } = {}) {
  const streams = new Map(); // response -> playerId
  const failures = new Map(); // pembatas tebakan PIN / kode

  const online = () => [...new Set(streams.values())];
  const broadcast = () => {
    const data = `data: ${JSON.stringify({ online: online() })}\n\n`;
    for (const res of streams.keys()) res.write(data);
  };

  async function readBody(req) {
    check((req.headers['content-type'] || '').startsWith('application/json'), 'Harus JSON.', 415);
    let size = 0; const chunks = [];
    for await (const c of req) {
      size += c.length;
      check(size < 400_000, 'Data terlalu besar.', 413);
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}') ?? {}; }
    catch { throw new AppError('JSON tidak valid.'); }
  }

  function guarded(fn) {
    const key = 'auth';
    const f = failures.get(key);
    check(!f || f.count < 10 || Date.now() > f.until, 'Terlalu banyak percobaan. Tunggu 5 menit.', 429);
    try { const r = fn(); failures.delete(key); return r; }
    catch (e) {
      if (e.status === 403) failures.set(key, { count: (f?.count || 0) + 1, until: Date.now() + 300_000 });
      throw e;
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      const file = STATIC[url.pathname];
      if (req.method === 'GET' && file) {
        const content = await readFile(join(ROOT, 'public', file[0]));
        res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'" });
        return res.end(content);
      }
      const token = /(?:^|; )dc=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
      const me = P.playerFromToken(db, token);
      const route = `${req.method} ${url.pathname}`;
      const cookie = (value, age) => `dc=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}` +
        (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

      if (route === 'GET /api/bootstrap')
        return send(200, { me, players: P.publicPlayers(db), presets: P.PRESETS });
      if (route === 'POST /api/setup' || route === 'POST /api/login') {
        const body = await readBody(req);
        const s = guarded(() => url.pathname === '/api/setup' ? P.initialize(db, body) : P.login(db, body));
        broadcast();
        return send(200, { me: s.playerId }, { 'Set-Cookie': cookie(s.token, 60 * 60 * 24 * 180) });
      }
      check(me, 'Silakan masuk dulu.', 401);

      if (route === 'GET /api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no' });
        streams.set(res, me);
        const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(beat); streams.delete(res); broadcast(); });
        return broadcast();
      }
      if (route === 'GET /api/live') return send(200, { live: M.liveState(db, me), online: online() });
      if (route === 'GET /api/stats') return send(200, statistics(db));
      if (route === 'GET /api/games') return send(200, M.listGames(db, Object.fromEntries(url.searchParams)));
      const detail = /^\/api\/games\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && detail) return send(200, M.gameDetail(db, detail[1]));

      check(req.method === 'POST', 'Tidak ditemukan.', 404);
      const body = await readBody(req);
      if (route === 'POST /api/logout') {
        P.logout(db, token);
        return send(200, {}, { 'Set-Cookie': cookie('', 0) });
      }
      const action = /^\/api\/games\/(\d+)\/([a-z]+)$/.exec(url.pathname);
      let result = {};
      if (url.pathname === '/api/profile') P.updateProfile(db, me, body);
      else if (url.pathname === '/api/games') result = { id: M.createMatch(db, me, body) };
      else if (action) M.act(db, me, action[1], action[2], body, rollDice);
      else throw new AppError('Tidak ditemukan.', 404);
      broadcast();
      return send(200, result);
    } catch (e) {
      if (!(e instanceof AppError)) console.error(e);
      if (!res.headersSent) send(e.status || 500, { error: e instanceof AppError ? e.message : 'Kesalahan server.' });
    }
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const db = openDb(process.env.DB_FILE || join(ROOT, 'data', 'dice-chess.db'));
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => {
    console.log(`Dice Chess: http://localhost:${port}`);
    console.log(`Kode akses (untuk membuat / mengklaim profil): ${P.accessCode(db)}`);
  });
}
