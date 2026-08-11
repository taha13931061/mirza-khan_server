// Simple file-based database (no external database service needed).
// Good enough for a small personal game on a free host.
// IMPORTANT: on most free hosts, the filesystem is NOT permanent — if the
// server restarts/redeploys, data may reset. For real persistence, later
// swap this file for a real database (e.g. Supabase/Postgres). The rest of
// the app talks to this module only, so swapping the storage layer later
// will not require changes anywhere else.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function ensureFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      users: [],       // { id, username, passwordHash, coins, xp, level, unlockedStage, completedStages: [], hintsUsed, wordsFound, role, banned, createdAt }
      chat: [],         // { id, userId, username, text, createdAt }
      reports: [],       // { id, reporterId, targetId, reason, status, createdAt }
      battles: {},       // battleId -> { players: [id,id], scores: {}, status, winnerId }
      auditLog: []        // { id, actor, action, detail, createdAt }
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}

function read() {
  ensureFile();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function nextId(arr) {
  return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1;
}

module.exports = { read, write, nextId };
