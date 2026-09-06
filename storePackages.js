// Store packages now live in Supabase instead of being hardcoded, so the admin panel can
// add/disable/remove them without a code change + redeploy every time a price changes.

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

function rowToPkg(row) {
  return {
    id: row.id, label: row.label, priceToman: row.price_toman,
    type: row.reward_type, amount: row.reward_amount, active: !!row.active
  };
}

async function listAll(activeOnly) {
  let q = getClient().from('store_packages').select('*').order('price_toman', { ascending: true });
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(rowToPkg);
}

async function get(id) {
  const { data, error } = await getClient().from('store_packages').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? rowToPkg(data) : null;
}

async function create({ id, label, priceToman, type, amount }) {
  const { error } = await getClient().from('store_packages').insert({
    id, label, price_toman: priceToman, reward_type: type, reward_amount: amount, active: true
  });
  if (error) throw error;
  return await get(id);
}

async function setActive(id, active) {
  const { error } = await getClient().from('store_packages').update({ active }).eq('id', id);
  if (error) throw error;
}

async function remove(id) {
  const { error } = await getClient().from('store_packages').delete().eq('id', id);
  if (error) throw error;
}

module.exports = { listAll, get, create, setActive, remove };
