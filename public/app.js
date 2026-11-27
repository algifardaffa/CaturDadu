const $ = s => document.querySelector(s);
const view = $('#view'), modal = $('#modal');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const NAMES = { p: 'Pion', n: 'Kuda', b: 'Gajah', r: 'Benteng', q: 'Menteri', k: 'Raja' };
const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const DIE = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
const REASONS = { king_captured: 'Raja dimakan', resignation: 'Menyerah', agreement: 'Sepakat remis',
  turn_limit: '100 giliran tanpa kemajuan', bare_kings: 'Tinggal dua raja',
  mutual_abandon: 'Dihentikan bersama', cancelled: 'Dibatalkan' };
const NAV = [['dashboard', 'Dashboard'], ['play', 'Play'], ['players', 'Players'],
  ['history', 'Game History'], ['statistics', 'Statistics'], ['settings', 'Settings']];

let boot, live = null, online = [], selected = null, events, busy = false, replayTimer, lastRollSeen = null;
let watching = null; // id pertandingan aktif, untuk menampilkan ringkasan saat selesai
const historyQuery = { filter: 'all', sort: 'newest', page: 1 };

const prefs = (() => {
  const base = { sound: true, animation: true, orientation: 'white' };
  try { return { ...base, ...JSON.parse(localStorage.getItem('dc-prefs')) }; } catch { return base; }
})();
const savePrefs = () => { try { localStorage.setItem('dc-prefs', JSON.stringify(prefs)); } catch {} };

async function api(path, body) {
  const res = await fetch('/api/' + path, body === undefined ? {} :
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Gagal.');
  return data;
}
let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').textContent = ''; }, 3500);
}
function beep() {
  if (!prefs.sound) return;
  try {
    const ctx = beep.ctx ||= new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 420; g.gain.setValueAtTime(.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .15);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + .15);
  } catch {}
}

const player = id => boot.players.find(p => p.id === id);
const name = id => esc(player(id)?.display_name);
const avatar = a => a.startsWith('data:') ? `<img class="avatar" src="${esc(a)}" alt="">`
  : `<span class="avatar" aria-hidden="true">${esc(a)}</span>`;
const who = (id, extra = '') => `<div class="row">${avatar(player(id).avatar)}<div><strong>${name(id)}</strong>
  <div class="muted">${extra}</div></div></div>`;
const date = s => s ? new Date(s).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const duration = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}j ${m}m` : m ? `${m}m ${s % 60}dtk` : `${s}dtk`; };
const percent = v => Math.round(v * 100) + '%';
const result = g => g.status === 'abandoned' ? 'Abandoned' : g.winner ? `${name(g.winner)} menang` : 'Remis';

function confirmBox(title, text) {
  return new Promise(resolve => {
    modal.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p><form method="dialog" class="row">
      <button value="yes">Ya, lanjutkan</button><button class="ghost" value="no">Batal</button></form>`;
    modal.returnValue = 'no';
    modal.onclose = () => resolve(modal.returnValue === 'yes');
    modal.showModal();
  });
}

// ---------- papan ----------
function boardHtml(fen, { flip = false, last = [], sel = null, targets = [], movable = [] } = {}) {
  const squares = [];
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) squares.push([f++, r, null]);
      else squares.push([f++, r, ch]);
    }
  });
  if (flip) squares.reverse();
  return `<div class="board" role="grid" aria-label="Papan catur">${squares.map(([f, r, p], i) => {
    const sq = 'abcdefgh'[f] + (8 - r);
    const cls = [(f + r) % 2 ? 'dark' : '', last.includes(sq) ? 'last' : '', sel === sq ? 'selected' : '',
      targets.includes(sq) ? 'target' : '', p ? 'occupied' : '',
      movable.includes(sq) || targets.includes(sq) ? 'can' : ''].join(' ');
    const color = p && (p === p.toUpperCase() ? 'w' : 'b');
    return `<button class="${cls}" data-sq="${sq}" aria-label="${sq}${p ? ` ${NAMES[p.toLowerCase()]} ${color === 'w' ? 'putih' : 'hitam'}` : ''}">
      ${p ? `<span class="piece-${color}">${GLYPH[p.toLowerCase()]}︎</span>` : ''}
      ${i % 8 === 0 ? `<span class="coord rank">${8 - r}</span>` : ''}
      ${i >= 56 ? `<span class="coord file">${'abcdefgh'[f]}</span>` : ''}</button>`;
  }).join('')}</div>`;
}
const diceHtml = (values, used = [], rolling = false) => `<div class="row">${values.map((v, i) =>
  `<div class="die ${used.includes(i) ? 'used' : ''} ${rolling ? 'rolling' : ''}">
   <b>${v} ${GLYPH[DIE[v]]}︎</b><small>${used.includes(i) ? 'terpakai' : NAMES[DIE[v]]}</small></div>`).join('')}</div>`;
