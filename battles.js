// Persistent record of finished online battles — Supabase. Two rows are written per
// finished battle (one per player, each seeing the other as "opponent") so that both
// "my recent matches" and "wins per player" are a single WHERE on player_id, no joins.

const { createClient } = require('@supabase/supabase-js');

let supabase = null;
function getClient() {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY environment variables are not set.');
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return supabase;
}

// players: [{ id, username }, { id, username }] — exactly two.
async function recordBattleResult({ battleId, level, players, scores, winnerId }) {
  const rows = players.map(p => {
    const opponent = players.find(o => o.id !== p.id);
    const result = !winnerId ? 'draw' : (winnerId === p.id ? 'win' : 'loss');
    return {
      battle_id: battleId, level, player_id: p.id,
      opponent_id: opponent ? opponent.id : null,
      opponent_username: opponent ? opponent.username : null,
      result, score: scores[p.id] || 0, opponent_score: opponent ? (scores[opponent.id] || 0) : 0
    };
  });
  const { error } = await getClient().from('battle_history').insert(rows);
  if (error) throw error;
}

async function getHistory(playerId, limit = 10) {
  const { data, error } = await getClient().from('battle_history').select('*')
    .eq('player_id', playerId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id, level: r.level, opponentUsername: r.opponent_username,
    result: r.result, score: r.score, opponentScore: r.opponent_score, createdAt: r.created_at
  }));
}

// No SQL GROUP BY available without an RPC function, so this pulls recent win rows and
// tallies them in JS. Capped at 20000 rows — plenty for a single game's battle volume;
// re-visit with a real aggregate query if the table ever gets that big.
async function getWinsLeaderboard(limit = 20) {
  const { data, error } = await getClient().from('battle_history').select('player_id').eq('result', 'win').limit(20000);
  if (error) throw error;
  const counts = {};
  for (const r of (data || [])) counts[r.player_id] = (counts[r.player_id] || 0) + 1;
  return Object.entries(counts)
    .map(([playerId, wins]) => ({ playerId: Number(playerId), wins }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, limit);
}

module.exports = { recordBattleResult, getHistory, getWinsLeaderboard };
