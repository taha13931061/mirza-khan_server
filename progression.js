// Real, server-verified Events + Daily Missions + Daily Reward system.
// Progress only ever increments from real server-verified actions (stage completed,
// battle won) — never from a client-reported number — so this can't be faked.

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

const EVENT_SENTINEL_DAY = '2000-01-01'; // events aren't daily — progress is for the event's whole lifetime
function today() { return new Date().toISOString().slice(0, 10); }

async function listActiveEvents() {
  const { data, error } = await getClient().from('game_events').select('*').eq('active', true).order('id', { ascending: false });
  if (error) throw error;
  return data || [];
}
async function listActiveMissions() {
  const { data, error } = await getClient().from('daily_missions').select('*').eq('active', true).order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}
async function createEvent({ title, description, type, target, rewardCoins, rewardGems }) {
  const { data, error } = await getClient().from('game_events').insert({
    title, description: description || '', type, target, reward_coins: rewardCoins || 0, reward_gems: rewardGems || 0, active: true
  }).select().single();
  if (error) throw error;
  return data;
}
async function createMission({ title, description, type, target, rewardCoins, rewardGems }) {
  const { data, error } = await getClient().from('daily_missions').insert({
    title, description: description || '', type, target, reward_coins: rewardCoins || 0, reward_gems: rewardGems || 0, active: true
  }).select().single();
  if (error) throw error;
  return data;
}
async function toggleEvent(id, active) {
  const { error } = await getClient().from('game_events').update({ active }).eq('id', id);
  if (error) throw error;
}
async function toggleMission(id, active) {
  const { error } = await getClient().from('daily_missions').update({ active }).eq('id', id);
  if (error) throw error;
}

async function getProgressRows(userId, itemType, days) {
  const { data, error } = await getClient().from('progress_log').select('*')
    .eq('user_id', userId).eq('item_type', itemType).in('day', days);
  if (error) throw error;
  return data || [];
}

// Called from real server actions only (stage completion, battle win) — this is the
// only way progress can ever move, so client can't fake it.
async function incrementProgress(userId, type, amount) {
  amount = amount || 1;
  const client = getClient();
  const [events, missions] = await Promise.all([listActiveEvents(), listActiveMissions()]);
  const matchingEvents = events.filter(e => e.type === type);
  const matchingMissions = missions.filter(m => m.type === type);
  for (const e of matchingEvents) {
    const day = EVENT_SENTINEL_DAY;
    const { data: row } = await client.from('progress_log').select('*').eq('user_id', userId).eq('item_type', 'event').eq('item_id', e.id).eq('day', day).maybeSingle();
    const newProgress = Math.min(e.target, (row?.progress || 0) + amount);
    await client.from('progress_log').upsert({ user_id: userId, item_type: 'event', item_id: e.id, day, progress: newProgress, claimed: row?.claimed || false });
  }
  for (const m of matchingMissions) {
    const day = today();
    const { data: row } = await client.from('progress_log').select('*').eq('user_id', userId).eq('item_type', 'mission').eq('item_id', m.id).eq('day', day).maybeSingle();
    const newProgress = Math.min(m.target, (row?.progress || 0) + amount);
    await client.from('progress_log').upsert({ user_id: userId, item_type: 'mission', item_id: m.id, day, progress: newProgress, claimed: row?.claimed || false });
  }
}

async function getUserBoard(userId) {
  const [events, missions] = await Promise.all([listActiveEvents(), listActiveMissions()]);
  const eventRows = await getProgressRows(userId, 'event', [EVENT_SENTINEL_DAY]);
  const missionRows = await getProgressRows(userId, 'mission', [today()]);
  const eventMap = Object.fromEntries(eventRows.map(r => [r.item_id, r]));
  const missionMap = Object.fromEntries(missionRows.map(r => [r.item_id, r]));
  return {
    events: events.map(e => ({
      id: e.id, title: e.title, description: e.description, target: e.target,
      rewardCoins: e.reward_coins, rewardGems: e.reward_gems,
      progress: eventMap[e.id]?.progress || 0, claimed: eventMap[e.id]?.claimed || false
    })),
    missions: missions.map(m => ({
      id: m.id, title: m.title, description: m.description, target: m.target,
      rewardCoins: m.reward_coins, rewardGems: m.reward_gems,
      progress: missionMap[m.id]?.progress || 0, claimed: missionMap[m.id]?.claimed || false
    })),
  };
}

async function claimProgress(userId, itemType, itemId) {
  const client = getClient();
  const day = itemType === 'event' ? EVENT_SENTINEL_DAY : today();
  const table = itemType === 'event' ? 'game_events' : 'daily_missions';
  const { data: item } = await client.from(table).select('*').eq('id', itemId).maybeSingle();
  if (!item) return { error: 'پیدا نشد' };
  const { data: row } = await client.from('progress_log').select('*').eq('user_id', userId).eq('item_type', itemType).eq('item_id', itemId).eq('day', day).maybeSingle();
  if (!row || row.progress < item.target) return { error: 'هنوز کامل نشده' };
  if (row.claimed) return { error: 'قبلاً دریافت شده' };
  await client.from('progress_log').update({ claimed: true }).eq('user_id', userId).eq('item_type', itemType).eq('item_id', itemId).eq('day', day);
  return { ok: true, rewardCoins: item.reward_coins, rewardGems: item.reward_gems };
}

// Daily login reward — a simple 7-day escalating streak, resets if a day is missed.
const DAILY_REWARDS = [
  { coins: 10, gems: 0 }, { coins: 15, gems: 0 }, { coins: 20, gems: 1 }, { coins: 25, gems: 1 },
  { coins: 30, gems: 2 }, { coins: 40, gems: 2 }, { coins: 60, gems: 5 },
];
async function getDailyStatus(userId) {
  const { data } = await getClient().from('daily_rewards').select('*').eq('user_id', userId).maybeSingle();
  const claimedToday = data?.last_claim === today();
  const streak = data?.streak || 0;
  return { streak, claimedToday, nextReward: DAILY_REWARDS[streak % 7] };
}
async function claimDailyReward(userId) {
  const client = getClient();
  const { data } = await client.from('daily_rewards').select('*').eq('user_id', userId).maybeSingle();
  const t = today();
  if (data?.last_claim === t) return { error: 'امروز قبلاً گرفتی' };
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newStreak = data?.last_claim === yesterday ? (data.streak + 1) : 0;
  const reward = DAILY_REWARDS[newStreak % 7];
  await client.from('daily_rewards').upsert({ user_id: userId, streak: newStreak, last_claim: t });
  return { ok: true, streak: newStreak, ...reward };
}

module.exports = {
  listActiveEvents, listActiveMissions, createEvent, createMission, toggleEvent, toggleMission,
  incrementProgress, getUserBoard, claimProgress, getDailyStatus, claimDailyReward,
};
