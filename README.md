# Dice Chess — privat, dua pemain, light mode (Velvet Cocoa)

## Menjalankan
Butuh Node.js 22.13 atau lebih baru. Tidak ada dependensi (tidak perlu `npm install`).

    npm start        # http://localhost:3000, kode akses tampil di terminal
    npm test

Variabel opsional: `PORT`, `DB_FILE` (default `data/dice-chess.db`).

## Persiapan pertama
1. Buka alamat server, isi dua nama dan avatar, masukkan kode akses, buat PIN Player 1.
2. Di perangkat kedua, pilih profil Player 2, masukkan kode akses, buat PIN sendiri.

## Bermain dari dua perangkat
- Satu Wi-Fi: perangkat kedua membuka `http://<IP-komputer-server>:3000`.
  Koneksi HTTP tidak terenkripsi; pakai hanya di jaringan rumah yang dipercaya.
- Beda tempat: pasang di hosting yang menjalankan Node, punya disk persisten, dan HTTPS.
  Jalankan satu instance saja. Hosting statis atau serverless tidak cocok.
- Cadangan data: hentikan server lalu salin folder `data/`.

## Mencoba satu pertandingan
Play → Buat pertandingan → lawan menekan Terima → Kocok dadu → pilih bidak dan petak.
Setelah raja dimakan, muncul ringkasan, lalu Replay.

## Aturan (`dice3-kingcapture-v1`)
- 3 dadu: 1 Pion, 2 Kuda, 3 Gajah, 4 Benteng, 5 Menteri, 6 Raja. Maksimal 3 langkah, urutan bebas.
- Wajib memakai dadu sebanyak mungkin; sisanya hangus. Tanpa langkah legal, giliran lewat otomatis.
- Tidak ada skak. Menang dengan memakan raja (selalu boleh) atau lawan menyerah.
- Rokade memakai dadu Raja + Benteng; boleh melewati petak yang diserang.
- En passant berlaku pada giliran lawan berikutnya. Promosi: Menteri, Benteng, Gajah, Kuda.
- Remis: sepakat, tinggal dua raja, atau 100 giliran tanpa makan dan tanpa gerak pion.
- Pengulangan posisi tidak dihitung. Tidak ada batas waktu.
- Berhenti tanpa hasil (abandoned) butuh persetujuan keduanya dan tidak masuk statistik.

## Arsitektur
| File | Isi |
|---|---|
| `src/engine.js` | Aturan catur, pemetaan dadu, FEN |
| `src/matches.js` | Pertandingan, giliran, lemparan, riwayat |
| `src/players.js` | Profil, PIN, sesi |
| `src/stats.js` | Statistik, dihitung dari catatan pertandingan |
| `src/db.js`, `migrations/001_init.sql` | SQLite dan migrasi |
| `src/errors.js` | Error aplikasi |
| `server.js` | API HTTP, update langsung (SSE), file statis |
| `public/` | Antarmuka: `index.html`, `app.js` (halaman, papan, replay), `styles.css` |
| `test/app.test.js` | Tes engine, database, statistik, API |

Semua file di atas baru; tidak ada proyek lama yang diubah.

## Tabel
Inti: `players`, `game_sessions`, `game_turns`, `dice_rolls`, `game_moves`.
Pendukung: `auth_sessions`, `app_config`, `schema_migrations`.

## API
- `GET /api/bootstrap`, `POST /api/setup`, `/api/login`, `/api/logout`, `/api/profile`
- `GET /api/live`, `/api/events`, `/api/stats`, `/api/games`, `/api/games/:id`
- `POST /api/games`, `/api/games/:id/{accept,cancel,roll,move,draw,abandon,decline,resign}`

Dadu dikocok dan gerakan divalidasi di server. Replay hanya membaca data tersimpan.

## Keterbatasan
- PIN yang lupa belum bisa direset dari aplikasi.
- Setelah 10 percobaan PIN/kode salah, login ditahan 5 menit untuk semua orang.
- Preferensi suara, animasi, dan orientasi disimpan per perangkat.
- Warna papan mengikuti bagian 4.2 brief (terang #FFF6ED, gelap #D2A679).
