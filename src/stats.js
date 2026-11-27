// Semua statistik dihitung dari catatan pertandingan; tidak ada nilai turunan yang disimpan.
export function statistics(db) {
  const players = db.prepare('SELECT id FROM players ORDER BY slot').all();
  const games = db.prepare(`SELECT * FROM game_sessions WHERE status='completed'
    ORDER BY finished_at, id`).all();
  const avg = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  const perPlayer = Object.fromEntries(players.map(({ id }) => {
    let wins = 0, losses = 0, draws = 0, streak = 0, longest = 0;
    for (const g of games) {
      if (g.winner === id) { wins++; streak++; longest = Math.max(longest, streak); }
      else { streak = 0; g.winner ? losses++ : draws++; }
    }
    return [id, {
      total: games.length, wins, losses, draws,
      winRate: games.length ? wins / games.length : 0,
      averageDuration: avg(games.map(g => g.duration_seconds)),
      averageMoves: avg(games.map(g => g.total_moves)),
      totalPlayingTime: games.reduce((a, g) => a + g.duration_seconds, 0),
      longestStreak: longest, currentStreak: streak,
      lastPlayed: games.at(-1)?.finished_at ?? null,
    }];
  }));
  const lastDecisive = [...games].reverse().find(g => g.winner);
  return {
    players: perPlayer,
    headToHead: {
      total: games.length,
      draws: games.filter(g => !g.winner).length,
      abandoned: db.prepare("SELECT COUNT(*) AS n FROM game_sessions WHERE status='abandoned'").get().n,
      decisiveRate: games.length ? games.filter(g => g.winner).length / games.length : 0,
      mostRecentWinner: lastDecisive?.winner ?? null,
      history: games.map(g => ({ id: g.id, code: g.game_code, winner: g.winner, finished_at: g.finished_at })),
    },
  };
}
