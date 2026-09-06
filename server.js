require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');

const localDb = require('./db');           // still used for audit log / battle matchmaking state (fine to lose on restart)
const chat = require('./chat');            // real persistent chat/groups/reports (Supabase — survives restarts)
const users = require('./supabaseUsers');  // accounts — persistent, survives restarts
const { STAGES, rewardFor } = require('./stages');
const riddles = require('./riddles');
const progression = require('./progression');
const profanity = require('./profanityFilter'); // filters cursing in chat text, group names, usernames
const friends = require('./friends');           // real friends system (Supabase — replaces the old localStorage-only list)
const battles = require('./battles');            // persistent battle history + wins leaderboard
const store = require('./store');                 // Aqaye Pardakht gateway integration + package list
const purchases = require('./purchases');         // persistent order tracking for real-money purchases
let customStages = []; // loaded from Supabase at boot — lets the owner add stages without a redeploy
async function reloadCustomStages() { try { customStages = await chat.listCustomStages(); } catch (e) { console.error('custom stages load failed', e.message); } }
function findStage(id) { return STAGES.find(s => s.id === id) || customStages.find(s => s.id === id); }
function allStages() { return [...STAGES, ...customStages]; }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Stops brute-force password guessing — max 10 login/register attempts per IP every 15 minutes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'تلاش‌های زیادی انجام شده — چند دقیقه صبر کن و دوباره امتحان کن.' },
});
// A gentler general limit for everything else, so one IP can't hammer the whole API.
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'درخواست‌های زیادی فرستادی — یه لحظه صبر کن.' },
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/', generalLimiter);

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET env var is not set — using a random secret generated at startup.');
  console.warn('⚠️  This is safe (no hardcoded/guessable secret), but every restart logs everyone out.');
  console.warn('⚠️  Set a real JWT_SECRET in Render → Environment for sessions to survive restarts.');
}
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
// Re-fetches the user from the DB and trusts THAT role/ban status, never the JWT's
// embedded copy. The JWT is valid for 30 days, so without this a role change or a ban
// wouldn't take effect until the token expired — a demoted/banned admin could keep
// using admin routes with their old token. Attach the fresh user onto req for reuse.
async function requireFreshUser(req, res) {
  const user = await users.findById(req.user.id);
  if (!user) { res.status(401).json({ error: 'حساب پیدا نشد' }); return null; }
  if (user.banned) { res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true }); return null; }
  req.user.role = user.role; // DB role always wins over the token's (possibly stale) role
  req.freshUser = user;
  return user;
}
function adminRequired(req, res, next) {
  authRequired(req, res, async () => {
    const user = await requireFreshUser(req, res); if (!user) return;
    const ok = ['owner', 'moderator', 'creator'].includes(user.role);
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
    role: u.role, banned: u.banned, banUntil: u.banUntil || null, isStar: !!u.isStar
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
    if (!username || !password || password.length < 6) {
      return res.status(400).json({ error: 'نام کاربری و رمز عبور (حداقل ۶ کاراکتر) لازم است' });
    }
    if (profanity.containsProfanity(username)) {
      return res.status(400).json({ error: 'این نام کاربری مجاز نیست — لطفاً اسم دیگه‌ای انتخاب کن' });
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

// ================= FRIENDS (real, server-verified — replaces the old localStorage-only list) =================
async function friendUserBrief(id) {
  const u = await users.findById(id);
  return u ? { id: u.id, username: u.username, level: u.level } : { id, username: '(حساب حذف شده)', level: 0 };
}
app.get('/api/friends', authRequired, async (req, res) => {
  try {
    const [friendIds, incomingIds, outgoingIds] = await Promise.all([
      friends.listFriends(req.user.id),
      friends.listIncomingRequests(req.user.id),
      friends.listOutgoingRequests(req.user.id),
    ]);
    const [friendsList, incoming, outgoing] = await Promise.all([
      Promise.all(friendIds.map(friendUserBrief)),
      Promise.all(incomingIds.map(friendUserBrief)),
      Promise.all(outgoingIds.map(friendUserBrief)),
    ]);
    res.json({ friends: friendsList, incoming, outgoing });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — جدول friendships رو تو Supabase ساختی؟' }); }
});
app.post('/api/friends/request', authRequired, async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    if (!username) return res.status(400).json({ error: 'یوزرنیم رو بفرست' });
    const target = await users.findByUsername(username);
    if (!target) return res.status(404).json({ error: 'کاربری با این یوزرنیم پیدا نشد' });
    const result = await friends.sendRequest(req.user.id, target.id);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — جدول friendships رو تو Supabase ساختی؟' }); }
});
app.post('/api/friends/respond', authRequired, async (req, res) => {
  try {
    const otherId = parseInt((req.body && req.body.userId) || 0);
    const accept = !!(req.body && req.body.accept);
    if (!otherId) return res.status(400).json({ error: 'کاربر نامشخص است' });
    const result = await friends.respondToRequest(req.user.id, otherId, accept);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.delete('/api/friends/:id', authRequired, async (req, res) => {
  try {
    const otherId = parseInt(req.params.id);
    await friends.removeFriend(req.user.id, otherId);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

// ================= CHAT GROUPS — moderation (existing groups made before the profanity
// filter existed aren't touched retroactively by it, so this is how those get cleaned up) =================
// ================= CHAT MESSAGES — moderation (retroactive cleanup, since the profanity
// filter only stops NEW messages; it never touched what was already stored) =================
app.get('/api/admin/messages', adminRequired, async (req, res) => {
  try {
    const room = req.query.room ? String(req.query.room) : null;
    const onlyFlagged = req.query.flagged !== 'false';
    let msgs = await chat.listRecentMessages(1000);
    if (room) msgs = msgs.filter(m => m.room === room);
    const withFlags = msgs.map(m => ({ ...m, flagged: profanity.containsProfanity(m.text) }));
    res.json({ messages: onlyFlagged ? withFlags.filter(m => m.flagged) : withFlags });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.delete('/api/admin/messages/:id', adminRequired, async (req, res) => {
  try {
    await chat.deleteMessage(parseInt(req.params.id));
    logAudit(req.user.username, 'MESSAGE_DELETE', `message #${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
// Bulk pass: re-runs the current profanity filter over stored history (public + group +
// private) and masks anything that matches, same as if it had been sent after the filter
// existed. Capped at the last 5000 messages per run — re-run again for older history.
app.post('/api/admin/messages/clean', adminRequired, async (req, res) => {
  try {
    const msgs = await chat.listRecentMessages(5000);
    let changed = 0;
    for (const m of msgs) {
      const clean = profanity.censorText(m.text);
      if (clean !== m.text) { await chat.updateMessageText(m.id, clean); changed++; }
    }
    logAudit(req.user.username, 'MESSAGES_BULK_CLEAN', `checked=${msgs.length} changed=${changed}`);
    res.json({ checked: msgs.length, changed });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/admin/groups', adminRequired, async (req, res) => {
  try {
    const groups = await chat.listAllGroups(500);
    const flagged = groups.map(g => ({ ...g, flagged: profanity.containsProfanity(g.name) }));
    res.json({ groups: flagged });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/admin/groups/:id/rename', adminRequired, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'اسم جدید رو بفرست' });
    if (profanity.containsProfanity(name)) return res.status(400).json({ error: 'این اسم هم مجاز نیست' });
    const group = await chat.renameGroup(parseInt(req.params.id), name);
    logAudit(req.user.username, 'GROUP_RENAME', `group #${group.id} -> "${group.name}"`);
    res.json({ group });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.delete('/api/admin/groups/:id', adminRequired, async (req, res) => {
  try {
    await chat.deleteGroup(parseInt(req.params.id));
    logAudit(req.user.username, 'GROUP_DELETE', `group #${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/battles/history', authRequired, async (req, res) => {
  try {
    const history = await battles.getHistory(req.user.id, 10);
    res.json({ history });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — جدول battle_history رو تو Supabase ساختی؟' }); }
});
app.get('/api/battles/leaderboard', async (req, res) => {
  try {
    const rows = await battles.getWinsLeaderboard(20);
    const withNames = await Promise.all(rows.map(async r => {
      const u = await users.findById(r.playerId);
      return { username: u ? u.username : '(حساب حذف شده)', wins: r.wins };
    }));
    res.json({ leaderboard: withNames });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — جدول battle_history رو تو Supabase ساختی؟' }); }
});

// ================= FORCED APP UPDATE =================
// One row (same app_settings row used for maintenance mode) holds the minimum client
// version allowed to play. If the running client's baked-in version is below that, the
// client shows a full-screen, non-dismissable "please update" screen with a button to
// the Myket listing. Fails OPEN (never blocks play) if the config can't be read at all —
// a Supabase hiccup here should never lock everyone out of a game they can't update yet.
app.get('/api/version', async (req, res) => {
  try {
    const cfg = await users.getVersionConfig();
    res.json(cfg);
  } catch (e) { res.json({ minVersion: '0.0.0', updateUrl: '', updateMessage: '' }); }
});
app.post('/api/admin/version', ownerRequired, async (req, res) => {
  try {
    const minVersion = String((req.body && req.body.minVersion) || '').trim();
    const updateUrl = String((req.body && req.body.updateUrl) || '').trim();
    const updateMessage = String((req.body && req.body.updateMessage) || '').trim();
    if (!minVersion) return res.status(400).json({ error: 'شماره نسخه رو بفرست' });
    const cfg = await users.setVersionConfig({ minVersion, updateUrl, updateMessage });
    logAudit(req.user.username, 'VERSION_SET', `minVersion=${cfg.minVersion} url=${cfg.updateUrl}`);
    res.json({ config: cfg });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — جدول app_settings رو تو Supabase ساختی؟' }); }
});

// ================= ADMIN BROADCAST =================
// Reaches players two ways: instantly via socket.io for anyone currently connected, and
// persistently via this same row for anyone who opens the app later — shown once each
// (client remembers the last sentAt it displayed, so re-opening the app doesn't repeat it).
app.get('/api/broadcast', async (req, res) => {
  try {
    const b = await users.getBroadcast();
    res.json(b);
  } catch (e) { res.json({ text: '', sentAt: null }); }
});
app.post('/api/admin/broadcast', adminRequired, async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: 'متن پیام رو بنویس' });
    const b = await users.setBroadcast({ text });
    io.emit('broadcast:message', b);
    logAudit(req.user.username, 'BROADCAST', text);
    res.json(b);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — جدول app_settings رو تو Supabase ساختی؟' }); }
});

// ================= REAL-MONEY STORE (Aqaye Pardakht) =================
app.get('/api/store/packages', (req, res) => {
  res.json({ packages: store.listPackages(), sandbox: store.AQAYEPARDAKHT_PIN === 'sandbox' });
});

app.post('/api/store/purchase-init', authRequired, async (req, res) => {
  try {
    const pkgId = String((req.body && req.body.packageId) || '');
    const pkg = store.getPackage(pkgId);
    if (!pkg) return res.status(400).json({ error: 'بسته‌ی نامعتبر' });

    const purchase = await purchases.createPending({
      userId: req.user.id, packageId: pkgId, priceToman: pkg.priceToman,
      rewardType: pkg.type, rewardAmount: pkg.amount
    });

    // Callback base is derived from the incoming request's own host, so this works
    // whether the shop is opened at the Render URL or at a custom domain pointed at it —
    // no env var to keep in sync with wherever the domain ends up.
    const base = `${req.protocol}://${req.get('host')}`;
    const callbackUrl = `${base}/api/store/verify`;
    const { transId, paymentUrl } = await store.gatewayCreate({
      amountToman: pkg.priceToman, callbackUrl, invoiceId: purchase.id,
      description: `${pkg.label} — میرزاخان`
    });
    await purchases.attachTransId(purchase.id, transId);
    res.json({ paymentUrl });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور در اتصال به درگاه — جدول purchases رو تو Supabase ساختی؟' }); }
});

// Called directly by the gateway's own server after payment — never by the user's
// browser acting on its own, and we re-verify with the gateway using the amount WE
// stored at purchase-init, never anything the incoming request claims. Idempotent:
// markPaidIfPending only succeeds once even if the gateway calls back twice.
app.get('/api/store/verify', async (req, res) => {
  const transId = String(req.query.transid || '');
  const resultPage = (status, msg) => res.redirect(`/shop/result.html?status=${status}&msg=${encodeURIComponent(msg)}`);
  try {
    if (!transId) return resultPage('error', 'اطلاعات تراکنش ناقص است');
    const purchase = await purchases.findByTransId(transId);
    if (!purchase) return resultPage('error', 'تراکنش پیدا نشد');
    if (purchase.status === 'paid') return resultPage('success', 'این خرید قبلاً تایید شده بود');
    if (purchase.status === 'failed') return resultPage('error', 'این تراکنش قبلاً ناموفق ثبت شده بود');

    const verified = await store.gatewayVerify({ amountToman: purchase.amount_toman, transId });
    if (!verified.ok) {
      await purchases.markFailed(purchase.id);
      return resultPage('error', 'پرداخت تایید نشد');
    }

    const claimed = await purchases.markPaidIfPending(purchase.id);
    if (!claimed) return resultPage('success', 'این خرید قبلاً پردازش شده بود');

    const target = await users.findById(purchase.user_id);
    if (target) {
      const field = purchase.reward_type === 'gems' ? 'gems' : 'coins';
      await users.updateUser(target.id, { [field]: (target[field] || 0) + purchase.reward_amount });
      logAudit('store', 'REAL_PURCHASE', `user #${target.id} +${purchase.reward_amount} ${purchase.reward_type} (${purchase.amount_toman} تومان)`);
    }
    return resultPage('success', `${purchase.reward_amount} ${purchase.reward_type === 'gems' ? 'جم' : 'سکه'} به حسابت اضافه شد!`);
  } catch (e) {
    console.error(e);
    return resultPage('error', 'خطای سرور');
  }
});

app.get('/api/stages', (req, res) => {
  res.json({ stages: allStages().map(s => ({ id: s.id, name: s.name, wordCount: s.words.length })) });
});

app.get('/api/stage/:id/play', authRequired, async (req, res) => {
  const stage = findStage(parseInt(req.params.id));
  if (!stage) return res.status(404).json({ error: 'مرحله پیدا نشد' });
  try {
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });
    const canBypassLock = user.isStar || ['tester', 'owner', 'creator', 'moderator'].includes(user.role);
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
  const stage = findStage(parseInt(req.params.id));
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
    progression.incrementProgress(user.id, 'find_word', 1).catch(e => console.error('progress err', e.message));

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
      progression.incrementProgress(user.id, 'complete_stage', 1).catch(e => console.error('progress err', e.message));
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
  const stage = findStage(stageId);
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
  const stage = findStage(parseInt(req.params.id));
  if (!stage) return res.status(404).json({ error: 'مرحله پیدا نشد' });
  try {
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if (user.banned) return res.status(403).json({ error: 'حساب شما مسدود شده است', banned: true });
    const cost = user.isStar ? 0 : 15;
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
  authRequired(req, res, async () => {
    const user = await requireFreshUser(req, res); if (!user) return;
    if (user.role !== 'owner' && user.role !== 'creator') {
      return res.status(403).json({ error: 'فقط سازنده/مدیر اصلی دسترسی دارد' });
    }
    next();
  });
}
function testerRequired(req, res, next) {
  authRequired(req, res, async () => {
    const user = await requireFreshUser(req, res); if (!user) return;
    const ok = ['tester', 'owner', 'creator'].includes(user.role);
    if (!ok) return res.status(403).json({ error: 'دسترسی پنل تستر لازم است' });
    next();
  });
}
function inspectorRequired(req, res, next) {
  authRequired(req, res, async () => {
    const user = await requireFreshUser(req, res); if (!user) return;
    const ok = ['inspector', 'owner', 'creator'].includes(user.role);
    if (!ok) return res.status(403).json({ error: 'دسترسی پنل بازرسی لازم است' });
    next();
  });
}

app.get('/api/inspector/suspicious-users', inspectorRequired, async (req, res) => {
  try {
    const all = await users.listAll();
    // Simple, explainable heuristic: big coin balance with very little real progress,
    // or a lot of hints used relative to words actually found — worth a human look, not proof of cheating.
    const flagged = all.filter(u =>
      (u.coins > 5000 && u.completedStages.length < 5) ||
      (u.hintsUsed > 20 && u.wordsFound < 5)
    ).map(u => ({
      id: u.id, username: u.username, level: u.level, coins: u.coins, gems: u.gems,
      reason: (u.coins > 5000 && u.completedStages.length < 5)
        ? 'سکه‌ی زیاد با پیشرفت خیلی کم'
        : 'استفاده‌ی زیاد از راهنما با کلمه‌ی خیلی کم'
    }));
    res.json({ users: flagged });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/inspector/user-logs', inspectorRequired, async (req, res) => {
  try {
    const q = String(req.query.username || req.query.userId || '').trim();
    if (!q) return res.status(400).json({ error: 'یوزرنیم یا User ID رو بفرست' });
    const log = localDb.read().auditLog.filter(l => l.detail && l.detail.includes(q));
    res.json({ log: log.slice(-100).reverse() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.get('/api/inspector/ban-reports', inspectorRequired, async (req, res) => {
  try {
    const all = await users.listAll();
    const banned = all.filter(u => u.banned).map(u => ({
      id: u.id, username: u.username, banUntil: u.banUntil,
      type: u.banUntil ? 'موقت' : 'دائمی'
    }));
    res.json({ bans: banned });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

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

// Owner-only, irreversible. The requesting owner can never delete their own account this way.
app.delete('/api/admin/players/:id', ownerRequired, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) return res.status(400).json({ error: 'نمی‌تونی حساب خودت رو حذف کنی' });
    const target = await users.findById(targetId);
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    await users.deleteUser(targetId);
    logAudit(req.user.username, 'DELETE_ACCOUNT', `player #${targetId} (${target.username})`);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

app.post('/api/admin/stages', ownerRequired, async (req, res) => {
  try {
    const { letters, words, name, charEmoji, charName } = req.body || {};
    if (!Array.isArray(letters) || !letters.length) return res.status(400).json({ error: 'حروف مرحله رو بفرست' });
    if (!Array.isArray(words) || !words.length) return res.status(400).json({ error: 'کلمات مرحله رو بفرست' });
    if (!name) return res.status(400).json({ error: 'اسم مرحله رو بفرست' });
    const availableLetters = {};
    for (const l of letters) availableLetters[l] = (availableLetters[l] || 0) + 1;
    for (const w of words) {
      const need = {};
      for (const ch of w) need[ch] = (need[ch] || 0) + 1;
      for (const ch in need) if ((availableLetters[ch] || 0) < need[ch]) {
        return res.status(400).json({ error: `کلمه "${w}" با حروف داده‌شده ساخته نمی‌شه (حرف "${ch}" کمه)` });
      }
    }
    const nextId = Math.max(0, ...allStages().map(s => s.id)) + 1;
    const stage = { id: nextId, letters, words, name, char: { emoji: charEmoji || '🎮', name: charName || 'شخصیت مرحله' } };
    await chat.addCustomStage(stage);
    customStages.push(stage);
    logAudit(req.user.username, 'ADD_STAGE', `stage #${nextId} (${name})`);
    res.json({ stage });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/admin/players/:id/ban', adminRequired, async (req, res) => {
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

app.post('/api/admin/players/:id/coins', adminRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const delta = parseInt(req.body.delta) || 0;
    const updated = await users.updateUser(target.id, { coins: Math.max(0, target.coins + delta) });
    logAudit(req.user.username, 'COIN_ADJUST', `player #${target.id} delta=${delta}`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

// ================= STAR EDITION =================
// One flag on the account, checked server-side wherever a perk matters (hearts, hints,
// stage unlock) — never trusted from the client. Whoever built the APK (normal-branded
// or Star-branded) doesn't matter; what the ACCOUNT is flagged as does.
app.post('/api/admin/players/:id/star', adminRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const isStar = !!(req.body && req.body.isStar);
    const updated = await users.updateUser(target.id, { isStar });
    logAudit(req.user.username, 'STAR_TOGGLE', `player #${target.id} isStar=${isStar}`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور — ستون is_star رو تو Supabase ساختی؟' }); }
});

app.post('/api/admin/players/:id/gems', adminRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const delta = parseInt(req.body.delta) || 0;
    const updated = await users.updateUser(target.id, { gems: Math.max(0, (target.gems || 0) + delta) });
    logAudit(req.user.username, 'GEM_ADJUST', `player #${target.id} delta=${delta}`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

// XP change — mirrors the coins/gems adjust endpoints, but keeps level in sync with xp
// the same way normal stage-completion rewards do (via applyXp), instead of just writing
// a raw xp number that could leave a player's level and xp inconsistent with each other.
app.post('/api/admin/players/:id/xp', adminRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const delta = parseInt(req.body.delta) || 0;
    const temp = { xp: target.xp, level: target.level };
    if (delta >= 0) applyXp(temp, delta);
    else temp.xp = Math.max(0, temp.xp + delta); // moving xp backwards never drops the level automatically
    const updated = await users.updateUser(target.id, { xp: temp.xp, level: Math.max(1, temp.level) });
    logAudit(req.user.username, 'XP_ADJUST', `player #${target.id} delta=${delta}`);
    res.json({ user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});

// "جان" (hearts) — the game already tracks extra hearts bought from the shop in
// inventory.extraHearts (see SHOP_ITEMS below), so admin adjustment reuses that same
// field instead of inventing a second, disconnected notion of hearts.
app.post('/api/admin/players/:id/hearts', adminRequired, async (req, res) => {
  try {
    const target = await users.findById(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    const delta = parseInt(req.body.delta) || 0;
    const inventory = Object.assign({}, target.inventory, {
      extraHearts: Math.max(0, (target.inventory?.extraHearts || 0) + delta)
    });
    const updated = await users.updateUser(target.id, { inventory });
    logAudit(req.user.username, 'HEARTS_ADJUST', `player #${target.id} delta=${delta}`);
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
// Auto-mute for repeat profanity offenders — separate from manual admin bans. Strikes
// decay after CHAT_STRIKE_WINDOW_MS of clean chatting, so one bad night doesn't follow
// someone forever; hitting the threshold mutes chat (not the account) for CHAT_MUTE_MS.
const chatStrikes = new Map(); // userId -> { count, lastAt }
const chatMuted = new Map();   // userId -> mutedUntil (epoch ms)
const CHAT_STRIKE_WINDOW_MS = 30 * 60 * 1000;
const CHAT_STRIKES_TO_MUTE = 3;
const CHAT_MUTE_MS = 15 * 60 * 1000;
function mkChatMuteRemaining(userId) {
  const until = chatMuted.get(userId);
  return until && until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0;
}
function mkRegisterProfanityStrike(userId) {
  const now = Date.now();
  const s = chatStrikes.get(userId);
  const fresh = (!s || now - s.lastAt > CHAT_STRIKE_WINDOW_MS) ? { count: 0, lastAt: now } : s;
  fresh.count += 1; fresh.lastAt = now;
  if (fresh.count >= CHAT_STRIKES_TO_MUTE) {
    chatMuted.set(userId, now + CHAT_MUTE_MS);
    chatStrikes.delete(userId);
    return true; // just got muted
  }
  chatStrikes.set(userId, fresh);
  return false;
}
const presence = new Map(); // userId -> { status: 'online'|'playing', socketId }
const userSockets = new Map(); // userId -> Set<socket> — for direct group/DM delivery
function setPresence(userId, status) { presence.set(userId, { status, at: Date.now() }); }
io.on('connection', (socket) => {
  socket.on('chat:auth', async (token) => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      // Trust the DB's role/ban status at auth time, not whatever the token happened
      // to carry (a role change or ban shouldn't wait up to 30 days for the JWT to expire).
      const dbUser = await users.findById(payload.id);
      if (!dbUser) return socket.emit('chat:error', 'حساب پیدا نشد');
      if (dbUser.banned) return socket.emit('chat:error', 'حساب شما مسدود شده است');
      socket.data.user = { id: dbUser.id, username: dbUser.username, role: dbUser.role };
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
    // A ban issued after this socket connected must still take effect immediately —
    // re-check fresh, not just whatever was true when this socket authed.
    const freshSender = await users.findById(user.id).catch(() => null);
    if (!freshSender || freshSender.banned) return socket.emit('chat:error', 'حساب شما مسدود شده است');
    const mutedFor = mkChatMuteRemaining(user.id);
    if (mutedFor > 0) return socket.emit('chat:error', `به‌خاطر فحاشی تکراری، چتت تا ${mutedFor} دقیقه‌ی دیگه مسدوده`);
    const now = Date.now();
    if (now - (lastMessageAt.get(socket.id) || 0) < 1200) return;
    lastMessageAt.set(socket.id, now);
    const raw = String(text || '').slice(0, 300).trim();
    const clean = profanity.censorText(raw);
    if (!clean) return;
    if (clean !== raw) {
      const justMuted = mkRegisterProfanityStrike(user.id);
      if (justMuted) return socket.emit('chat:error', `به‌خاطر فحاشی تکراری، چتت به مدت ${Math.round(CHAT_MUTE_MS / 60000)} دقیقه مسدود شد`);
    }
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
  socket.on('chat:dm_list', async (_payload, cb) => {
    const user = socket.data.user; if (!user) return cb && cb({ error: 'ابتدا وارد شوید' });
    try {
      const rows = await chat.listDmConversations(user.id, 500);
      const conversations = await Promise.all(rows.map(async r => {
        const other = await users.findById(r.otherId);
        return {
          otherId: r.otherId, otherUsername: other ? other.username : '(حساب حذف شده)',
          lastText: r.lastText, lastAt: r.lastAt, lastFromMe: r.lastSenderId === user.id
        };
      }));
      conversations.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
      cb && cb({ conversations });
    } catch (e) { console.error(e); cb && cb({ error: 'خطای سرور' }); }
  });
  socket.on('group:create', async ({ name } = {}, cb) => {
    const user = socket.data.user; if (!user) return cb && cb({ error: 'ابتدا وارد شوید' });
    const freshCreator = await users.findById(user.id).catch(() => null);
    if (!freshCreator || freshCreator.banned) return cb && cb({ error: 'حساب شما مسدود شده است' });
    if (!name || !name.trim()) return cb && cb({ error: 'اسم گروه رو بنویس' });
    if (profanity.containsProfanity(name)) return cb && cb({ error: 'این اسم گروه مجاز نیست' });
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
    try { await chat.saveReport({ reporterId: user.id, reporterUsername: user.username, messageId, reason }); }
    catch (e) { console.error(e); }
  });
  socket.on('battle:join', ({ level } = {}) => {
    const user = socket.data.user; if (!user) return socket.emit('chat:error', 'ابتدا وارد شوید');
    level = ['green', 'yellow', 'red'].includes(level) ? level : 'green';
    if (!battleQueues[level].includes(socket)) battleQueues[level].push(socket);
    socket.data.battleLevel = level;
    tryMatch(level);
  });
  socket.on('battle:answer_riddle', ({ battleId, riddleId, answer } = {}, cb) => {
    const battle = activeBattles[battleId]; if (!battle) return cb && cb({ error: 'مسابقه پیدا نشد' });
    const user = socket.data.user; if (!battle.players.includes(user.id)) return cb && cb({ error: 'دسترسی نداری' });
    if (battle.finished) return cb && cb({ error: 'مسابقه تموم شده' });
    const riddle = battle.riddles.find(r => r.id === riddleId); if (!riddle) return cb && cb({ error: 'سوال پیدا نشد' });
    if (!battle.solved[user.id]) battle.solved[user.id] = new Set();
    const normalize = s => String(s || '').trim().replace(/[\u200c\s]+/g, '');
    const correct = normalize(answer) === normalize(riddle.answer);
    if (correct) battle.solved[user.id].add(riddleId);
    const scores = {}; for (const pid of battle.players) scores[pid] = (battle.solved[pid] || new Set()).size;
    io.to(battle.room).emit('battle:score', scores);
    cb && cb({ correct });
    // Finishing first (all 5 correct) locks YOUR result in, but the reveal to both
    // players only happens once the opponent has also finished — no early spoilers.
    if (correct && battle.solved[user.id].size >= battle.riddles.length && !battle.completions[user.id]) {
      battle.completions[user.id] = { n: battle.solved[user.id].size, at: Date.now() };
      io.to(socket.id).emit('battle:you_finished');
      maybeResolveBattle(battleId);
    }
  });
  socket.on('battle:finish', async ({ battleId }) => {
    const battle = activeBattles[battleId]; if (!battle || battle.finished) return;
    const pid = socket.data.user?.id; if (!pid || battle.completions[pid]) return;
    battle.completions[pid] = { n: (battle.solved[pid] || new Set()).size, at: Date.now() };
    maybeResolveBattle(battleId);
  });
  socket.on('disconnect', () => {
    ['green', 'yellow', 'red'].forEach(l => { const idx = battleQueues[l].indexOf(socket); if (idx !== -1) battleQueues[l].splice(idx, 1); });
    if (socket.data.user) {
      presence.delete(socket.data.user.id);
      const set = userSockets.get(socket.data.user.id);
      if (set) { set.delete(socket); if (set.size === 0) userSockets.delete(socket.data.user.id); }
    }
  });
});
let battleQueues = { green: [], yellow: [], red: [] }, activeBattles = {}, battleCounter = 1;
function tryMatch(level) {
  const q = battleQueues[level];
  while (q.length >= 2) {
    const a = q.shift(), b = q.shift();
    if (!a.connected || !b.connected) continue;
    const battleId = 'b' + (battleCounter++), room = 'battle:' + battleId;
    a.join(room); b.join(room);
    const stageRiddles = riddles.pickFive(level);
    activeBattles[battleId] = {
      room, level, players: [a.data.user.id, b.data.user.id],
      playerUsernames: { [a.data.user.id]: a.data.user.username, [b.data.user.id]: b.data.user.username },
      riddles: stageRiddles, solved: {}, completions: {}, finished: false,
    };
    setPresence(a.data.user.id, 'playing'); setPresence(b.data.user.id, 'playing');
    const publicRiddles = stageRiddles.map(r => ({ id: r.id, question: r.question }));
    io.to(room).emit('battle:start', {
      battleId, level, riddles: publicRiddles,
      opponents: [{ id: a.data.user.id, username: a.data.user.username }, { id: b.data.user.id, username: b.data.user.username }]
    });
  }
}
function maybeResolveBattle(battleId) {
  const battle = activeBattles[battleId]; if (!battle || battle.finished) return;
  if (Object.keys(battle.completions).length < battle.players.length) return; // wait for both — no early spoilers
  const results = battle.players.map(pid => ({ pid, ...(battle.completions[pid] || { n: (battle.solved[pid] || new Set()).size, at: Infinity }) }));
  results.sort((x, y) => (y.n - x.n) || (x.at - y.at)); // higher score wins; tie broken by who finished first
  const winnerId = results[0].n === results[1].n ? null : results[0].pid;
  finishBattle(battleId, winnerId);
}
async function finishBattle(battleId, winnerId) {
  const battle = activeBattles[battleId]; if (!battle || battle.finished) return;
  battle.finished = true;
  const scores = {}; for (const pid of battle.players) scores[pid] = (battle.solved[pid] || new Set()).size;
  if (winnerId) {
    try {
      const reward = riddles.REWARDS[battle.level] || riddles.REWARDS.green;
      const winner = await users.findById(winnerId);
      if (winner) {
        const tempUser = { xp: winner.xp, level: winner.level };
        applyXp(tempUser, 40);
        await users.updateUser(winnerId, { coins: winner.coins + reward.coins, gems: (winner.gems || 0) + reward.gems, xp: tempUser.xp, level: tempUser.level });
        progression.incrementProgress(winnerId, 'win_battle', 1).catch(e => console.error('progress err', e.message));
      }
    } catch (e) { console.error(e); }
  }
  io.to(battle.room).emit('battle:result', { winnerId, scores, level: battle.level });
  // Persist the match so "leaderboard by wins" and "my recent matches" have something to
  // read — best-effort: a logging hiccup here should never stop the result from reaching
  // the players or block their reward payout above.
  try {
    const players = battle.players.map(id => ({ id, username: battle.playerUsernames?.[id] || '?' }));
    await battles.recordBattleResult({ battleId, level: battle.level, players, scores, winnerId });
  } catch (e) { console.error('battle history log failed', e.message); }
  delete activeBattles[battleId];
}

// ================= TESTER TOOLS (real, tied to the account's own role) =================
app.post('/api/tester/bugs', testerRequired, async (req, res) => {
  const description = String((req.body && req.body.description) || '').slice(0, 1000).trim();
  if (!description) return res.status(400).json({ error: 'توضیح باگ خالیه' });
  try {
    await chat.saveReport({ reporterId: req.user.id, reporterUsername: req.user.username, messageId: null, reason: 'BUG: ' + description });
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

// ================= EVENTS + DAILY MISSIONS + DAILY REWARD (real, server-verified) =================
app.get('/api/progress', authRequired, async (req, res) => {
  try { res.json(await progression.getUserBoard(req.user.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/progress/claim', authRequired, async (req, res) => {
  try {
    const { itemType, itemId } = req.body || {};
    if (!['event', 'mission'].includes(itemType)) return res.status(400).json({ error: 'نوع نامعتبر' });
    const result = await progression.claimProgress(req.user.id, itemType, parseInt(itemId));
    if (result.error) return res.status(400).json({ error: result.error });
    const user = await users.findById(req.user.id);
    const updated = await users.updateUser(user.id, { coins: user.coins + result.rewardCoins, gems: (user.gems || 0) + result.rewardGems });
    res.json({ ok: true, user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.get('/api/daily-reward', authRequired, async (req, res) => {
  try { res.json(await progression.getDailyStatus(req.user.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/daily-reward/claim', authRequired, async (req, res) => {
  try {
    const result = await progression.claimDailyReward(req.user.id);
    if (result.error) return res.status(400).json({ error: result.error });
    const user = await users.findById(req.user.id);
    const updated = await users.updateUser(user.id, { coins: user.coins + result.coins, gems: (user.gems || 0) + result.gems });
    res.json({ ok: true, streak: result.streak, coins: result.coins, gems: result.gems, user: publicUser(updated) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/admin/events', ownerRequired, async (req, res) => {
  try {
    const { title, description, type, target, rewardCoins, rewardGems } = req.body || {};
    if (!title || !type || !target) return res.status(400).json({ error: 'اسم، نوع و هدف رو پر کن' });
    const event = await progression.createEvent({ title, description, type, target: parseInt(target), rewardCoins: parseInt(rewardCoins) || 0, rewardGems: parseInt(rewardGems) || 0 });
    logAudit(req.user.username, 'CREATE_EVENT', `event #${event.id} (${title})`);
    res.json({ event });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/admin/missions', ownerRequired, async (req, res) => {
  try {
    const { title, description, type, target, rewardCoins, rewardGems } = req.body || {};
    if (!title || !type || !target) return res.status(400).json({ error: 'اسم، نوع و هدف رو پر کن' });
    const mission = await progression.createMission({ title, description, type, target: parseInt(target), rewardCoins: parseInt(rewardCoins) || 0, rewardGems: parseInt(rewardGems) || 0 });
    logAudit(req.user.username, 'CREATE_MISSION', `mission #${mission.id} (${title})`);
    res.json({ mission });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/admin/events/:id/toggle', ownerRequired, async (req, res) => {
  try { await progression.toggleEvent(parseInt(req.params.id), !!req.body.active); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.post('/api/admin/missions/:id/toggle', ownerRequired, async (req, res) => {
  try { await progression.toggleMission(parseInt(req.params.id), !!req.body.active); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.get('/api/admin/events', adminRequired, async (req, res) => {
  try { res.json({ events: await progression.listActiveEvents() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});
app.get('/api/admin/missions', adminRequired, async (req, res) => {
  try { res.json({ missions: await progression.listActiveMissions() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطای سرور' }); }
});


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
    if (!['tester', 'inspector', 'moderator'].includes(role)) return res.status(400).json({ error: 'نقش باید tester، inspector یا moderator باشد' });
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
    const panelUsers = all.filter(u => ['tester', 'inspector', 'moderator'].includes(u.role)).map(publicUser);
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
reloadCustomStages();
