"use strict";

// 本地 SQLite 会话存储。会话内容按 ownerId 分区持久化；SSE/锁/审批 resolver 仍是运行时内存状态。
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

function uid(prefix) { return (prefix || "id") + "_" + crypto.randomBytes(8).toString("hex"); }

function newConversation({ title, memberAgentIds = [], memberUserIds = [], kind, config: cfg = {}, ownerId, systemKey = "" }) {
  const now = Date.now();
  const users = Array.from(new Set([ownerId, ...memberUserIds].filter(Boolean)));
  return {
    id: uid("conv"), ownerId: ownerId || "", title: title || "新的科研讨论",
    kind: kind || (memberAgentIds.length + users.length <= 2 ? "direct" : "group"),
    systemKey: String(systemKey || ""),
    memberAgentIds: Array.from(new Set(memberAgentIds)), memberUserIds: users,
    messages: [], createdAt: now, updatedAt: now, status: "idle", runningAgentId: null,
    pendingApproval: null, pendingApprovalQueue: [],
    config: Object.assign({ autoRoute: true, maxRounds: 8, allowParallel: true }, cfg || {}),
  };
}

function appendMessage(conv, msg) {
  const full = Object.assign({ id: uid("msg"), ts: Date.now(), mentions: [], meta: {} }, msg);
  conv.messages.push(full);
  conv.updatedAt = Date.now();
  if (conv._store) {
    conv._store.persist(conv);
    conv._store.broadcastConversationUpdate(conv);
  }
  return full;
}

