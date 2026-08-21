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
    customId: row.custom_id || null,
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
    gems: row.gems || 0,
    inventory: row.inventory || {},
    role: row.role,
    banned: row.banned,
    banUntil: row.ban_until || null,
    createdAt: row.created_at,
  };
}

async function findByUsername(username) {
  const { data, error } = await getClient().from('users').select('*').eq('username', username).maybeSingle();
  if (error) throw error;
  return await autoExpireBan(fromRow(data));
}

async function findById(id) {
  const { data, error } = await getClient().from('users').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  const user = fromRow(data);
  return await autoExpireBan(user);
}

// A temporary ban whose time has passed lifts itself automatically — no admin action needed.
async function autoExpireBan(user) {
  if (user && user.banned && user.banUntil && new Date(user.banUntil).getTime() <= Date.now()) {
    return await updateUser(user.id, { banned: false, banUntil: null });
  }
  return user;
}

async function generateUniqueCustomId() {
  // 7-digit friendly ID like a Telegram/Discord numeric ID — not the small sequential DB id.
  for (let i = 0; i < 10; i++) {
    const candidate = String(Math.floor(1000000 + Math.random() * 9000000));
    const { data } = await getClient().from('users').select('id').eq('custom_id', candidate).maybeSingle();
    if (!data) return candidate;
  }
  return String(Date.now()).slice(-7); // extremely unlikely fallback
}

async function createUser({ username, passwordHash }) {
  const customId = await generateUniqueCustomId();
  const { data, error } = await getClient().from('users').insert({
    username, password_hash: passwordHash, coins: 40, xp: 0, level: 1,
    unlocked_stage: 1, completed_stages: [], stage_progress: {},
    hints_used: 0, words_found: 0, gems: 0, inventory: {}, role: 'player', banned: false,
    custom_id: customId,
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
  if ('gems' in patch) row.gems = patch.gems;
  if ('inventory' in patch) row.inventory = patch.inventory;
  if ('banned' in patch) row.banned = patch.banned;
  if ('banUntil' in patch) row.ban_until = patch.banUntil;
  if ('customId' in patch) row.custom_id = patch.customId;
  if ('role' in patch) row.role = patch.role;
  const { data, error } = await getClient().from('users').update(row).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

async function listAll() {
  const { data, error } = await getClient().from('users').select('*').order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(fromRow);
}

// ===== App-wide settings (maintenance mode) — one row in a tiny table =====
async function getMaintenance() {
  const { data, error } = await getClient().from('app_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!data) return { enabled: false, reason: '', endsAt: null };
  return { enabled: !!data.maintenance_enabled, reason: data.maintenance_reason || '', endsAt: data.maintenance_ends_at || null };
}
async function setMaintenance({ enabled, reason, endsAt }) {
  const { error } = await getClient().from('app_settings').upsert({
    id: 1, maintenance_enabled: !!enabled, maintenance_reason: reason || '', maintenance_ends_at: endsAt || null
  });
  if (error) throw error;
  return { enabled: !!enabled, reason: reason || '', endsAt: endsAt || null };
}

async function deleteUser(id) {
  const { error } = await getClient().from('users').delete().eq('id', id);
  if (error) throw error;
}

module.exports = { findByUsername, findById, createUser, updateUser, deleteUser, listAll, getMaintenance, setMaintenance };
