require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const { STAGES, rewardFor } = require('./stages');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serves /public/admin/index.html at /admin/

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET_BEFORE_REAL_USE';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-admin-password';

// ---------- helpers ----------
function signUserToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ورود لازم است' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'توکن نامعتبر است' });
  }
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'دسترسی ادمین لازم است' });
    next();
  });
}

function logAudit(actor, action, detail) {
  const data = db.read();
  data.auditLog.push({ id: db.nextId(data.auditLog), actor, action, detail, createdAt: new Date().toISOString() });
  db.write(data);
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, coins: u.coins, xp: u.xp, level: u.level,
    unlockedStage: u.unlockedStage, completedStages: u.completedStages,
    hintsUsed: u.hintsUsed, wordsFound: u.wordsFound, role: u.role, banned: u.banned
  };
}

function xpNeededFor(level) { return level * 100; }

function applyXp(user, amount) {
  user.xp += amount;
  while (user.xp >= xpNeededFor(user.level)) {
    user.xp -= xpNeededFor(user.level);
    user.level += 1;
  }
}

// ================= AUTH =================
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'نام کاربری و رمز عبور (حداقل ۴ کاراکتر) لازم است' });
  }
  const data = db.read();
  if (data.users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'این نام کاربری قبلاً گرفته شده' });
  }
  const user = {
    id: db.nextId(data.users),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    coins: 40,
    xp: 0,
    level: 1,
    unlockedStage: 1,
    completedStages: [],
    hintsUsed: 0,
    wordsFound: 0,
    role: 'player',
    banned: false,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  db.write(data);
  res.json({ token: signUserToken(user), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const data = db.read();
  const user = data.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
  }
  if (user.banned) return res.status(403).json({ error: 'این حساب مسدود شده است' });
  res.json({ token: signUserToken(user), user: publicUser(user) });
});

app.get('/api/me', authRequired, (req, res) => {
  const data = db.read();
  const user = data.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  res.json({ user: publicUser(user) });
});

// ================= STAGES =================
app.get('/api/stages', (req, res) => {
  res.json({ stages: STAGES.map(s => ({ id: s.id, name: s.name, wordCount: s.words.length })) });
});

// Client sends which words (in Persian) it believes it found for a stage.
// Server checks each against the real answer list before paying anything.
app.post('/api/stage/:id/complete', authRequired, (req, res) => {
  const stageId = parseInt(req.params.id);
  const stage = STAGES.find(s => s.id === stageId);
  if (!stage) return res.status(404).json({ error: 'مرحله پیدا نشد' });

  const submitted = Array.isArray(req.body.foundWords) ? req.body.foundWords : [];
  const validFound = [...new Set(submitted)].filter(w => stage.words.includes(w));
  const allFound = stage.words.every(w => validFound.includes(w));
  if (!allFound) {
    return res.status(400).json({ error: 'همه‌ی کلمات این مرحله هنوز پیدا نشده‌اند', found: validFound.length, total: stage.words.length });
  }

  const data = db.read();
  const user = data.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });

  const already = user.completedStages.includes(stageId);
  const reward = rewardFor(stage);
  if (!already) {
    user.coins += reward.coins;
    applyXp(user, reward.xp);
    user.completedStages.push(stageId);
    user.wordsFound += stage.words.length;
    if (stageId === user.unlockedStage && user.unlockedStage < STAGES.length) {
      user.unlockedStage += 1;
    }
  }
  db.write(data);
  res.json({ reward: already ? { coins: 0, xp: 0 } : reward, user: publicUser(user) });
});

app.post('/api/stage/hint', authRequired, (req, res) => {
  const cost = 15;
  const data = db.read();
  const user = data.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  if (user.coins < cost) return res.status(400).json({ error: 'سکه کافی نیست' });
  user.coins -= cost;
  user.hintsUsed += 1;
  db.write(data);
  res.json({ user: publicUser(user) });
});

app.get('/api/leaderboard', (req, res) => {
  const data = db.read();
  const top = data.users
    .filter(u => !u.banned)
    .sort((a, b) => (b.level * 100000 + b.xp) - (a.level * 100000 + a.xp))
    .slice(0, 50)
    .map(u => ({ username: u.username, level: u.level, xp: u.xp, completedStages: u.completedStages.length }));
  res.json({ leaderboard: top });
});