const flipFor = whiteId => prefs.orientation === 'mine' && boot.me !== whiteId;

// ---------- masuk & setup ----------
function avatarPicker(key, current) {
  return `<div class="stack" data-picker="${key}"><span>Avatar</span><div class="row presets">${boot.presets.map(a =>
    `<button type="button" class="ghost" data-preset="${a}" aria-pressed="${a === current}">${a}</button>`).join('')}</div>
    <label>Atau unggah foto<input type="file" accept="image/*" data-upload></label>
    <input type="hidden" name="${key}" value="${esc(current)}"></div>`;
}
function wirePickers(root) {
  root.querySelectorAll('[data-picker]').forEach(box => {
    const hidden = box.querySelector('input[type=hidden]');
    const press = a => box.querySelectorAll('[data-preset]').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.preset === a));
    box.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
      hidden.value = b.dataset.preset; press(hidden.value); });
    box.querySelector('[data-upload]').onchange = async e => {
      try {
        const img = await createImageBitmap(e.target.files[0]);
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const side = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
        hidden.value = c.toDataURL('image/jpeg', .85); press(null); toast('Foto siap disimpan.');
      } catch { toast('Gambar tidak bisa dibaca.'); }
    };
  });
}
const pinField = (label = 'PIN (6–12 angka)') =>
  `<label>${label}<input name="pin" type="password" inputmode="numeric" minlength="6" maxlength="12" required></label>`;
const codeField = `<label>Kode akses (tampil di terminal server)<input name="code" inputmode="numeric" required></label>`;

function onSubmit(form, fn) {
  form.onsubmit = async e => {
    e.preventDefault();
    try { await fn(Object.fromEntries(new FormData(form))); } catch (err) { toast(err.message); }
  };
}

function setupScreen() {
  view.innerHTML = `<h1>Buat dua profil</h1><form class="stack">
    <div class="grid">${[1, 2].map(i => `<div class="card stack"><h2>Player ${i}</h2>
      <label>Nama tampilan<input name="name${i}" maxlength="24" required></label>
      ${avatarPicker('avatar' + i, boot.presets[i === 1 ? 0 : 4])}</div>`).join('')}</div>
    <div class="card stack">${codeField}${pinField('PIN Player 1 (6–12 angka)')}
      <p class="muted">Player 2 membuat PIN sendiri saat pertama masuk dari perangkatnya.</p>
      <button>Simpan profil</button></div></form>`;
  wirePickers(view);
  onSubmit(view.querySelector('form'), async d => {
    await api('setup', { code: d.code, pin: d.pin, players: [1, 2].map(i =>
      ({ displayName: d['name' + i], avatar: d['avatar' + i] })) });
    await start('dashboard');
  });
}
function loginScreen() {
  view.innerHTML = `<h1>Siapa yang bermain di perangkat ini?</h1><div class="grid">${boot.players.map(p =>
    `<form class="card stack" data-id="${p.id}">${who(p.id, 'Player ' + p.slot)}
      ${p.claimed ? '' : codeField}${pinField(p.claimed ? 'PIN' : 'Buat PIN baru (6–12 angka)')}
      <button>Masuk</button></form>`).join('')}</div>`;
  view.querySelectorAll('form').forEach(f => onSubmit(f, async d => {
    await api('login', { ...d, playerId: +f.dataset.id });
    await start('dashboard');
  }));
}

