"use strict";

// 本地认证：SQLite + scrypt 密码哈希 + HttpOnly Session Cookie。
// 不依赖外部服务；数据库只保存在 data/research-workbench.sqlite。
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

const db = new DatabaseSync(config.databaseFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS friendships (
    user_low TEXT NOT NULL,
    user_high TEXT NOT NULL,
    requester_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_low, user_high),
    FOREIGN KEY(user_low) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(user_high) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status, updated_at DESC);
`);
try {
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  for (const column of ["display_name", "avatar_url"]) {
    if (!userCols.includes(column)) db.exec("ALTER TABLE users ADD COLUMN " + column + " TEXT");
  }
} catch (error) { console.error("[auth] 用户档案迁移失败:", error.message); }
// 修复历史版本的截断头像：旧代码会把 data URL 强行截到恰好 200000 字符，文件已不完整，清空后回退默认头像。
try {
  db.prepare("UPDATE users SET avatar_url = '' WHERE length(avatar_url) = 200000").run();
} catch (error) { console.error("[auth] 损坏头像清理失败:", error.message); }
// 迁移：为旧库补上「欢迎语已发送」标记列
try {
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes("welcomed_at")) {
    db.exec("ALTER TABLE users ADD COLUMN welcomed_at INTEGER");
  }
} catch (error) { console.error("[auth] 欢迎语标记迁移失败:", error.message); }

const SESSION_COOKIE = "rwc_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function id(prefix) { return prefix + "_" + crypto.randomBytes(16).toString("hex"); }
function normalizeLogin(value) { return String(value || "").trim().toLowerCase(); }
function validLogin(value) {
  const login = normalizeLogin(value);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login);
  const isPhone = /^1\d{10}$/.test(login) || /^\+?[1-9]\d{6,14}$/.test(login);
  return isEmail || isPhone;
}
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return "scrypt$" + salt + "$" + digest;
}
function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const actual = Buffer.from(parts[2], "hex");
  const expected = crypto.scryptSync(String(password), parts[1], 64);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function publicUser(user) {
  return user ? {
    id: user.id, login: user.login, createdAt: user.created_at,
    displayName: user.display_name || "",
    avatarUrl: user.avatar_url || "",
  } : null;
}
function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  return raw.split(";").reduce((out, item) => {
    const index = item.indexOf("=");
    if (index > 0) out[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
    return out;
  }, {});
}
function setCookie(res, value, maxAge) {
  const expires = new Date(Date.now() + maxAge).toUTCString();
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}; Expires=${expires}`);
}
function clearCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=${new Date(0).toUTCString()}`);
}
function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), userId, now + SESSION_TTL_MS, now);
  setCookie(res, token, SESSION_TTL_MS);
}
function register(login, password, res) {
  const normalized = normalizeLogin(login);
  if (!validLogin(normalized)) throw new Error("请输入有效的邮箱或手机号");
  if (String(password || "").length < 8) throw new Error("密码至少需要 8 位");
  const existing = db.prepare("SELECT id FROM users WHERE login = ?").get(normalized);
  if (existing) throw new Error("该邮箱或手机号已注册");
  const now = Date.now();
  const initialName = normalized.includes("@") ? normalized.split("@")[0] : normalized;
  const user = { id: id("user"), login: normalized, password_hash: hashPassword(password), display_name: initialName, avatar_url: "", created_at: now, updated_at: now };
  db.prepare("INSERT INTO users (id, login, password_hash, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(user.id, user.login, user.password_hash, user.display_name, user.avatar_url, user.created_at, user.updated_at);
  createSession(user.id, res);
  return publicUser(user);
}
function updateProfile(userId, profile) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new Error("账户不存在");
  const displayName = String(profile && profile.displayName || "").trim().slice(0, 24);
  const avatarUrl = String(profile && profile.avatarUrl || "").trim();
  if (profile && Object.prototype.hasOwnProperty.call(profile, "displayName") && !displayName) throw new Error("用户名不能为空");
  // 不能静默截断 base64：截断 JPEG/PNG 会造成只显示半张头像。限制约 2MB 原图的数据 URL。
  if (avatarUrl.length > 2_800_000) throw new Error("头像文件过大，请选择 2MB 以内的图片");
  if (avatarUrl && !/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(avatarUrl)) {
    throw new Error("头像格式无效，请重新上传图片");
  }
  db.prepare("UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?")
    .run(displayName, avatarUrl, Date.now(), userId);
  return publicUser({ ...user, display_name: displayName, avatar_url: avatarUrl });
}
function login(loginValue, password, res) {
  const loginValueNormalized = normalizeLogin(loginValue);
  const user = db.prepare("SELECT * FROM users WHERE login = ?").get(loginValueNormalized);
  if (!user || !verifyPassword(password, user.password_hash)) throw new Error("账号或密码不正确");
  createSession(user.id, res);
  return publicUser(user);
}
function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(hashToken(token));
  if (!session || session.expires_at <= Date.now()) return null;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  return publicUser(user);
}
function changePassword(userId, currentPassword, newPassword) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) throw new Error("原密码不正确");
  if (String(newPassword || "").length < 8) throw new Error("新密码至少需要 8 位");
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(hashPassword(newPassword), Date.now(), userId);
  return publicUser(user);
}
function logout(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  clearCookie(res);
}
function hasWelcomed(userId) {
  const row = db.prepare("SELECT welcomed_at FROM users WHERE id = ?").get(userId);
  return !!(row && row.welcomed_at);
}
function markWelcomed(userId) {
  db.prepare("UPDATE users SET welcomed_at = ? WHERE id = ?").run(Date.now(), userId);
}
function orderedPair(left, right) { return left < right ? [left, right] : [right, left]; }
function userById(userId) {
  return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(String(userId || "").trim()));
}
function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY created_at ASC").all().map(publicUser);
}
function friendshipFor(userId, otherId) {
  const [low, high] = orderedPair(userId, otherId);
  return db.prepare("SELECT * FROM friendships WHERE user_low = ? AND user_high = ?").get(low, high);
}
function listFriends(userId) {
  const rows = db.prepare(`SELECT f.*, u.id, u.login, u.display_name, u.avatar_url, u.created_at
    FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
    WHERE (f.user_low = ? OR f.user_high = ?) AND f.status IN ('pending', 'accepted')
    ORDER BY f.updated_at DESC`).all(userId, userId, userId);
  return rows.map((row) => ({
    user: publicUser(row), status: row.status, direction: row.requester_id === userId ? "outgoing" : "incoming",
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}
function sendFriendRequest(userId, targetId) {
  const target = userById(targetId);
  if (!target) throw new Error("未找到该用户 ID");
  if (target.id === userId) throw new Error("不能添加自己为好友");
  const existing = friendshipFor(userId, target.id);
  const now = Date.now();
  if (existing && existing.status === "accepted") throw new Error("你们已经是好友");
  if (existing && existing.status === "pending") {
    if (existing.requester_id === userId) throw new Error("好友请求已发送，等待对方确认");
    db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE user_low = ? AND user_high = ?")
      .run(now, existing.user_low, existing.user_high);
    return { user: target, status: "accepted", direction: "outgoing", requesterId: existing.requester_id, createdAt: existing.created_at, updatedAt: now };
  }
  const [low, high] = orderedPair(userId, target.id);
  db.prepare("INSERT INTO friendships (user_low, user_high, requester_id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
    .run(low, high, userId, now, now);
  return { user: target, status: "pending", direction: "outgoing", createdAt: now, updatedAt: now };
}
function respondFriendRequest(userId, targetId, accepted) {
  const friendship = friendshipFor(userId, targetId);
  if (!friendship || friendship.status !== "pending" || friendship.requester_id === userId) throw new Error("没有来自该用户的待处理好友请求");
  const status = accepted ? "accepted" : "rejected";
  const now = Date.now();
  db.prepare("UPDATE friendships SET status = ?, updated_at = ? WHERE user_low = ? AND user_high = ?")
    .run(status, now, friendship.user_low, friendship.user_high);
  return { user: userById(targetId), status, direction: "incoming", requesterId: targetId, createdAt: friendship.created_at, updatedAt: now };
}
function areFriends(userId, otherId) {
  const friendship = friendshipFor(userId, otherId);
  return !!(friendship && friendship.status === "accepted");
}

module.exports = { register, login, logout, currentUser, changePassword, updateProfile, hasWelcomed, markWelcomed, validLogin, userById, listUsers, listFriends, sendFriendRequest, respondFriendRequest, areFriends };
