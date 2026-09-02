// Real, persistent friends system — Supabase (replaces the old localStorage-only
// list, which was never actually connected to any server and only existed on one
// device, wasn't visible to the other person, and had no request/accept step).
//
// One row per friendship pair, always stored with the smaller id first (user_a) so a
// pair is never duplicated in both directions. status is 'pending' until the addressee
// accepts, then becomes 'accepted'. requested_by records who sent the request, since
// user_a isn't necessarily the sender.

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

function pairKey(idA, idB) {
  return idA < idB ? { userA: idA, userB: idB } : { userA: idB, userB: idA };
}

async function sendRequest(fromId, toId) {
  if (fromId === toId) return { error: 'نمی‌تونی به خودت درخواست بدی' };
  const { userA, userB } = pairKey(fromId, toId);
  const client = getClient();
  const { data: existing } = await client.from('friendships').select('*')
    .eq('user_a', userA).eq('user_b', userB).maybeSingle();
  if (existing) {
    if (existing.status === 'accepted') return { error: 'قبلاً با این کاربر دوستید' };
    if (existing.requested_by === fromId) return { error: 'درخواست قبلاً فرستاده شده' };
    // the other person already sent a request — this request just accepts it
    return await respond(existing.user_a, existing.user_b, fromId, true);
  }
  const { error } = await client.from('friendships').insert({
    user_a: userA, user_b: userB, status: 'pending', requested_by: fromId
  });
  if (error) throw error;
  return { ok: true, status: 'pending' };
}

async function respond(userA, userB, respondingUserId, accept) {
  const client = getClient();
  if (!accept) {
    const { error } = await client.from('friendships').delete().eq('user_a', userA).eq('user_b', userB);
    if (error) throw error;
    return { ok: true, status: 'declined' };
  }
  const { error } = await client.from('friendships').update({ status: 'accepted' }).eq('user_a', userA).eq('user_b', userB);
  if (error) throw error;
  return { ok: true, status: 'accepted' };
}

async function respondToRequest(userId, otherId, accept) {
  const { userA, userB } = pairKey(userId, otherId);
  const client = getClient();
  const { data: existing } = await client.from('friendships').select('*').eq('user_a', userA).eq('user_b', userB).maybeSingle();
  if (!existing || existing.status !== 'pending') return { error: 'درخواستی پیدا نشد' };
  if (existing.requested_by === userId) return { error: 'نمی‌تونی به درخواست خودت جواب بدی' };
  return await respond(userA, userB, userId, accept);
}

async function removeFriend(userId, otherId) {
  const { userA, userB } = pairKey(userId, otherId);
  const { error } = await getClient().from('friendships').delete().eq('user_a', userA).eq('user_b', userB);
  if (error) throw error;
  return { ok: true };
}

async function listFriends(userId) {
  const client = getClient();
  const { data, error } = await client.from('friendships').select('*')
    .or(`user_a.eq.${userId},user_b.eq.${userId}`).eq('status', 'accepted');
  if (error) throw error;
  return (data || []).map(r => (r.user_a === userId ? r.user_b : r.user_a));
}

async function listIncomingRequests(userId) {
  const client = getClient();
  const { data, error } = await client.from('friendships').select('*')
    .or(`user_a.eq.${userId},user_b.eq.${userId}`).eq('status', 'pending');
  if (error) throw error;
  return (data || [])
    .filter(r => r.requested_by !== userId) // only requests sent TO this user, not by them
    .map(r => (r.user_a === userId ? r.user_b : r.user_a));
}

async function listOutgoingRequests(userId) {
  const client = getClient();
  const { data, error } = await client.from('friendships').select('*')
    .or(`user_a.eq.${userId},user_b.eq.${userId}`).eq('status', 'pending');
  if (error) throw error;
  return (data || [])
    .filter(r => r.requested_by === userId)
    .map(r => (r.user_a === userId ? r.user_b : r.user_a));
}

module.exports = { sendRequest, respondToRequest, removeFriend, listFriends, listIncomingRequests, listOutgoingRequests };
