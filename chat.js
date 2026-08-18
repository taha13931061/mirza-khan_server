// Real, persistent chat storage — Supabase (public chat, group chat, private/DM chat, reports).
// Replaces the old localDb-based chat, which lived on Render's local disk and
// was wiped every time the server restarted or redeployed.
//
// Uses the same Supabase project as supabaseUsers.js (SUPABASE_URL / SUPABASE_SERVICE_KEY).

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

function dmRoom(idA, idB) {
  const a = Math.min(idA, idB), b = Math.max(idA, idB);
  return `dm:${a}-${b}`;
}

async function saveMessage({ room, senderId, senderUsername, text }) {
  const { data, error } = await getClient().from('chat_messages').insert({
    room, sender_id: senderId, sender_username: senderUsername, text
  }).select().single();
  if (error) throw error;
  return {
    id: data.id, room: data.room, userId: data.sender_id,
    username: data.sender_username, text: data.text, createdAt: data.created_at
  };
}

async function getHistory(room, limit = 50) {
  const { data, error } = await getClient()
    .from('chat_messages').select('*').eq('room', room)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).reverse().map(m => ({
    id: m.id, room: m.room, userId: m.sender_id,
    username: m.sender_username, text: m.text, createdAt: m.created_at
  }));
}

async function saveReport({ reporterId, messageId, reason }) {
  const { error } = await getClient().from('chat_reports').insert({
    reporter_id: reporterId, message_id: messageId, reason: String(reason || '').slice(0, 200)
  });
  if (error) throw error;
}

async function listReports() {
  const { data, error } = await getClient().from('chat_reports').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data || []).map(r => ({ id: r.id, reporterId: r.reporter_id, messageId: r.message_id, reason: r.reason, status: r.status, createdAt: r.created_at }));
}

async function resolveReport(id) {
  const { data, error } = await getClient().from('chat_reports').update({ status: 'resolved' }).eq('id', id).select().single();
  if (error) throw error;
  return { id: data.id, reporterId: data.reporter_id, messageId: data.message_id, reason: data.reason, status: data.status, createdAt: data.created_at };
}

async function countOpenReports() {
  const { count, error } = await getClient().from('chat_reports').select('id', { count: 'exact', head: true }).neq('status', 'resolved');
  if (error) throw error;
  return count || 0;
}

async function countMessages() {
  const { count, error } = await getClient().from('chat_messages').select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

async function createGroup(name, creatorId) {
  const { data: group, error } = await getClient().from('chat_groups').insert({
    name: String(name || '').slice(0, 60), creator_id: creatorId
  }).select().single();
  if (error) throw error;
  const { error: memberErr } = await getClient().from('chat_group_members').insert({
    group_id: group.id, user_id: creatorId
  });
  if (memberErr) throw memberErr;
  return { id: group.id, name: group.name, creatorId: group.creator_id };
}

async function joinGroup(groupId, userId) {
  const { error } = await getClient().from('chat_group_members').upsert({
    group_id: groupId, user_id: userId
  });
  if (error) throw error;
}

async function isGroupMember(groupId, userId) {
  const { data } = await getClient().from('chat_group_members').select('user_id')
    .eq('group_id', groupId).eq('user_id', userId).maybeSingle();
  return !!data;
}

async function getGroupMembers(groupId) {
  const { data, error } = await getClient().from('chat_group_members').select('user_id').eq('group_id', groupId);
  if (error) throw error;
  return (data || []).map(r => r.user_id);
}

async function listUserGroups(userId) {
  const { data, error } = await getClient()
    .from('chat_group_members').select('group_id, chat_groups(id, name, creator_id)')
    .eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(r => ({ id: r.chat_groups.id, name: r.chat_groups.name, creatorId: r.chat_groups.creator_id }));
}

async function listAllGroups(limit = 100) {
  const { data, error } = await getClient().from('chat_groups').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []).map(g => ({ id: g.id, name: g.name, creatorId: g.creator_id }));
}

module.exports = {
  dmRoom, saveMessage, getHistory, saveReport, listReports, resolveReport, countOpenReports, countMessages,
  createGroup, joinGroup, isGroupMember, getGroupMembers, listUserGroups, listAllGroups
};
