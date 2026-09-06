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

async function createPending({ userId, packageId, priceToman, rewardType, rewardAmount }) {
  const { data, error } = await getClient().from('purchases').insert({
    user_id: userId, package_id: packageId, amount_toman: priceToman,
    reward_type: rewardType, reward_amount: rewardAmount, status: 'pending'
  }).select().single();
  if (error) throw error;
  return data;
}

async function attachTransId(purchaseId, transId) {
  const { error } = await getClient().from('purchases').update({ gateway_transid: transId }).eq('id', purchaseId);
  if (error) throw error;
}

async function findByTransId(transId) {
  const { data, error } = await getClient().from('purchases').select('*').eq('gateway_transid', transId).maybeSingle();
  if (error) throw error;
  return data;
}

// Marks paid ONLY if still pending, atomically, so a gateway that calls back twice for the
// same transaction (which does happen) can never credit the reward a second time.
async function markPaidIfPending(purchaseId) {
  const { data, error } = await getClient().from('purchases')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', purchaseId).eq('status', 'pending')
    .select().maybeSingle();
  if (error) throw error;
  return data; // null if it was already paid/failed — caller must not credit again in that case
}

async function markFailed(purchaseId) {
  const { error } = await getClient().from('purchases').update({ status: 'failed' }).eq('id', purchaseId).eq('status', 'pending');
  if (error) throw error;
}

async function listForUser(userId, limit = 20) {
  const { data, error } = await getClient().from('purchases').select('*')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

async function listAll(limit = 200) {
  const { data, error } = await getClient().from('purchases').select('*')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

module.exports = { createPending, attachTransId, findByTransId, markPaidIfPending, markFailed, listForUser, listAll };