// ---------- halaman ----------
const statList = s => `<dl class="stats">${[['Total match', s.total], ['Menang', s.wins], ['Kalah', s.losses],
  ['Remis', s.draws], ['Win rate', percent(s.winRate)], ['Total waktu bermain', duration(s.totalPlayingTime)],
  ['Rata-rata durasi', duration(s.averageDuration)], ['Rata-rata langkah', s.averageMoves.toFixed(1)],
  ['Streak menang terpanjang', s.longestStreak], ['Streak menang saat ini', s.currentStreak],
  ['Terakhir bermain', date(s.lastPlayed)]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

const matchCard = g => `<a class="card" href="#match/${g.id}" style="color:inherit;text-decoration:none">
  <div class="row between"><strong>${esc(g.game_code)}</strong><strong>${result(g)}</strong></div>
  <div>Putih: ${name(g.player_white)} · Hitam: ${name(g.player_black)}</div>
  <div class="muted">${date(g.finished_at)} · ${duration(g.duration_seconds)} · ${g.total_moves} langkah</div></a>`;

function headToHead(s) {
  const [a, b] = boot.players, h = s.headToHead;
  return `<div class="card"><h2>Head-to-head</h2><div class="row between">${who(a.id)}
    <h1>${s.players[a.id].wins} – ${s.players[b.id].wins}</h1>${who(b.id)}</div>
    <dl class="stats"><dt>Total pertandingan selesai</dt><dd>${h.total}</dd><dt>Remis</dt><dd>${h.draws}</dd>
    <dt>Abandoned (tidak dihitung)</dt><dd>${h.abandoned}</dd>
    <dt>Win rate ${name(a.id)}</dt><dd>${percent(s.players[a.id].winRate)}</dd>
    <dt>Win rate ${name(b.id)}</dt><dd>${percent(s.players[b.id].winRate)}</dd>
    <dt>Pemenang terakhir</dt><dd>${h.mostRecentWinner ? name(h.mostRecentWinner) : '—'}</dd>
    <dt>Streak berjalan</dt><dd>${boot.players.filter(p => s.players[p.id].currentStreak)
      .map(p => `${name(p.id)} ${s.players[p.id].currentStreak}×`).join('') || '—'}</dd></dl></div>`;
}

const pages = {
  async dashboard() {
    const [s, g] = await Promise.all([api('stats'), api('games')]);
    return () => {
      view.innerHTML = `<div class="stack"><div class="row between"><h1>Dashboard</h1>
        <a class="button" href="#play">${live ? 'Lanjutkan pertandingan' : 'Quick start match'}</a></div>
        <div class="grid">${boot.players.map(p => `<div class="card">${who(p.id,
          `${s.players[p.id].wins} menang · ${percent(s.players[p.id].winRate)}`)}</div>`).join('')}</div>
        <div class="grid">${headToHead(s)}<div class="card"><h2>Statistik keseluruhan</h2><dl class="stats">
          <dt>Pertandingan selesai</dt><dd>${s.headToHead.total}</dd>
          <dt>Berakhir dengan pemenang</dt><dd>${percent(s.headToHead.decisiveRate)}</dd>
          <dt>Total waktu bermain</dt><dd>${duration(s.players[boot.me].totalPlayingTime)}</dd>
          <dt>Rata-rata langkah</dt><dd>${s.players[boot.me].averageMoves.toFixed(1)}</dd></dl></div></div>
        <h2>Pertandingan terbaru</h2>${g.games.slice(0, 3).map(matchCard).join('') || '<p class="muted">Belum ada pertandingan.</p>'}</div>`;
    };
  },
  async players() {
    const s = await api('stats');
    return () => {
      view.innerHTML = `<h1>Players</h1><div class="grid">${boot.players.map(p => `<div class="card">
        ${who(p.id, `ID ${p.id} · @${esc(p.username)} · dibuat ${date(p.created_at)}`)}${statList(s.players[p.id])}
        <div class="row" style="margin-top:12px"><a class="button ghost" href="#history/p${p.slot}">Match yang dimenangkan</a>
        <a class="button ghost" href="#history">Semua riwayat</a>
        ${p.id === boot.me ? '<a class="button" href="#settings">Edit profil</a>' : ''}</div></div>`).join('')}</div>`;
    };
  },
  async statistics() {
    const s = await api('stats');
    return () => {
      view.innerHTML = `<div class="stack"><h1>Statistics</h1>${headToHead(s)}<div class="grid">${boot.players.map(p =>
        `<div class="card">${who(p.id)}${statList(s.players[p.id])}</div>`).join('')}</div>
        <div class="card"><h2>Riwayat performa</h2><div class="table"><table><tr><th>Match</th><th>Selesai</th><th>Hasil</th></tr>
        ${[...s.headToHead.history].reverse().map(h => `<tr><td><a href="#match/${h.id}">${esc(h.code)}</a></td>
          <td>${date(h.finished_at)}</td><td>${h.winner ? name(h.winner) : 'Remis'}</td></tr>`).join('')
          || '<tr><td colspan="3">Belum ada data.</td></tr>'}</table></div></div></div>`;
    };
  },
  async history(arg) {
    if (arg) Object.assign(historyQuery, { filter: arg, page: 1 });
    const data = await api('games?' + new URLSearchParams(historyQuery));
    return () => {
      const [a, b] = boot.players;
      const options = (list, current) => list.map(([v, l]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`).join('');
      view.innerHTML = `<div class="stack"><h1>Game History</h1><div class="row">
        <label>Filter<select id="filter">${options([['all', 'All matches'], ['p1', name(a.id) + ' menang'],
          ['p2', name(b.id) + ' menang'], ['draw', 'Remis'], ['abandoned', 'Abandoned']], historyQuery.filter)}</select></label>
        <label>Urutkan<select id="sort">${options([['newest', 'Terbaru'], ['oldest', 'Terlama dulu'],
          ['longest', 'Durasi terpanjang'], ['shortest', 'Durasi terpendek']], historyQuery.sort)}</select></label></div>
        ${data.games.map(matchCard).join('') || '<p class="muted">Tidak ada pertandingan.</p>'}
        <div class="row between"><button class="ghost" id="prev" ${data.page <= 1 ? 'disabled' : ''}>Sebelumnya</button>
        <span>Halaman ${data.page} / ${data.pages}</span>
        <button class="ghost" id="next" ${data.page >= data.pages ? 'disabled' : ''}>Berikutnya</button></div></div>`;
      const go = change => { Object.assign(historyQuery, change);
        location.hash === '#history' ? render() : (location.hash = 'history'); };
      $('#filter').onchange = e => go({ filter: e.target.value, page: 1 });
      $('#sort').onchange = e => go({ sort: e.target.value, page: 1 });
      $('#prev').onclick = () => go({ page: data.page - 1 });
      $('#next').onclick = () => go({ page: data.page + 1 });
    };
  },
  async match(id) {
    const d = await api('games/' + +id), g = d.game;
    return () => {
      const turn = i => d.turns.find(t => t.id === i);
      view.innerHTML = `<div class="stack"><div class="card"><h1>${result(g)}</h1>
        <p class="muted">${esc(g.game_code)} · ${REASONS[g.end_reason] || ''} · ${esc(g.ruleset_version)}</p>
        <div class="grid">${g.winner
          ? `<div>${who(g.winner, 'Pemenang')}</div><div>${who(g.winner === g.player_white ? g.player_black : g.player_white, 'Kalah')}</div>`
          : [g.player_white, g.player_black].map(p => `<div>${who(p, g.status === 'abandoned' ? 'Abandoned' : 'Remis')}</div>`).join('')}</div>
        <dl class="stats"><dt>Putih</dt><dd>${name(g.player_white)}</dd><dt>Hitam</dt><dd>${name(g.player_black)}</dd>
        <dt>Total langkah</dt><dd>${g.total_moves}</dd><dt>Total lemparan dadu</dt><dd>${g.total_dice_rolls}</dd>
        <dt>Durasi</dt><dd>${duration(g.duration_seconds)}</dd><dt>Mulai</dt><dd>${date(g.started_at)}</dd>
        <dt>Selesai</dt><dd>${date(g.finished_at)}</dd></dl>
        <div class="row" style="margin-top:12px"><a class="button" href="#replay/${g.id}">Replay match</a>
        <button id="rematch" class="ghost" ${live ? 'disabled' : ''}>Rematch (tukar warna)</button>
        <a class="button ghost" href="#dashboard">Dashboard</a></div></div>
        <div class="card"><h2>Posisi akhir</h2>${boardHtml(g.final_fen, { flip: flipFor(g.player_white) })}
          <p class="muted" style="overflow-wrap:anywhere">${esc(g.final_fen)}</p></div>
        <div class="card"><h2>Detail giliran</h2><div class="table"><table>
        <tr><th>Giliran</th><th>Pemain</th><th>Dadu</th><th>Langkah</th></tr>
        ${d.rolls.map(r => `<tr><td>${turn(r.turn_id).turn_number}</td><td>${name(r.player_id)}</td>
          <td>${r.dice_values.map(v => NAMES[DIE[v]]).join(', ')}</td>
          <td>${d.moves.filter(m => m.turn_id === r.turn_id).map(m => esc(m.move_san)).join(', ') || 'tidak ada'}</td></tr>`).join('')
          || '<tr><td colspan="4">Belum ada lemparan dadu.</td></tr>'}</table></div></div></div>`;
      $('#rematch').onclick = () => run(async () => {
        await api('games', { color: g.player_white === boot.me ? 'b' : 'w' });
        location.hash = 'play';
      });
    };
  },
  async replay(id) {
    const d = await api('games/' + +id), g = d.game;
    // Bingkai dibangun hanya dari data tersimpan: lemparan, langkah, dan FEN.
    const frames = [{ fen: g.starting_fen }];
    for (const turn of d.turns) {
      const roll = d.rolls.find(r => r.turn_id === turn.id);
      if (!roll) continue;
      const moves = d.moves.filter(m => m.turn_id === turn.id);
      if (!moves.length) frames.push({ fen: frames.at(-1).fen, roll, turn, used: [] });
      const used = [];
      for (const m of moves) {
        used.push(...m.die_indexes);
        frames.push({ fen: m.fen_after, roll, turn, move: m, used: [...used] });
      }
    }
    return () => {
      let at = 0;
      view.innerHTML = `<h1>Replay ${esc(g.game_code)}</h1><div class="match"><div id="rboard"></div>
        <div class="card stack"><div id="rinfo"></div><div class="row">
        ${[['first', 'Awal'], ['back', 'Sebelumnya'], ['fwd', 'Berikutnya'], ['end', 'Akhir'],
           ['play', 'Play'], ['pause', 'Pause'], ['restart', 'Ulang']].map(([k, l]) =>
           `<button class="ghost" data-r="${k}">${l}</button>`).join('')}</div>
        <a href="#match/${g.id}">Kembali ke detail</a></div></div>`;
      const draw = () => {
        const f = frames[at], m = f.move;
        $('#rboard').innerHTML = boardHtml(f.fen, { flip: flipFor(g.player_white), last: m ? [m.from_square, m.to_square] : [] });
        $('#rinfo').innerHTML = `<p>Bingkai ${at} / ${frames.length - 1} · Langkah ${d.moves.filter(x => frames.slice(0, at + 1).some(y => y.move === x)).length} / ${d.moves.length}</p>
          ${f.roll ? `<p>Giliran ${f.turn.turn_number}: <strong>${name(f.turn.player_id)}</strong></p>${diceHtml(f.roll.dice_values, f.used)}
          <p>${m ? `${NAMES[m.piece_type]} ${esc(m.move_san)}${m.captured_piece ? ` · memakan ${NAMES[m.captured_piece]}` : ''}` : 'Tidak ada langkah legal pada lemparan ini.'}</p>`
          : '<p>Posisi awal.</p>'}`;
      };
      const stop = () => clearInterval(replayTimer);
      const actions = {
        first: () => { stop(); at = 0; }, back: () => { stop(); at = Math.max(0, at - 1); },
        fwd: () => { stop(); at = Math.min(frames.length - 1, at + 1); },
        end: () => { stop(); at = frames.length - 1; }, pause: stop,
        restart: () => { stop(); at = 0; },
        play: () => { stop(); replayTimer = setInterval(() => {
          if (at >= frames.length - 1) return stop();
          at++; draw(); }, 900); },
      };
      view.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { actions[b.dataset.r](); draw(); });
      draw();
    };
  },
  async play() {
    return () => {
      if (!live) {
        view.innerHTML = `<h1>Match setup</h1><div class="card stack"><div class="grid">${boot.players.map(p =>
          `<div>${who(p.id, p.id === boot.me ? 'Kamu' : online.includes(p.id) ? 'Online' : 'Offline')}</div>`).join('')}</div>
          <label>Warnamu<select id="color"><option value="w">Putih (jalan dulu)</option><option value="b">Hitam</option>
          <option value="random">Acak</option></select></label>
          <button id="create">Buat pertandingan</button>
          <p class="muted">Lawanmu harus menerima dari perangkatnya sebelum pertandingan dimulai.</p></div>`;
        $('#create').onclick = () => run(() => api('games', { color: $('#color').value }));
        return;
      }
      const g = live.game, opponent = g.player_white === boot.me ? g.player_black : g.player_white;
      const color = id => id === g.player_white ? 'Putih' : 'Hitam';
      const status = id => online.includes(id) ? 'Online' : 'Offline';
      if (g.status === 'waiting') {
        const mine = g.created_by === boot.me;
        view.innerHTML = `<h1>Konfirmasi pertandingan</h1><div class="card stack">
          ${who(g.player_white, 'Putih · ' + status(g.player_white))}${who(g.player_black, 'Hitam · ' + status(g.player_black))}
          <p>${mine ? 'Menunggu lawan menerima…' : 'Kamu diajak bermain.'}</p><div class="row">
          ${mine ? '' : '<button data-act="accept">Terima dan mulai</button>'}
          <button class="ghost" data-act="cancel">${mine ? 'Batalkan' : 'Tolak'}</button></div></div>`;
      } else {
        const myTurn = live.turn.player_id === boot.me;
        const roll = live.roll;
        // Tampilkan lemparan terakhir bila giliran sekarang belum dikocok.
        const shown = roll || live.rolls.at(-1);
        const animate = prefs.animation && shown && lastRollSeen !== shown.id;
        lastRollSeen = shown?.id ?? null;
        const shownUsed = !shown ? [] : roll ? live.used
          : live.moves.filter(m => m.turn_id === shown.turn_id).flatMap(m => m.die_indexes);
        const last = live.moves.at(-1);
        const targets = live.legal.filter(m => m.from === selected).map(m => m.to);
        const offer = g.draw_offer_by ? ['draw', g.draw_offer_by, 'remis'] : g.abandon_offer_by
          ? ['abandon', g.abandon_offer_by, 'menghentikan pertandingan'] : null;
        view.innerHTML = `<div class="match"><div>
          <div class="card">${who(opponent, `${color(opponent)} · ${status(opponent)}`)}</div>
          ${boardHtml(g.current_fen, { flip: flipFor(g.player_white), sel: selected, targets,
            movable: live.legal.map(m => m.from), last: last ? [last.from_square, last.to_square] : [] })}
          <div class="card">${who(boot.me, `${color(boot.me)} · kamu`)}</div></div>
          <div class="stack"><div class="card turn"><h2>${myTurn ? 'Giliranmu' : `Giliran ${name(live.turn.player_id)}`}</h2>
            <p class="muted">${esc(g.game_code)} · giliran ${live.turn.turn_number} · berlangsung</p>
            ${shown ? `${roll ? '' : `<p class="muted">Lemparan terakhir (${name(shown.player_id)}):</p>`}${diceHtml(shown.dice_values, shownUsed, animate)}
              ${!roll && !shownUsed.length ? '<p>Tidak ada langkah legal, giliran dilewati.</p>' : ''}` : '<p>Belum ada lemparan.</p>'}
            <div class="row" style="margin-top:12px"><button data-act="roll" ${myTurn && !roll ? '' : 'disabled'}>Kocok dadu</button></div>
            ${roll ? `<p>Bidak tersedia: ${roll.available_pieces.map(p => NAMES[p]).join(', ')}</p>
              <p class="muted">${myTurn ? (selected ? `Terpilih: ${selected}. Pilih petak tujuan.` : 'Pilih bidak, lalu petak tujuan.') : 'Menunggu lawan bergerak.'}</p>` : ''}</div>
          ${offer ? `<div class="card"><p>${name(offer[1])} mengajukan ${offer[2]}.</p>${offer[1] === boot.me ? '' :
            `<div class="row"><button data-act="${offer[0]}">Setuju</button><button class="ghost" data-act="decline">Tolak</button></div>`}</div>` : ''}
          <div class="card"><h3>Langkah</h3><p>${live.moves.slice(-9).map(m => `${m.move_number}. ${esc(m.move_san)}`).join(' · ') || 'Belum ada.'}</p>
            <h3>Riwayat dadu</h3><p class="muted">${live.rolls.slice(-5).reverse().map(r =>
              `${name(r.player_id)}: ${r.dice_values.map(v => NAMES[DIE[v]]).join(', ')}`).join('<br>') || 'Belum ada.'}</p>
            <div class="row"><button class="ghost" data-act="draw">Ajukan remis</button>
            <button class="ghost" data-act="abandon">Ajukan berhenti</button>
            <button class="ghost" data-act="resign">Menyerah</button></div></div></div></div>`;
        view.querySelectorAll('.board button').forEach(b => b.onclick = () => clickSquare(b.dataset.sq));
      }
      view.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'resign' && !await confirmBox('Menyerah?', 'Lawanmu akan dicatat sebagai pemenang.')) return;
        if (act === 'roll') beep();
        run(() => api(`games/${g.id}/${act}`, {}));
      });
    };
  },
  async settings() {
    return () => {
      const me = player(boot.me);
      view.innerHTML = `<h1>Settings</h1><div class="grid"><form class="card stack" id="profile"><h2>Profil saya</h2>
        <label>Nama tampilan<input name="displayName" maxlength="24" value="${esc(me.display_name)}" required></label>
        ${avatarPicker('avatar', me.avatar)}<button>Simpan profil</button></form>
        <div class="card stack"><h2>Preferensi perangkat ini</h2>
        <label class="inline"><input type="checkbox" id="sound" ${prefs.sound ? 'checked' : ''}>Suara</label>
        <label class="inline"><input type="checkbox" id="animation" ${prefs.animation ? 'checked' : ''}>Animasi dadu</label>
        <label>Orientasi papan<select id="orientation"><option value="white">Putih selalu di bawah</option>
        <option value="mine" ${prefs.orientation === 'mine' ? 'selected' : ''}>Warnaku di bawah</option></select></label>
        <button class="ghost" id="logout">Keluar dari perangkat ini</button></div>
        <div class="card"><h2>Aturan (dice3-kingcapture-v1)</h2><ul>
        <li>3 dadu per giliran. 1 Pion, 2 Kuda, 3 Gajah, 4 Benteng, 5 Menteri, 6 Raja.</li>
        <li>Satu dadu untuk satu langkah, urutan bebas.</li>
        <li>Wajib memakai dadu sebanyak mungkin. Dadu yang tidak bisa dipakai hangus.</li>
        <li>Tidak ada skak. Menang dengan memakan raja.</li>
        <li>Rokade memakai dadu Raja dan Benteng.</li>
        <li>En passant berlaku pada giliran lawan berikutnya.</li>
        <li>Remis: sepakat, tinggal dua raja, atau 100 giliran tanpa makan dan tanpa gerak pion.</li></ul></div></div>`;
      wirePickers(view);
      onSubmit($('#profile'), async d => { await api('profile', d); await refreshBoot(); toast('Profil disimpan.'); render(); });
      $('#sound').onchange = e => { prefs.sound = e.target.checked; savePrefs(); };
      $('#animation').onchange = e => { prefs.animation = e.target.checked; savePrefs(); };
      $('#orientation').onchange = e => { prefs.orientation = e.target.value; savePrefs(); };
      $('#logout').onclick = async () => { await api('logout', {}); events?.close(); events = null; await start(); };
    };
  },
};