// ================= ADMIN =================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'اطلاعات ادمین اشتباه است' });
  }
  const token = jwt.sign({ id: 0, username, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

app.get('/api/admin/players', adminRequired, (req, res) => {
  const data = db.read();
  res.json({ players: data.users.map(publicUser) });
});

app.post('/api/admin/players/:id/ban', adminRequired, (req, res) => {
  const data = db.read();
  const user = data.users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  user.banned = !!req.body.banned;
  db.write(data);
  logAudit(req.user.username, user.banned ? 'BAN' : 'UNBAN', `player #${user.id} (${user.username})`);
  res.json({ user: publicUser(user) });
});

app.post('/api/admin/players/:id/coins', adminRequired, (req, res) => {
  const data = db.read();
  const user = data.users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const delta = parseInt(req.body.delta) || 0;
  user.coins = Math.max(0, user.coins + delta);
  db.write(data);
  logAudit(req.user.username, 'COIN_ADJUST', `player #${user.id} delta=${delta}`);
  res.json({ user: publicUser(user) });
});

app.get('/api/admin/reports', adminRequired, (req, res) => {
  const data = db.read();
  res.json({ reports: data.reports });
});

app.post('/api/admin/reports/:id/resolve', adminRequired, (req, res) => {
  const data = db.read();
  const report = data.reports.find(r => r.id === parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: 'گزارش پیدا نشد' });
  report.status = 'resolved';
  db.write(data);
  logAudit(req.user.username, 'REPORT_RESOLVE', `report #${report.id}`);
  res.json({ report });
});

app.get('/api/admin/audit-log', adminRequired, (req, res) => {
  const data = db.read();
  res.json({ log: data.auditLog.slice(-200).reverse() });
});

app.get('/api/admin/stats', adminRequired, (req, res) => {
  const data = db.read();
  res.json({
    totalPlayers: data.users.length,
    bannedPlayers: data.users.filter(u => u.banned).length,
    totalStagesCompleted: data.users.reduce((sum, u) => sum + u.completedStages.length, 0),
    totalCoinsInEconomy: data.users.reduce((sum, u) => sum + u.coins, 0),
    chatMessages: data.chat.length,
    openReports: data.reports.filter(r => r.status !== 'resolved').length,
  });
});

// ================= CHAT (real-time via Socket.io) =================
// Very simple global chat: connect, send 'chat:send' with a JWT + text.
// Rate-limited per socket to reduce spam.
const lastMessageAt = new Map();

io.on('connection', (socket) => {
  socket.on('chat:auth', (token) => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.data.user = payload;
      socket.emit('chat:authed', { username: payload.username });
    } catch {
      socket.emit('chat:error', 'توکن نامعتبر است');
    }
  });

  socket.on('chat:send', (text) => {
    const user = socket.data.user;
    if (!user) return socket.emit('chat:error', 'ابتدا وارد شوید');
    const now = Date.now();
    const last = lastMessageAt.get(socket.id) || 0;
    if (now - last < 1200) return; // basic anti-spam: ~1 message/1.2s
    lastMessageAt.set(socket.id, now);

    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;

    const data = db.read();
    const msg = { id: db.nextId(data.chat), userId: user.id, username: user.username, text: clean, createdAt: new Date().toISOString() };
    data.chat.push(msg);
    if (data.chat.length > 500) data.chat = data.chat.slice(-500); // keep recent history only
    db.write(data);

    io.emit('chat:message', msg);
  });

  socket.on('chat:report', ({ messageId, reason }) => {
    const user = socket.data.user;
    if (!user) return;
    const data = db.read();
    const msg = data.chat.find(m => m.id === messageId);
    data.reports.push({
      id: db.nextId(data.reports),
      reporterId: user.id,
      targetId: msg ? msg.userId : null,
      reason: String(reason || '').slice(0, 200),
      status: 'open',
      createdAt: new Date().toISOString(),
    });
    db.write(data);
  });

  // ============= ONLINE 1v1 BATTLE (simple matchmaking) =============
  socket.on('battle:join', () => {
    const user = socket.data.user;
    if (!user) return socket.emit('chat:error', 'ابتدا وارد شوید');
    waitingQueue.push(socket);
    tryMatch();
  });

  socket.on('battle:answer', ({ battleId, correct }) => {
    const battle = activeBattles[battleId];
    if (!battle) return;
    const user = socket.data.user;
    if (!battle.players.includes(user.id)) return;
    battle.scores[user.id] = (battle.scores[user.id] || 0) + (correct ? 1 : 0);
    io.to(battle.room).emit('battle:score', battle.scores);
  });

  socket.on('battle:finish', ({ battleId }) => {
    const battle = activeBattles[battleId];
    if (!battle || battle.finished) return;
    battle.finished = true;
    const [p1, p2] = battle.players;
    const s1 = battle.scores[p1] || 0;
    const s2 = battle.scores[p2] || 0;
    const winnerId = s1 === s2 ? null : (s1 > s2 ? p1 : p2);

    if (winnerId) {
      const data = db.read();
      const winner = data.users.find(u => u.id === winnerId);
      if (winner) {
        winner.coins += 30;
        applyXp(winner, 40);
        db.write(data);
      }
    }
    io.to(battle.room).emit('battle:result', { winnerId, scores: battle.scores });
    delete activeBattles[battleId];
  });

  socket.on('disconnect', () => {
    const idx = waitingQueue.indexOf(socket);
    if (idx !== -1) waitingQueue.splice(idx, 1);
  });
});

let waitingQueue = [];
let activeBattles = {};
let battleCounter = 1;

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    const b = waitingQueue.shift();
    if (!a.connected || !b.connected) continue;
    const battleId = 'b' + (battleCounter++);
    const room = 'battle:' + battleId;
    a.join(room);
    b.join(room);
    activeBattles[battleId] = {
      room, players: [a.data.user.id, b.data.user.id], scores: {}, finished: false,
    };
    io.to(room).emit('battle:start', {
      battleId,
      opponents: [
        { id: a.data.user.id, username: a.data.user.username },
        { id: b.data.user.id, username: b.data.user.username },
      ],
    });
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Mirza Khan server running on port ' + PORT));
