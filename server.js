require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');

const localDb = require('./db');           // still used for chat / reports / audit / battles (fine to lose on restart)
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
    hintsUsed: u.hintsUsed, wordsFound: u.wordsFound, role: u.role, banned: u.banned
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
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });
    res.json({ user: publicUser(user) });
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
  try { res.json({ players: (await users.listAll()).map(publicUser) }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.post('/api/admin/players/:id/ban', ownerRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const updated = await users.updateUser(target.id, { banned: !!req.body.banned });
    logAudit(req.user.username, updated.banned ? 'BAN' : 'UNBAN', `player #${target.id} (${target.username})`);
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

app.get('/api/admin/reports', adminRequired, (req, res) => { res.json({ reports: localDb.read().reports }); });
app.post('/api/admin/reports/:id/resolve', adminRequired, (req, res) => {
  const data = localDb.read();
  const report = data.reports.find(r => r.id === parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: 'گزارش پیدا نشد' });
  report.status = 'resolved'; localDb.write(data);
  logAudit(req.user.username, 'REPORT_RESOLVE', `report #${report.id}`);
  res.json({ report });
});
app.get('/api/admin/audit-log', adminRequired, (req, res) => { res.json({ log: localDb.read().auditLog.slice(-200).reverse() }); });

app.get('/api/admin/stats', adminRequired, async (req, res) => {
  try {
    const all = await users.listAll();
    const data = localDb.read();
    res.json({
      totalPlayers: all.length,
      bannedPlayers: all.filter(u => u.banned).length,
      totalStagesCompleted: all.reduce((sum, u) => sum + u.completedStages.length, 0),
      totalCoinsInEconomy: all.reduce((sum, u) => sum + u.coins, 0),
      chatMessages: data.chat.length,
      openReports: data.reports.filter(r => r.status !== 'resolved').length,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

const lastMessageAt = new Map();
io.on('connection', (socket) => {
  socket.on('chat:auth', (token) => {
    try { socket.data.user = jwt.verify(token, JWT_SECRET); socket.emit('chat:authed', { username: socket.data.user.username }); }
    catch { socket.emit('chat:error', 'توکن نامعتبر است'); }
  });
  socket.on('chat:send', (text) => {
    const user = socket.data.user;
    if (!user) return socket.emit('chat:error', 'ابتدا وارد شوید');
    const now = Date.now();
    if (now - (lastMessageAt.get(socket.id) || 0) < 1200) return;
    lastMessageAt.set(socket.id, now);
    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;
    const data = localDb.read();
    const msg = { id: localDb.nextId(data.chat), userId: user.id, username: user.username, text: clean, createdAt: new Date().toISOString() };
    data.chat.push(msg);
    if (data.chat.length > 500) data.chat = data.chat.slice(-500);
    localDb.write(data);
    io.emit('chat:message', msg);
  });
  socket.on('chat:report', ({ messageId, reason }) => {
    const user = socket.data.user; if (!user) return;
    const data = localDb.read();
    const msg = data.chat.find(m => m.id === messageId);
    data.reports.push({ id: localDb.nextId(data.reports), reporterId: user.id, targetId: msg ? msg.userId : null, reason: String(reason || '').slice(0, 200), status: 'open', createdAt: new Date().toISOString() });
    localDb.write(data);
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
  socket.on('disconnect', () => { const idx = waitingQueue.indexOf(socket); if (idx !== -1) waitingQueue.splice(idx, 1); });
});
let waitingQueue = [], activeBattles = {}, battleCounter = 1;
function tryMatch() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift(), b = waitingQueue.shift();
    if (!a.connected || !b.connected) continue;
    const battleId = 'b' + (battleCounter++), room = 'battle:' + battleId;
    a.join(room); b.join(room);
    activeBattles[battleId] = { room, players: [a.data.user.id, b.data.user.id], scores: {}, finished: false };
    io.to(room).emit('battle:start', { battleId, opponents: [{ id: a.data.user.id, username: a.data.user.username }, { id: b.data.user.id, username: b.data.user.username }] });
  }
}

// ================= TESTER TOOLS (real, tied to the account's own role) =================
app.post('/api/tester/bugs', testerRequired, async (req, res) => {
  const description = String((req.body && req.body.description) || '').slice(0, 1000).trim();
  if (!description) return res.status(400).json({ error: 'توضیح باگ خالیه' });
  const data = localDb.read();
  const bug = {
    id: localDb.nextId(data.reports), reporterId: req.user.id, reason: 'BUG: ' + description,
    status: 'open', createdAt: new Date().toISOString(),
  };
  data.reports.push(bug);
  localDb.write(data);
  res.json({ ok: true, bug });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Mirza Khan server running on port ' + PORT));