class Store {
  constructor() {
    this.conversations = new Map();
    this.sseClients = new Map();
    this.userSseClients = new Map();
    this.approvalResolvers = new Map();
    this.runningLocks = new Set();
    this.pendingRuns = new Map();
    this.db = new DatabaseSync(config.databaseFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated ON conversations(owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS conversation_reads (
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        last_read_ts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, user_id)
      );
    `);
    for (const row of this.db.prepare("SELECT payload FROM conversations").all()) {
      try { this._attach(JSON.parse(row.payload)); } catch (_) { /* 忽略损坏旧记录 */ }
    }
  }

  _attach(conv) {
    conv.messages = Array.isArray(conv.messages) ? conv.messages : [];
    conv.memberAgentIds = Array.isArray(conv.memberAgentIds) ? conv.memberAgentIds : [];
    conv.memberUserIds = Array.from(new Set([conv.ownerId, ...(Array.isArray(conv.memberUserIds) ? conv.memberUserIds : [])].filter(Boolean)));
    conv.config = Object.assign({ autoRoute: true, maxRounds: 8, allowParallel: true }, conv.config || {});
    conv.pendingApprovalQueue = Array.isArray(conv.pendingApprovalQueue) ? conv.pendingApprovalQueue : [];
    Object.defineProperty(conv, "_store", { value: this, enumerable: false, configurable: true });
    this.conversations.set(conv.id, conv);
    return conv;
  }
  persist(conv) {
    if (!conv || !conv.id || !conv.ownerId) return;
    const payload = JSON.stringify(conv);
    this.db.prepare(`INSERT INTO conversations (id, owner_id, updated_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, updated_at = excluded.updated_at, payload = excluded.payload`)
      .run(conv.id, conv.ownerId, conv.updatedAt || Date.now(), payload);
  }
  createConversation(opts) {
    const conv = this._attach(newConversation(opts));
    this.persist(conv);
    this.broadcastConversationUpdate(conv);
    return conv;
  }
  getConversation(id, userId) {
    const conv = this.conversations.get(id);
    const members = conv && Array.isArray(conv.memberUserIds) ? conv.memberUserIds : [conv && conv.ownerId];
    return conv && (!userId || members.includes(userId)) ? conv : null;
  }
  listConversations(userId) {
    return Array.from(this.conversations.values()).filter((conv) => !userId || (conv.memberUserIds || [conv.ownerId]).includes(userId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  unreadCount(conv, userId) {
    if (!conv || !userId) return 0;
    const row = this.db.prepare("SELECT last_read_ts FROM conversation_reads WHERE conversation_id = ? AND user_id = ?").get(conv.id, userId);
    const lastReadTs = row ? Number(row.last_read_ts) : 0;
    return conv.messages.reduce((count, message) => count + (
      message.authorType !== "system" && message.author !== userId && Number(message.ts || 0) > lastReadTs ? 1 : 0
    ), 0);
  }
  markConversationRead(id, userId) {
    const conv = this.getConversation(id, userId);
    if (!conv) return null;
    const lastMessageTs = conv.messages.reduce((latest, message) => Math.max(latest, Number(message.ts || 0)), 0);
    const lastReadTs = Math.max(Date.now(), lastMessageTs);
    this.db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_ts) VALUES (?, ?, ?)
      ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_ts = MAX(conversation_reads.last_read_ts, excluded.last_read_ts)`)
      .run(conv.id, userId, lastReadTs);
    return conv;
  }
  syncSystemConversation(id, { title, memberUserIds } = {}) {
    const conv = this.conversations.get(id);
    if (!conv || !conv.systemKey) return null;
    const nextMembers = Array.from(new Set([conv.ownerId, ...(Array.isArray(memberUserIds) ? memberUserIds : [])].filter(Boolean)));
    const membersChanged = nextMembers.length !== conv.memberUserIds.length || nextMembers.some((userId, index) => userId !== conv.memberUserIds[index]);
    const titleChanged = typeof title === "string" && title.trim() && conv.title !== title.trim();
    if (!membersChanged && !titleChanged) return conv;
    if (membersChanged) conv.memberUserIds = nextMembers;
    if (titleChanged) conv.title = title.trim();
    conv.updatedAt = Date.now();
    this.persist(conv);
    this.broadcastConversationUpdate(conv);
    return conv;
  }
  deleteConversation(id, ownerId) {
    const conv = this.getConversation(id, ownerId);
    if (!conv || conv.ownerId !== ownerId || conv.systemKey) return false;
    this.broadcastUsers(conv.memberUserIds, { type: "conversation_deleted", conversationId: id });
    this.conversations.delete(id);
    this.db.prepare("DELETE FROM conversations WHERE id = ? AND owner_id = ?").run(id, conv.ownerId);
    this.db.prepare("DELETE FROM conversation_reads WHERE conversation_id = ?").run(id);
    this.broadcast(id, { type: "conversation_deleted", conversationId: id });
    const clients = this.sseClients.get(id);
    if (clients) clients.forEach((client) => { try { client.res.end(); } catch (_) {} });
    this.sseClients.delete(id); this.pendingRuns.delete(id); this.runningLocks.delete(id); this.approvalResolvers.delete(id);
    return true;
  }
  updateConversationConfig(id, patch, ownerId) {
    const conv = this.getConversation(id, ownerId);
    if (!conv) return null;
    if (!conv.systemKey && patch && typeof patch.title === "string" && patch.title.trim()) conv.title = patch.title.trim();
    if (patch && Array.isArray(patch.kbIds)) conv.config = Object.assign({}, conv.config, { kbIds: patch.kbIds });
    if (patch && patch.config && typeof patch.config === "object") conv.config = Object.assign({}, conv.config, patch.config);
    conv.updatedAt = Date.now();
    this.persist(conv);
    this.broadcastConversationUpdate(conv);
    return conv;
  }
  updateConversationMembers(id, memberUserIds) {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    const previousMembers = Array.from(new Set(conv.memberUserIds || []));
    const nextMembers = Array.from(new Set([conv.ownerId, ...(memberUserIds || [])].filter(Boolean)));
    if (previousMembers.length === nextMembers.length && previousMembers.every((userId, index) => userId === nextMembers[index])) return conv;
    conv.memberUserIds = nextMembers;
    conv.updatedAt = Date.now();
    this.persist(conv);
    this.broadcastUsers([...previousMembers, ...nextMembers], {
      type: "conversation_members_updated", conversationId: conv.id, updatedAt: conv.updatedAt,
    });
    previousMembers.filter((userId) => !nextMembers.includes(userId)).forEach((userId) => this.closeConversationClients(conv.id, userId));
    return conv;
  }
  addConversationMember(id, userId) {
    const conv = this.conversations.get(id);
    if (!conv || conv.memberUserIds.includes(userId)) return null;
    return this.updateConversationMembers(id, [...conv.memberUserIds, userId]);
  }
  removeConversationMember(id, userId) {
    const conv = this.conversations.get(id);
    if (!conv || conv.ownerId === userId || !conv.memberUserIds.includes(userId)) return null;
    return this.updateConversationMembers(id, conv.memberUserIds.filter((memberId) => memberId !== userId));
  }
  addClient(convId, userId, res) {
    if (!this.sseClients.has(convId)) this.sseClients.set(convId, new Set());
    const client = { userId, res };
    this.sseClients.get(convId).add(client);
    res.on("close", () => { const set = this.sseClients.get(convId); if (set) set.delete(client); });
  }
  closeConversationClients(convId, userId) {
    const set = this.sseClients.get(convId);
    if (!set) return;
    Array.from(set).filter((client) => client.userId === userId).forEach((client) => {
      set.delete(client);
      try { client.res.end(); } catch (_) {}
    });
    if (!set.size) this.sseClients.delete(convId);
  }
  addUserClient(userId, res) {
    if (!this.userSseClients.has(userId)) this.userSseClients.set(userId, new Set());
    this.userSseClients.get(userId).add(res);
    res.on("close", () => {
      const set = this.userSseClients.get(userId);
      if (!set) return;
      set.delete(res);
      if (!set.size) this.userSseClients.delete(userId);
    });
  }
  broadcast(convId, event) {
    const set = this.sseClients.get(convId); if (!set) return;
    const conv = this.conversations.get(convId);
    const members = new Set(conv ? conv.memberUserIds : []);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    set.forEach((client) => {
      if (!members.has(client.userId)) return;
      try { client.res.write(payload); } catch (_) {}
    });
  }
  broadcastUsers(userIds, event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    Array.from(new Set(userIds || [])).forEach((userId) => {
      const set = this.userSseClients.get(userId);
      if (set) set.forEach((res) => { try { res.write(payload); } catch (_) {} });
    });
  }
  broadcastConversationUpdate(conv) {
    if (!conv) return;
    this.broadcastUsers(conv.memberUserIds, {
      type: "conversation_updated", conversationId: conv.id, updatedAt: conv.updatedAt,
    });
  }
  tryAcquire(convId) { if (this.runningLocks.has(convId)) return false; this.runningLocks.add(convId); return true; }
  release(convId) { this.runningLocks.delete(convId); }
  enqueueRun(convId, triggerText) { if (!this.pendingRuns.has(convId)) this.pendingRuns.set(convId, []); this.pendingRuns.get(convId).push(triggerText); return this.pendingRuns.get(convId).length; }
  shiftRun(convId) { const queue = this.pendingRuns.get(convId); if (!queue || !queue.length) return null; const next = queue.shift(); if (!queue.length) this.pendingRuns.delete(convId); return next; }
  pendingRunCount(convId) { const queue = this.pendingRuns.get(convId); return queue ? queue.length : 0; }
  awaitApproval(convId) { return new Promise((resolve) => { this.approvalResolvers.set(convId, resolve); }); }
  resolveApproval(convId, decision) { const resolve = this.approvalResolvers.get(convId); if (resolve) { this.approvalResolvers.delete(convId); resolve(decision); } }
}

module.exports = { Store, uid, appendMessage };
