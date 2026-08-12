// Persistent user accounts, stored in Supabase (a free hosted database) instead
// of a local file — so accounts survive server restarts/redeploys on Render's
// free tier, where the local disk resets every time.
//
// Requires two environment variables on Render:
//   SUPABASE_URL          — from your Supabase project settings
//   SUPABASE_SERVICE_KEY  — the "service_role" secret key (NOT the public anon key)

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

// Convert a Supabase row (snake_case) to the shape the rest of the app expects (camelCase).
function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    coins: row.coins,
    xp: row.xp,
    level: row.level,
    unlockedStage: row.unlocked_stage,
    completedStages: row.completed_stages || [],
    stageProgress: row.stage_progress || {},
    hintsUsed: row.hints_used,
    wordsFound: row.words_found,
    role: row.role,
    banned: row.banned,
    createdAt: row.created_at,
  };
}

async function findByUsername(username) {
  const { data, error } = await getClient().from('users').select('*').eq('username', username).maybeSingle();
  if (error) throw error;
  return fromRow(data);
}

async function findById(id) {
  const { data, error } = await getClient().from('users').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return fromRow(data);
}

async function createUser({ username, passwordHash }) {
  const { data, error } = await getClient().from('users').insert({
    username, password_hash: passwordHash, coins: 40, xp: 0, level: 1,
    unlocked_stage: 1, completed_stages: [], stage_progress: {},
    hints_used: 0, words_found: 0, role: 'player', banned: false,
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

// patch uses the same camelCase field names as fromRow's output.
async function updateUser(id, patch) {
  const row = {};
  if ('coins' in patch) row.coins = patch.coins;
  if ('xp' in patch) row.xp = patch.xp;
  if ('level' in patch) row.level = patch.level;
  if ('unlockedStage' in patch) row.unlocked_stage = patch.unlockedStage;
  if ('completedStages' in patch) row.completed_stages = patch.completedStages;
  if ('stageProgress' in patch) row.stage_progress = patch.stageProgress;
  if ('hintsUsed' in patch) row.hints_used = patch.hintsUsed;
  if ('wordsFound' in patch) row.words_found = patch.wordsFound;
  if ('banned' in patch) row.banned = patch.banned;
  const { data, error } = await getClient().from('users').update(row).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

async function listAll() {
  const { data, error } = await getClient().from('users').select('*').order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(fromRow);
}

module.exports = { findByUsername, findById, createUser, updateUser, listAll };
