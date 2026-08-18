require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');

const localDb = require('./db');           // still used for audit log / battle matchmaking state (fine to lose on restart)
const chat = require('./chat');            // real persistent chat/groups/reports (Supabase — survives restarts)
const users = require('./supabaseUsers');  // accounts — persistent, survives restarts
const { STAGES, rewardFor } = require('./stages');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET_BEFORE_REAL_USE';
// (Old hardcoded ADMIN_USERNAME/ADMIN_PASSWORD env vars are no longer used —
// admin access is now a real 'owner'/'moderator' role on a real account.)

function signUserToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ورود لازم است' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'توکن نامعتبر است' }); }
}
function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    const ok = ['owner', 'moderator', 'creator'].includes(req.user.role);
    if (!ok) return res.status(403).json({ error: 'دسترسی پنل مدیریت لازم است' });
    next();
  });
}
function logAudit(actor, action, detail) {
  const data = localDb.read();
  data.auditLog.push({ id: localDb.nextId(data.auditLog), actor, action, detail, createdAt: new Date().toISOString() });
  localDb.write(data);
}
function publicUser(u) {
  return {
    id: u.id, customId: u.customId || null, username: u.username, coins: u.coins, xp: u.xp, level: u.level,
    unlockedStage: u.unlockedStage, completedStages: u.completedStages, stageProgress: u.stageProgress,
    hintsUsed: u.hintsUsed, wordsFound: u.wordsFound, gems: u.gems || 0, inventory: u.inventory || {},
    role: u.role, banned: u.banned, banUntil: u.banUntil || null
  };
}
function xpNeededFor(level) { return level * 100; }
function applyXp(user, amount) {
  user.xp += amount;
  while (user.xp >= xpNeededFor(user.level)) { user.xp -= xpNeededFor(user.level); user.level += 1; }
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password || password.length < 4) {
      return res.status(400).json({ error: 'نام کاربری و رمز عبور (حداقل ۴ کاراکتر) لازم است' });
    }
    const existing = await users.findByUsername(username);
    if (existing) return res.status(409).json({ error: 'این نام کاربری قبلاً گرفته شده' });
    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await users.createUser({ username, passwordHash });
    res.json({ token: signUserToken(user), user: publicUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — بعداً دوباره امتحان کن' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await users.findByUsername(username);
    if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
      return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
    }
    if (user.banned) return res.status(403).json({ error: 'این حساب مسدود شده است' });
    res.json({ token: signUserToken(user), user: publicUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — بعداً دوباره امتحان کن' }); }
});

app.get('/api/me', authRequired, async (req, res) => {
  try {
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    let maintenance = { enabled: false };
    try { maintenance = await users.getMaintenance(); } catch (e) {}
    // owner/creator/tester can keep playing during maintenance to actually test it
    const bypass = ['owner', 'creator', 'tester'].includes(user.role);
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });
    res.json({ user: publicUser(user), maintenance: (maintenance.enabled && !bypass) ? maintenance : null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/users/lookup', authRequired, async (req, res) => {
  try {
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ error: 'یوزرنیم رو بفرست' });
    const target = await users.findByUsername(username);
    if (!target) return res.status(404).json({ error: 'کاربری با این یوزرنیم پیدا نشد' });
    res.json({ user: { id: target.id, username: target.username } }); // only non-sensitive fields
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/stages', (req, res) => {
  res.json({ stages: STAGES.map(s => ({ id: s.id, name: s.name, wordCount: s.words.length })) });
});

app.get('/api/stage/:id/play', authRequired, async (req, res) => {
  const stage = STAGES.find(s => s.id === parseInt(req.params.id));
  if (!stage) return res.status(404).json({ error: 'مرحله پیدا نشد' });
  try {
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });
    const canBypassLock = ['tester', 'owner', 'creator', 'moderator'].includes(user.role);
    if (!canBypassLock && stage.id > user.unlockedStage) return res.status(403).json({ error: 'این مرحله هنوز باز نشده' });
    const progress = (user.stageProgress && user.stageProgress[stage.id]) || [];
    res.json({
      id: stage.id, name: stage.name, letters: stage.letters, char: stage.char,
      wordLengths: stage.words.map(w => w.length).sort((a, b) => a - b),
      foundWords: progress,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.post('/api/stage/:id/check', authRequired, async (req, res) => {
  const stage = STAGES.find(s => s.id === parseInt(req.params.id));
  if (!stage) return res.status(404).json({ error: 'مرحله پیدا نشد' });
  const word = String((req.body && req.body.word) || '').trim();
  try {
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });

    const isValidWord = stage.words.includes(word);
    const progress = new Set((user.stageProgress && user.stageProgress[stage.id]) || []);
    const alreadyFound = progress.has(word);

    if (!isValidWord) return res.json({ correct: false });
    if (alreadyFound) return res.json({ correct: true, alreadyFound: true });

    progress.add(word);
    const stageProgress = Object.assign({}, user.stageProgress, { [stage.id]: Array.from(progress) });
    const allFound = stage.words.every(w => progress.has(w));

    let reward = { coins: 0, xp: 0 };
    let patch = { stageProgress };

    if (allFound && !user.completedStages.includes(stage.id)) {
      reward = rewardFor(stage);
      patch.coins = user.coins + reward.coins;
      patch.wordsFound = user.wordsFound + stage.words.length;
      patch.completedStages = user.completedStages.concat([stage.id]);
      const tempUser = { xp: user.xp, level: user.level };
      applyXp(tempUser, reward.xp);
      patch.xp = tempUser.xp; patch.level = tempUser.level;
      if (stage.id === user.unlockedStage && user.unlockedStage < STAGES.length) {
        patch.unlockedStage = user.unlockedStage + 1;
      }
    }

    const updated = await users.updateUser(user.id, patch);
    res.json({ correct: true, word, allFound, stageComplete: allFound, reward, user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

// Skip the current stage: costs coins, does NOT count as completed (no reward),
// but unlocks the next stage so the player isn't stuck.
app.post('/api/stage/skip', authRequired, async (req, res) => {
  const cost = 30;
  const stageId = parseInt((req.body && req.body.stageId) || 0);
  const stage = STAGES.find(s => s.id === stageId);
  if (!stage) return res.status(404).json({ error: 'مرحله پیدا نشد' });
  try {
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });
    if (stage.id !== user.unlockedStage) return res.status(400).json({ error: 'فقط مرحله‌ی فعلی رو می‌شه رد کرد' });
    if (user.coins < cost) return res.status(400).json({ error: 'سکه کافی نیست' });

    const patch = { coins: user.coins - cost };
    if (user.unlockedStage < STAGES.length) patch.unlockedStage = user.unlockedStage + 1;
    const updated = await users.updateUser(user.id, patch);
    res.json({ user: publicUser(updated), nextStageId: patch.unlockedStage || user.unlockedStage });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.post('/api/stage/:id/hint', authRequired, async (req, res) => {
  const cost = 15;
  const stage = STAGES.find(s => s.id === parseInt(req.params.id));
  if (!stage) return res.status(404).json({ error: 'مرحله پیدا نشد' });
  try {
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });
    if (user.coins < cost) return res.status(400).json({ error: 'سکه کافی نیست' });

    const progress = new Set((user.stageProgress && user.stageProgress[stage.id]) || []);
    const unsolved = stage.words.filter(w => !progress.has(w));
    if (unsolved.length === 0) return res.status(400).json({ error: 'همه‌ی کلمات این مرحله پیدا شده‌اند' });

    // Reveal one real letter from an unsolved word — costs coins, and only
    // gives a small piece of the answer, never the whole word.
    const target = unsolved[0];
    const index = Math.floor(Math.random() * target.length);
    const letter = target[index];

    const updated = await users.updateUser(user.id, { coins: user.coins - cost, hintsUsed: user.hintsUsed + 1 });
    res.json({ user: publicUser(updated), reveal: { wordLength: target.length, index, letter } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const all = await users.listAll();
    const top = all.filter(u => !u.banned)
      .sort((a, b) => (b.level * 100000 + b.xp) - (a.level * 100000 + a.xp))
      .slice(0, 50)
      .map(u => ({ username: u.username, level: u.level, xp: u.xp, completedStages: u.completedStages.length }));
    res.json({ leaderboard: top });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

// Admin access is now a real role on a real account (owner / moderator),
// checked server-side from the JWT — not a separate hardcoded password.
// To make someone an owner, run this once in Supabase SQL Editor:
//   update users set role = 'owner' where username = 'their_username';
function ownerRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== 'owner' && req.user.role !== 'creator') {
      return res.status(403).json({ error: 'فقط سازنده/مدیر اصلی دسترسی دارد' });
    }
    next();
  });
}
function testerRequired(req, res, next) {
  authRequired(req, res, () => {
    const ok = ['tester', 'owner', 'creator'].includes(req.user.role);
    if (!ok) return res.status(403).json({ error: 'دسترسی پنل تستر لازم است' });
    next();
  });
}

app.get('/api/admin/players', adminRequired, async (req, res) => {
  try {
    const list = (await users.listAll()).map(u => {
      const pub = publicUser(u);
      pub.presence = pub.banned ? (pub.banUntil ? 'tempban' : 'ban') : (presence.get(u.id)?.status || 'offline');
      return pub;
    });
    res.json({ players: list });
  }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.post('/api/admin/players/:id/ban', ownerRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const banned = !!req.body.banned;
    // durationMinutes present => temporary ban; absent/0 with banned=true => permanent ban
    const durationMinutes = parseInt(req.body.durationMinutes) || 0;
    const banUntil = banned && durationMinutes > 0 ? new Date(Date.now() + durationMinutes * 60000).toISOString() : null;
    const updated = await users.updateUser(target.id, { banned, banUntil });
    logAudit(req.user.username, banned ? (banUntil ? 'TEMP_BAN' : 'BAN') : 'UNBAN', `player #${target.id} (${target.username})${banUntil ? ' until ' + banUntil : ''}`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.post('/api/admin/players/:id/coins', ownerRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const delta = parseInt(req.body.delta) || 0;
    const updated = await users.updateUser(target.id, { coins: Math.max(0, target.coins + delta) });
    logAudit(req.user.username, 'COIN_ADJUST', `player #${target.id} delta=${delta}`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.post('/api/admin/players/:id/gems', ownerRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const delta = parseInt(req.body.delta) || 0;
    const updated = await users.updateUser(target.id, { gems: Math.max(0, (target.gems || 0) + delta) });
    logAudit(req.user.username, 'GEM_ADJUST', `player #${target.id} delta=${delta}`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

const VALID_ROLES = ['player', 'tester', 'inspector', 'moderator', 'owner', 'creator'];
app.post('/api/admin/players/:id/role', ownerRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const role = String((req.body && req.body.role) || '').trim();
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'نقش نامعتبر است' });
    const updated = await users.updateUser(target.id, { role });
    logAudit(req.user.username, 'ROLE_CHANGE', `player #${target.id} (${target.username}) -> ${role}`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/admin/reports', adminRequired, async (req, res) => {
  try { res.json({ reports: await chat.listReports() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/admin/reports/:id/resolve', adminRequired, async (req, res) => {
  try {
    const report = await chat.resolveReport(parseInt(req.params.id));
    logAudit(req.user.username, 'REPORT_RESOLVE', `report #${report.id}`);
    res.json({ report });
  } catch (e) { console.error(e); res.status(500).json({ error: 'گزارش پیدا نشد' }); }
});
app.get('/api/admin/audit-log', adminRequired, (req, res) => { res.json({ log: localDb.read().auditLog.slice(-200).reverse() }); });

app.get('/api/admin/stats', adminRequired, async (req, res) => {
  try {
    const all = await users.listAll();
    const [chatMessages, openReports] = await Promise.all([chat.countMessages(), chat.countOpenReports()]);
    res.json({
      totalPlayers: all.length,
      bannedPlayers: all.filter(u => u.banned).length,
      totalStagesCompleted: all.reduce((sum, u) => sum + u.completedStages.length, 0),
      totalCoinsInEconomy: all.reduce((sum, u) => sum + u.coins, 0),
      chatMessages,
      openReports,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

const lastMessageAt = new Map();
const presence = new Map(); // userId -> { status: 'online'|'playing', socketId }
const userSockets = new Map(); // userId -> Set<socket> — for direct group/DM delivery
function setPresence(userId, status) { presence.set(userId, { status, at: Date.now() }); }
io.on('connection', (socket) => {
  socket.on('chat:auth', (token) => {
    try {
      socket.data.user = jwt.verify(token, JWT_SECRET);
      socket.emit('chat:authed', { username: socket.data.user.username });
      setPresence(socket.data.user.id, 'online');
      if (!userSockets.has(socket.data.user.id)) userSockets.set(socket.data.user.id, new Set());
      userSockets.get(socket.data.user.id).add(socket);
    }
    catch { socket.emit('chat:error', 'توکن نامعتبر است'); }
  });
  socket.on('presence:playing', () => { if (socket.data.user) setPresence(socket.data.user.id, 'playing'); });
  socket.on('presence:idle', () => { if (socket.data.user) setPresence(socket.data.user.id, 'online'); });
  socket.on('chat:send', async ({ room, text } = {}) => {
    const user = socket.data.user;
    if (!user) return socket.emit('chat:error', 'ابتدا وارد شوید');
    const now = Date.now();
    if (now - (lastMessageAt.get(socket.id) || 0) < 1200) return;
    lastMessageAt.set(socket.id, now);
    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;
    room = String(room || 'public');
    try {
      let targetRoom = room;
      let recipients = null; // null = broadcast to everyone (public room)
      if (room === 'public') {
        recipients = null;
      } else if (room.startsWith('group:')) {
        const groupId = parseInt(room.slice(6));
        if (!(await chat.isGroupMember(groupId, user.id))) return socket.emit('chat:error', 'عضو این گروه نیستی');
        recipients = await chat.getGroupMembers(groupId);
      } else if (room.startsWith('dm:')) {
        // client sends dm:<otherUserId> as a request — resolve to the canonical room key
        const otherId = parseInt(room.slice(3));
        targetRoom = chat.dmRoom(user.id, otherId);
        recipients = [user.id, otherId];
      } else {
        return socket.emit('chat:error', 'اتاق نامعتبر است');
      }
      const msg = await chat.saveMessage({ room: targetRoom, senderId: user.id, senderUsername: user.username, text: clean });
      if (recipients === null) {
        io.emit('chat:message', msg);
      } else {
        for (const uid of recipients) {
          const sockets = userSockets.get(uid);
          if (sockets) for (const s of sockets) s.emit('chat:message', msg);
        }
      }
    } catch (e) { console.error(e); socket.emit('chat:error', 'ارسال پیام انجام نشد'); }
  });
  socket.on('chat:history', async ({ room } = {}, cb) => {
    const user = socket.data.user;
    if (!user) return cb && cb({ error: 'ابتدا وارد شوید' });
    room = String(room || 'public');
    try {
      let targetRoom = room;
      if (room.startsWith('group:')) {
        const groupId = parseInt(room.slice(6));
        if (!(await chat.isGroupMember(groupId, user.id))) return cb && cb({ error: 'عضو این گروه نیستی' });
      } else if (room.startsWith('dm:')) {
        const otherId = parseInt(room.slice(3));
        targetRoom = chat.dmRoom(user.id, otherId);
      }
      const messages = await chat.getHistory(targetRoom);
      cb && cb({ messages });
    } catch (e) { console.error(e); cb && cb({ error: 'خطای سرور' }); }
  });
  socket.on('group:create', async ({ name } = {}, cb) => {
    const user = socket.data.user; if (!user) return cb && cb({ error: 'ابتدا وارد شوید' });
    if (!name || !name.trim()) return cb && cb({ error: 'اسم گروه رو بنویس' });
    try { const group = await chat.createGroup(name.trim(), user.id); cb && cb({ group }); }
    catch (e) { console.error(e); cb && cb({ error: 'ساخت گروه انجام نشد' }); }
  });
  socket.on('group:join', async ({ groupId } = {}, cb) => {
    const user = socket.data.user; if (!user) return cb && cb({ error: 'ابتدا وارد شوید' });
    try { await chat.joinGroup(parseInt(groupId), user.id); cb && cb({ ok: true }); }
    catch (e) { console.error(e); cb && cb({ error: 'عضویت انجام نشد' }); }
  });
  socket.on('group:mine', async (_payload, cb) => {
    const user = socket.data.user; if (!user) return cb && cb({ error: 'ابتدا وارد شوید' });
    try { const groups = await chat.listUserGroups(user.id); cb && cb({ groups }); }
    catch (e) { console.error(e); cb && cb({ error: 'خطای سرور' }); }
  });
  socket.on('group:all', async (_payload, cb) => {
    const user = socket.data.user; if (!user) return cb && cb({ error: 'ابتدا وارد شوید' });
    try { const groups = await chat.listAllGroups(); cb && cb({ groups }); }
    catch (e) { console.error(e); cb && cb({ error: 'خطای سرور' }); }
  });
  socket.on('chat:report', async ({ messageId, reason } = {}) => {
    const user = socket.data.user; if (!user) return;
    try { await chat.saveReport({ reporterId: user.id, messageId, reason }); }
    catch (e) { console.error(e); }
  });
  socket.on('battle:join', () => {
    const user = socket.data.user; if (!user) return socket.emit('chat:error', 'ابتدا وارد شوید');
    waitingQueue.push(socket); tryMatch();
  });
  socket.on('battle:answer', ({ battleId, correct }) => {
    const battle = activeBattles[battleId]; if (!battle) return;
    const user = socket.data.user; if (!battle.players.includes(user.id)) return;
    battle.scores[user.id] = (battle.scores[user.id] || 0) + (correct ? 1 : 0);
    io.to(battle.room).emit('battle:score', battle.scores);
  });
  socket.on('battle:finish', async ({ battleId }) => {
    const battle = activeBattles[battleId]; if (!battle || battle.finished) return;
    battle.finished = true;
    const [p1, p2] = battle.players;
    const s1 = battle.scores[p1] || 0, s2 = battle.scores[p2] || 0;
    const winnerId = s1 === s2 ? null : (s1 > s2 ? p1 : p2);
    if (winnerId) {
      try {
        const winner = await users.findById(winnerId);
        if (winner) {
          const tempUser = { xp: winner.xp, level: winner.level };
          applyXp(tempUser, 40);
          await users.updateUser(winnerId, { coins: winner.coins + 30, xp: tempUser.xp, level: tempUser.level });
        }
      } catch (e) { console.error(e); }
    }
    io.to(battle.room).emit('battle:result', { winnerId, scores: battle.scores });
    delete activeBattles[battleId];
  });
  socket.on('disconnect', () => {
    const idx = waitingQueue.indexOf(socket); if (idx !== -1) waitingQueue.splice(idx, 1);
    if (socket.data.user) {
      presence.delete(socket.data.user.id);
      const set = userSockets.get(socket.data.user.id);
      if (set) { set.delete(socket); if (set.size === 0) userSockets.delete(socket.data.user.id); }
    }
  });
});
let waitingQueue = [], activeBattles = {}, battleCounter = 1;
function tryMatch() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift(), b = waitingQueue.shift();
    if (!a.connected || !b.connected) continue;
    const battleId = 'b' + (battleCounter++), room = 'battle:' + battleId;
    a.join(room); b.join(room);
    activeBattles[battleId] = { room, players: [a.data.user.id, b.data.user.id], scores: {}, finished: false };
    setPresence(a.data.user.id, 'playing'); setPresence(b.data.user.id, 'playing');
    io.to(room).emit('battle:start', { battleId, opponents: [{ id: a.data.user.id, username: a.data.user.username }, { id: b.data.user.id, username: b.data.user.username }] });
  }
}

// ================= TESTER TOOLS (real, tied to the account's own role) =================
app.post('/api/tester/bugs', testerRequired, async (req, res) => {
  const description = String((req.body && req.body.description) || '').slice(0, 1000).trim();
  if (!description) return res.status(400).json({ error: 'توضیح باگ خالیه' });
  try {
    await chat.saveReport({ reporterId: req.user.id, messageId: null, reason: 'BUG: ' + description });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

// Resets the CALLING tester's own account progress only — never another account.
app.post('/api/tester/reset', testerRequired, async (req, res) => {
  try {
    const updated = await users.updateUser(req.user.id, {
      coins: 40, xp: 0, level: 1, unlockedStage: 1, completedStages: [], stageProgress: {},
      hintsUsed: 0, wordsFound: 0,
    });
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ================= MAINTENANCE MODE (real — replaces the old fake test-mode button) =================
app.get('/api/maintenance/status', async (req, res) => {
  try { res.json(await users.getMaintenance()); }
  catch (e) { res.json({ enabled: false, reason: '', endsAt: null }); } // fail open so a missing table never locks the whole game out
});
app.post('/api/admin/maintenance', ownerRequired, async (req, res) => {
  try {
    const { enabled, reason, endsAt } = req.body || {};
    const result = await users.setMaintenance({ enabled, reason, endsAt });
    logAudit(req.user.username, enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF', reason || '');
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — جدول app_settings رو تو Supabase ساختی؟' }); }
});

// ================= OWNER: create dedicated tester/inspector panel accounts =================
app.post('/api/admin/create-panel-account', ownerRequired, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password || password.length < 6) return res.status(400).json({ error: 'یوزرنیم و رمز (حداقل ۶ کاراکتر) لازم است' });
    if (!['tester', 'inspector'].includes(role)) return res.status(400).json({ error: 'نقش باید tester یا inspector باشد' });
    const existing = await users.findByUsername(username);
    if (existing) return res.status(400).json({ error: 'این یوزرنیم قبلاً گرفته شده' });
    const passwordHash = await bcrypt.hash(password, 10);
    const created = await users.createUser({ username, passwordHash });
    const updated = await users.updateUser(created.id, { role });
    logAudit(req.user.username, 'CREATE_PANEL_ACCOUNT', `${role} account #${updated.id} (${username})`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.get('/api/admin/panel-accounts', adminRequired, async (req, res) => {
  try {
    const all = await users.listAll();
    const panelUsers = all.filter(u => ['tester', 'inspector'].includes(u.role)).map(publicUser);
    res.json({ users: panelUsers });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});


// ================= SHOP (server-validated — client can never grant itself items) =================
const SHOP_ITEMS = {
  hint3:      { price: 30, cur: 'coins', key: 'extraHints',  amount: 3 },
  hint10:     { price: 8,  cur: 'gems',  key: 'extraHints',  amount: 10 },
  heart1:     { price: 20, cur: 'coins', key: 'extraHearts', amount: 1 },
  heart5:     { price: 6,  cur: 'gems',  key: 'extraHearts', amount: 5 },
  frame_gold: { price: 15, cur: 'gems',  key: 'frame_gold',  amount: 1, once: true },
  skip1:      { price: 25, cur: 'gems',  key: 'stageSkips',  amount: 1 },
};
app.post('/api/shop/buy', authRequired, async (req, res) => {
  try {
    const itemId = String((req.body && req.body.itemId) || '');
    const item = SHOP_ITEMS[itemId];
    if (!item) return res.status(400).json({ error: 'آیتم نامعتبر است' });
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });
    const inventory = Object.assign({}, user.inventory);
    if (item.once && inventory[item.key]) return res.status(400).json({ error: 'قبلاً این آیتم رو داری' });
    const balance = item.cur === 'coins' ? user.coins : (user.gems || 0);
    if (balance < item.price) return res.status(400).json({ error: 'موجودی کافی نیست' });
    const patch = { inventory: Object.assign({}, inventory, { [item.key]: (inventory[item.key] || 0) + item.amount }) };
    if (item.cur === 'coins') patch.coins = user.coins - item.price;
    else patch.gems = (user.gems || 0) - item.price;
    const updated = await users.updateUser(user.id, patch);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Mirza Khan server running on port ' + PORT));