function clickSquare(sq) {
  if (busy) return;
  const options = live.legal.filter(m => m.from === selected && m.to === sq);
  if (!options.length) {
    selected = live.legal.some(m => m.from === sq) && selected !== sq ? sq : null;
    return render();
  }
  const send = uci => { selected = null; beep(); run(() => api(`games/${live.game.id}/move`, { uci })); };
  if (options.length === 1) return send(options[0].uci);
  modal.innerHTML = `<h2>Promosi pion</h2><form method="dialog" class="row">${options.map(o =>
    `<button value="${o.uci}">${NAMES[o.promo]}</button>`).join('')}<button class="ghost" value="">Batal</button></form>`;
  modal.returnValue = '';
  modal.onclose = () => modal.returnValue && send(modal.returnValue);
  modal.showModal();
}

async function run(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { toast(e.message); }
  finally { busy = false; }
  await sync();
}

// Halaman dimuat dulu, baru digambar, agar respons lama tidak menimpa halaman baru.
let renderId = 0;
async function render() {
  if (!boot.me) return;
  const id = ++renderId;
  const [route, arg] = (location.hash.slice(1) || 'dashboard').split('/');
  const page = pages[route] ? route : 'dashboard';
  $('#nav').innerHTML = `<nav aria-label="Utama">${NAV.map(([k, l]) =>
    `<a href="#${k}" ${k === page ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
  try {
    const paint = await pages[page](arg);
    if (id !== renderId) return;
    clearInterval(replayTimer);
    paint();
  } catch (e) { toast(e.message); }
}

async function refreshBoot() { boot = await api('bootstrap'); }

let syncing = false, again = false;
async function sync() {
  if (syncing) { again = true; return; }
  syncing = true;
  try {
    do {
      again = false;
      await refreshBoot();
      const data = await api('live');
      live = data.live; online = data.online; selected = null;
      const page = location.hash.slice(1).split('/')[0] || 'dashboard';
      if (live?.game.status !== 'waiting') $('#toast').textContent.startsWith('Ada ajakan') && ($('#toast').textContent = '');
      if (live?.game.status === 'active') watching = live.game.id;
      else if (watching && !live) {
        const finished = watching; watching = null;
        if (page === 'play') { location.hash = 'match/' + finished; continue; }
      }
      // Jangan menggambar ulang form atau replay yang sedang dipakai.
      if (page === 'play' || page === 'dashboard') await render();
      if (page !== 'play' && live?.game.status === 'waiting' && live.game.created_by !== boot.me)
        toast('Ada ajakan bermain. Buka menu Play.');
    } while (again);
  } catch (e) { toast(e.message); }
  finally { syncing = false; }
}

async function start(route) {
  await refreshBoot();
  $('#nav').hidden = !boot.me;
  if (!boot.players.length) return setupScreen();
  if (!boot.me) return loginScreen();
  if (route) history.replaceState(null, '', '#' + route);
  const data = await api('live');
  live = data.live; online = data.online;
  events?.close();
  events = new EventSource('/api/events');
  events.onmessage = () => sync();
  await render();
}
window.addEventListener('hashchange', () => { selected = null; $('#toast').textContent = ''; render(); });
start().catch(e => toast(e.message));
