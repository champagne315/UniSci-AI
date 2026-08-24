"use strict";

// 主服务：HTTP 路由 + SSE 流式 + 静态前端。
// 端点分组：会话 / 消息 / Agent 模板 / 知识库 / 审批 / 健康。

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const config = require("./config");
const { Store, appendMessage, uid } = require("./store");
const { Registry } = require("./agents/registry");
const { Orchestrator } = require("./engine/orchestrator");
const kbStore = require("./kb/storeInstance");
const { ingestFile, ingestText } = require("./kb/ingest");
const { readJson, parseMultipart, startSSE, sendJSON } = require("./http");
const auth = require("./auth");

const store = new Store();
const registry = new Registry();
registry.load();
const orchestrator = new Orchestrator(store, registry);
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.avatarUploadDir, { recursive: true });

// 科研小助理的新手欢迎语：简洁概括平台与自身定位
const ASSISTANT_WELCOME = "你好，我是科研小助理，你的入门向导。\n\n这里是 UniSci AI：你可以和不同领域的科研专家单聊，或建群协作；也能把文献、数据上传成知识库，让回答有据可查。\n\n无论你刚有个想法，还是卡在某个环节，先跟我聊聊就好——我会帮你理清问题，再把话题转交给最合适的专家。";

// 每个本地账户首个会话固定为科研小助理；后端兜底，避免前端刷新或本地状态影响初始化。
// 首次进入时由科研小助理发送一条固定欢迎语作为新手引导，且每个用户仅一次。
function ensureAssistantConversation(userId) {
  const assistant = registry.get("research_assistant", userId);
  if (!assistant) return null;
  const welcomeMsg = {
    authorType: "agent", author: assistant.id, authorName: assistant.name,
    avatar: assistant.avatar, color: assistant.color, content: ASSISTANT_WELCOME, mentions: [],
  };
  const found = store.listConversations(userId).find((conv) =>
    conv.kind === "direct" && conv.memberAgentIds.length === 1 && conv.memberAgentIds[0] === assistant.id);
  if (found) {
    if (found.title !== "科研小助理") store.updateConversationConfig(found.id, { title: "科研小助理" }, userId);
    if (!auth.hasWelcomed(userId)) { appendMessage(found, welcomeMsg); auth.markWelcomed(userId); }
    return found;
  }
  const conv = store.createConversation({
    ownerId: userId, title: "科研小助理", kind: "direct", memberAgentIds: [assistant.id],
    config: { autoRoute: true, maxRounds: 1, kbIds: [] },
  });
  appendMessage(conv, welcomeMsg);
  auth.markWelcomed(userId);
  return conv;
}

// 好友私聊：两位用户之间唯一的人类会话。好友关系一建立就自动创建，
// 并由主动发起申请的一方发送一句问候，无需用户手动发起私聊。
function ensureFriendConversation(actorUser, peerUser, requesterId) {
  if (!peerUser || !peerUser.id || !actorUser || !actorUser.id) return null;
  const found = store.listConversations(actorUser.id).find((conv) =>
    conv.kind === "direct" &&
    (conv.memberAgentIds || []).length === 0 &&
    (conv.memberUserIds || []).includes(actorUser.id) &&
    (conv.memberUserIds || []).includes(peerUser.id));
  if (found) return found;
  const conv = store.createConversation({
    ownerId: requesterId,
    title: peerUser.displayName || peerUser.login || peerUser.id,
    memberAgentIds: [],
    memberUserIds: [actorUser.id, peerUser.id],
    kind: "direct",
    config: { autoRoute: false, maxRounds: 1, kbIds: [] },
  });
  const greeter = requesterId === actorUser.id ? actorUser : peerUser;
  const greeting = "我是 " + (greeter.displayName || greeter.login || greeter.id) + "，我们现在可以开始聊天。";
  const msg = appendMessage(conv, {
    authorType: "human", author: greeter.id,
    authorName: greeter.displayName || greeter.login || greeter.id,
    authorAvatar: greeter.avatarUrl || "", content: greeting, mentions: [],
  });
  store.broadcast(conv.id, { type: "message", conversationId: conv.id, message: msg });
  return conv;
}

// ---------- 工具 ----------
function serveStatic(req, res) {
  const requestPath = decodeURIComponent(req.url.split("?")[0]);
  const isAvatar = requestPath.startsWith("/uploads/avatars/");
  let relativePath = isAvatar ? requestPath.slice("/uploads/avatars/".length) : requestPath;
  if (!isAvatar && relativePath === "/") relativePath = "/index.html";
  relativePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, "");
  const root = isAvatar ? config.avatarUploadDir : config.webDir;
  const full = path.join(root, relativePath);
  if (!full.startsWith(root)) {
    res.writeHead(403); res.end("forbidden"); return true;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const ext = path.extname(full).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(full).pipe(res);
  return true;
}

// ---------- 路由 ----------
async function handleApi(req, res, parsed) {
  const { pathname } = parsed;
  const method = req.method;

  // ---------- 本地认证（不需要登录） ----------
  if (pathname === "/api/auth/register" && method === "POST") {
    try {
      const body = await readJson(req);
      return sendJSON(res, 201, { user: auth.register(body.login, body.password, res) });
    } catch (error) { return sendJSON(res, 400, { error: error.message || "注册失败" }); }
  }
  if (pathname === "/api/auth/login" && method === "POST") {
    try {
      const body = await readJson(req);
      return sendJSON(res, 200, { user: auth.login(body.login, body.password, res) });
    } catch (error) { return sendJSON(res, 401, { error: error.message || "登录失败" }); }
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    auth.logout(req, res);
    return sendJSON(res, 200, { ok: true });
  }
  if (pathname === "/api/auth/me" && method === "GET") {
    return sendJSON(res, 200, { user: auth.currentUser(req) });
  }
  if (pathname === "/api/auth/password" && method === "POST") {
    const user = auth.currentUser(req);
    if (!user) return sendJSON(res, 401, { error: "请先登录" });
    try {
      const body = await readJson(req);
      auth.changePassword(user.id, body.currentPassword, body.newPassword);
      return sendJSON(res, 200, { ok: true });
    } catch (error) { return sendJSON(res, 400, { error: error.message || "密码更新失败" }); }
  }
  if (pathname === "/api/auth/profile" && method === "POST") {
    const user = auth.currentUser(req);
    if (!user) return sendJSON(res, 401, { error: "请先登录" });
    try {
      const body = await readJson(req);
      const updated = auth.updateProfile(user.id, body);
      const recipients = new Set();
      for (const conversation of store.listConversations(updated.id)) {
        (conversation.memberUserIds || []).forEach((memberId) => recipients.add(memberId));
      }
      store.broadcastUsers([...recipients], { type: "profile_updated", user: updated });
      return sendJSON(res, 200, { user: updated });
    } catch (error) { return sendJSON(res, 400, { error: error.message || "资料更新失败" }); }
  }

  // 健康
  if (pathname === "/api/health") {
    return sendJSON(res, 200, {
      ok: true,
      mode: config.isMock ? "demo(本地 mock)" : "real(OpenAI)",
      model: config.model,
      agents: registry.all().length,
      rag: kbStore.status(),
    });
  }

  const user = auth.currentUser(req);
  if (!user) return sendJSON(res, 401, { error: "请先登录" });

  // ---------- 好友 ----------
  if (pathname === "/api/friends" && method === "GET") {
    return sendJSON(res, 200, { friends: auth.listFriends(user.id) });
  }
  if (pathname === "/api/friends/request" && method === "POST") {
    try {
      const body = await readJson(req);
      const friendship = auth.sendFriendRequest(user.id, body.userId);
      if (friendship.status === "accepted") ensureFriendConversation(user, friendship.user, friendship.requesterId);
      return sendJSON(res, 201, { friendship });
    } catch (error) { return sendJSON(res, 400, { error: error.message || "好友请求发送失败" }); }
  }
  if (pathname === "/api/friends/respond" && method === "POST") {
    try {
      const body = await readJson(req);
      const friendship = auth.respondFriendRequest(user.id, body.userId, !!body.accepted);
      if (friendship.status === "accepted") ensureFriendConversation(user, friendship.user, friendship.requesterId);
      return sendJSON(res, 200, { friendship });
    } catch (error) { return sendJSON(res, 400, { error: error.message || "好友请求处理失败" }); }
  }

  // ---------- Agent 模板 ----------
  if (pathname === "/api/agents" && method === "GET") {
    return sendJSON(res, 200, { agents: registry.all(user.id) });
  }
  if (pathname === "/api/agents" && method === "POST") {
    const body = await readJson(req);
    body.kbIds = Array.isArray(body.kbIds)
      ? Array.from(new Set(body.kbIds.filter((id) => typeof id === "string" && kbStore.get(id, user.id))))
      : undefined;
    const tpl = registry.saveCustom(body, user.id);
    return sendJSON(res, 201, { agent: tpl });
  }
  if (pathname === "/api/agents/avatar" && method === "POST") {
    const contentType = req.headers["content-type"] || "";
    const boundary = contentType.match(/boundary=(.+)$/);
    if (!boundary) return sendJSON(res, 400, { error: "请上传图片文件" });
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) return reject(new Error("头像文件不能超过 2MB"));
        chunks.push(chunk);
      });
      req.on("end", resolve);
      req.on("error", reject);
    });
    const file = parseMultipart(Buffer.concat(chunks), boundary[1]).files[0];
    const extensions = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
    if (!file || !extensions[file.contentType]) return sendJSON(res, 400, { error: "仅支持 PNG、JPG、WebP 或 GIF 格式的头像" });
    if (!file.data.length) return sendJSON(res, 400, { error: "头像文件为空" });
    const filename = uid("avatar") + extensions[file.contentType];
    fs.writeFileSync(path.join(config.avatarUploadDir, filename), file.data);
    return sendJSON(res, 201, { url: "/uploads/avatars/" + filename });
  }
  if (pathname.startsWith("/api/agents/") && method === "DELETE") {
    const id = pathname.split("/").pop();
    const ok = registry.deleteCustom(id, user.id);
    return sendJSON(res, ok ? 200 : 400, { ok });
  }

  // ---------- 知识库 ----------
  if (pathname === "/api/kbs" && method === "GET") {
    return sendJSON(res, 200, { kbs: kbStore.all(user.id).map(summarizeKb) });
  }
  if (pathname === "/api/kbs" && method === "POST") {
    const body = await readJson(req);
    const kb = kbStore.create({ name: body.name, description: body.description, ownerId: user.id });
    return sendJSON(res, 201, { kb: summarizeKb(kb) });
  }
  if (pathname.startsWith("/api/kbs/") && method === "DELETE") {
    const id = pathname.split("/").pop();
    return sendJSON(res, kbStore.delete(id, user.id) ? 200 : 404, { ok: true });
  }
  // 文档详情：只返回可查看内容和索引元数据，不返回稠密/词法向量。
  const docMatch = pathname.match(/^\/api\/kbs\/([^/]+)\/docs\/([^/]+)$/);
  if (docMatch && method === "GET") {
    const kb = kbStore.get(docMatch[1], user.id);
    if (!kb) return sendJSON(res, 404, { error: "知识库不存在" });
    const doc = kb.docs.find((item) => item.id === docMatch[2]);
    if (!doc) return sendJSON(res, 404, { error: "文档不存在" });
    return sendJSON(res, 200, { document: summarizeDocument(doc) });
  }

  // 上传文件入库
  if (/^\/api\/kbs\/[^/]+\/upload$/.test(pathname) && method === "POST") {
    const id = pathname.split("/")[3];
    const kb = kbStore.get(id, user.id);
    if (!kb) return sendJSON(res, 404, { error: "kb 不存在" });
    const ct = req.headers["content-type"] || "";
    const saved = [];

    // 粘贴文本：application/json {text, name}
    if (ct.includes("application/json")) {
      const body = await readJson(req);
      if (!body.text || !String(body.text).trim()) {
        return sendJSON(res, 400, { error: "请输入需要入库的文本内容" });
      }
      const doc = await ingestText(kb, body.name || "粘贴文本", body.text);
      saved.push({ id: doc.id, name: doc.name, chunks: doc.chunks.length });
      return sendJSON(res, 200, { kb: summarizeKb(kb), saved, successCount: 1, failedCount: 0 });
    }

    const bmatch = ct.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    if (!bmatch) return sendJSON(res, 400, { error: "需要 multipart 文件上传" });
    const buf = await new Promise((resolve, reject) => {
      const ch = []; req.on("data", (c) => ch.push(c));
      req.on("end", () => resolve(Buffer.concat(ch)));
      req.on("error", reject);
    });
    const { files, fields } = parseMultipart(buf, bmatch[1] || bmatch[2]);
    if (!files.length && !String(fields.text || "").trim()) {
      return sendJSON(res, 400, { error: "未检测到可上传的文件或文本内容" });
    }

    for (const file of files) {
      const filename = path.basename(file.filename || "未命名文件");
      const tmp = path.join(config.uploadDir, uid("up") + "_" + filename);
      try {
        fs.writeFileSync(tmp, file.data);
        const doc = await ingestFile(kb, tmp, filename);
        saved.push({ id: doc.id, name: doc.name, chunks: doc.chunks.length });
      } catch (error) {
        console.warn("[kb] 文档入库失败：", filename, error.message);
        saved.push({ name: filename, error: error.message });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    if (String(fields.text || "").trim()) {
      try {
        const doc = await ingestText(kb, fields.name || "粘贴文本", fields.text);
        saved.push({ id: doc.id, name: doc.name, chunks: doc.chunks.length });
      } catch (error) {
        saved.push({ name: fields.name || "粘贴文本", error: error.message });
      }
    }

    const failed = saved.filter((item) => item.error);
    const successful = saved.length - failed.length;
    const response = {
      kb: summarizeKb(kb),
      saved,
      successCount: successful,
      failedCount: failed.length,
    };
    if (!successful) {
      return sendJSON(res, 422, { ...response, error: failed[0] ? failed[0].error : "文档解析失败" });
    }
    return sendJSON(res, 200, response);
  }
  // 检索预览
  if (/^\/api\/kbs\/[^/]+\/search$/.test(pathname) && method === "POST") {
    const id = pathname.split("/")[3];
    const { query } = await readJson(req);
    const hits = await kbStore.retrieve(query || "", [id], 5, user.id);
    return sendJSON(res, 200, { hits, rag: kbStore.status() });
  }

  // ---------- 用户级 SSE：无论当前打开哪个会话，都接收列表更新 ----------
  if (pathname === "/api/events" && method === "GET") {
    startSSE(res);
    store.addUserClient(user.id, res);
    return true;
  }

  // ---------- 会话 ----------
  if (pathname === "/api/conversations" && method === "GET") {
    ensureAssistantConversation(user.id);
    return sendJSON(res, 200, { conversations: store.listConversations(user.id).map((conv) => summarizeConv(conv, user.id)) });
  }
  if (pathname === "/api/conversations" && method === "POST") {
    const body = await readJson(req);
    const memberAgentIds = Array.isArray(body.memberAgentIds)
      ? Array.from(new Set(body.memberAgentIds.filter((id) => typeof id === "string" && registry.get(id, user.id))))
      : [];
    const requestedUserIds = Array.isArray(body.memberUserIds)
      ? Array.from(new Set(body.memberUserIds.filter((id) => typeof id === "string" && id !== user.id)))
      : [];
    const memberUserIds = [user.id];
    for (const userId of requestedUserIds) {
      if (!auth.userById(userId)) return sendJSON(res, 400, { error: "存在无效的用户 ID" });
      if (!auth.areFriends(user.id, userId)) return sendJSON(res, 403, { error: "只能邀请已添加的好友" });
      memberUserIds.push(userId);
    }
    const kind = body.kind === "group" ? "group" : "direct";
    if (kind === "direct" && memberUserIds.length > 1 && memberAgentIds.length) {
      return sendJSON(res, 400, { error: "好友私聊不能同时添加智能体，请创建群聊" });
    }
    if (kind === "direct" && memberUserIds.length > 2) {
      return sendJSON(res, 400, { error: "好友私聊仅支持两位用户，请创建群聊" });
    }
    if (kind === "group" && !memberAgentIds.includes("coordinator")) memberAgentIds.unshift("coordinator");
    if (kind === "direct" && memberUserIds.length < 2 && !memberAgentIds.length) {
      return sendJSON(res, 400, { error: "单聊至少需要一位好友或一个智能体" });
    }
    const conv = store.createConversation({
      ownerId: user.id,
      title: body.title,
      memberAgentIds,
      memberUserIds,
      kind,
      config: {
        autoRoute: kind === "direct",
        maxRounds: kind === "direct" ? 1 : (body.maxRounds || config.maxRounds),
        kbIds: body.kbIds || [],
      },
    });
    return sendJSON(res, 201, { conversation: summarizeConv(conv, user.id) });
  }
  if (pathname.startsWith("/api/conversations/") && method === "DELETE") {
    const id = pathname.split("/").pop();
    const ok = store.deleteConversation(id, user.id);
    return sendJSON(res, ok ? 200 : 404, { ok });
  }
  if (pathname.startsWith("/api/conversations/") && method === "PATCH") {
    const id = pathname.split("/").pop();
    const conv = store.getConversation(id, user.id);
    if (!conv) return sendJSON(res, 404, { error: "会话不存在" });
    const body = await readJson(req);
    const patch = {};
    if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
    if (Array.isArray(body.kbIds)) {
      patch.kbIds = Array.from(new Set(body.kbIds.filter((kbId) => typeof kbId === "string" && kbStore.get(kbId, user.id))));
    }
    if (body.config && typeof body.config === "object") patch.config = body.config;
    store.updateConversationConfig(id, patch, user.id);
    return sendJSON(res, 200, { conversation: summarizeConv(conv, user.id) });
  }
  // 会话详情 / 已读确认
  const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convMatch && method === "GET") {
    const conv = store.markConversationRead(convMatch[1], user.id);
    if (!conv) return sendJSON(res, 404, { error: "会话不存在" });
    return sendJSON(res, 200, { conversation: conv });
  }
  const readMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/read$/);
  if (readMatch && method === "POST") {
    const conv = store.markConversationRead(readMatch[1], user.id);
    if (!conv) return sendJSON(res, 404, { error: "会话不存在" });
    return sendJSON(res, 200, { conversation: summarizeConv(conv, user.id) });
  }

  // ---------- 消息 ----------
  const msgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (msgMatch && method === "POST") {
    const conv = store.getConversation(msgMatch[1], user.id);
    if (!conv) return sendJSON(res, 404, { error: "会话不存在" });
    const body = await readJson(req);
    const text = (body.text || "").trim();
    if (!text) return sendJSON(res, 400, { error: "内容为空" });
    // 单聊里 @ 标记无意义：保留但不强制走解析
    const msg = appendMessage(conv, {
      authorType: "human",
      author: user.id,
      authorName: user.displayName || user.login,
      authorAvatar: user.avatarUrl || "",
      content: text,
      mentions: (text.match(/[@＠]([a-zA-Z0-9_-]+)/g) || []).map((s) => s.replace(/^[@＠]/, "")),
    });
    store.broadcast(conv.id, { type: "message", conversationId: conv.id, message: msg });
    // 纯好友私聊没有智能体参与，仅广播用户消息；含 Agent 的会话再触发编排。
    if (conv.memberAgentIds && conv.memberAgentIds.length) {
      orchestrator.runConversation(conv, text).catch((e) => console.error("[run] error", e));
    }
    return sendJSON(res, 202, { ok: true, message: msg });
  }

  // ---------- 审批 ----------
 const apprMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/approval$/);
 if (apprMatch && method === "POST") {
   const conv = store.getConversation(apprMatch[1], user.id);
   if (!conv) return sendJSON(res, 404, { error: "会话不存在" });
   const body = await readJson(req);
   if (conv.status !== "awaiting_approval" || !conv.pendingApproval) {
     return sendJSON(res, 409, { error: "当前会话没有待处理的审批" });
   }
   if (conv._approvalResuming) {
     return sendJSON(res, 409, { error: "该审批正在处理中" });
   }
   if (!body.approvalId) {
     return sendJSON(res, 400, { error: "缺少 approvalId" });
   }
   if (body.approvalId !== conv.pendingApproval.id) {
     return sendJSON(res, 409, { error: "审批已过期或不是当前待处理项" });
   }
   const approvalId = conv.pendingApproval.id;
   orchestrator.resumeApproval(conv, {
     approvalId,
     approved: !!body.approved,
     note: body.note || "",
   }).catch((e) => console.error("[approval] error", e));
   return sendJSON(res, 202, { ok: true, approvalId });
 }

  // ---------- SSE 流 ----------
  const sseMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/stream$/);
  if (sseMatch && method === "GET") {
    const conv = store.getConversation(sseMatch[1], user.id);
    if (!conv) return sendJSON(res, 404, { error: "会话不存在" });
    startSSE(res);
    store.addClient(conv.id, res);
    // 立即回放当前状态，便于重连
    res.write(`data: ${JSON.stringify({ type: "snapshot", conversationId: conv.id, status: conv.status, pendingApproval: conv.pendingApproval })}\n\n`);
    return true;
  }

  return sendJSON(res, 404, { error: "未找到: " + method + " " + pathname });
}

function restoreFullText(chunks) {
  const texts = (chunks || []).map((item) => String(item.text || ""));
  if (!texts.length) return "";
  let result = texts[0];
  for (const next of texts.slice(1)) {
    let overlap = 0;
    const limit = Math.min(240, result.length, next.length);
    for (let size = limit; size > 0; size--) {
      if (result.endsWith(next.slice(0, size))) { overlap = size; break; }
    }
    result += (overlap ? "" : "\n\n") + next.slice(overlap);
  }
  return result;
}

function summarizeDocument(doc) {
  const fullText = typeof doc.fullText === "string" ? doc.fullText : restoreFullText(doc.chunks);
  return {
    id: doc.id,
    name: doc.name,
    source: doc.source,
    fullText,
    charCount: fullText.length,
    chunkCount: doc.chunks.length,
    semanticStatus: doc.semanticStatus,
    semanticModel: doc.semanticModel,
    semanticError: doc.semanticError,
    createdAt: doc.createdAt,
    chunks: doc.chunks.map((item, index) => ({
      id: item.id,
      index,
      text: item.text,
      charCount: item.text.length,
      semanticReady: Array.isArray(item.semanticVec),
      semanticModel: item.semanticModel || null,
    })),
  };
}

function summarizeKb(kb) {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    docCount: kb.docs.length,
    chunkCount: kb.docs.reduce((s, d) => s + d.chunks.length, 0),
    semanticChunkCount: kb.docs.reduce((sum, doc) => sum + doc.chunks.filter((item) => Array.isArray(item.semanticVec)).length, 0),
    embeddingStatus: kb.docs.some((doc) => doc.semanticStatus === "fallback")
      ? "fallback"
      : (kb.docs.some((doc) => doc.semanticStatus === "ready") ? "ready" : (kbStore.status().enabled ? "empty" : "disabled")),
    embeddingModel: kbStore.status().model,
    docs: kb.docs.map((d) => ({
      id: d.id,
      name: d.name,
      chunks: d.chunks.length,
      semanticChunks: d.chunks.filter((item) => Array.isArray(item.semanticVec)).length,
      semanticStatus: d.semanticStatus,
      semanticError: d.semanticError,
      createdAt: d.createdAt,
    })),
    createdAt: kb.createdAt,
  };
}

function summarizeConv(conv, userId) {
  // 最后一条非系统消息，供前端会话列表做预览
  let last = null;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.authorType === "system") continue;
    last = {
      authorType: m.authorType,
      authorName: m.authorName,
      content: String(m.content || "").replace(/\s+/g, " ").slice(0, 60),
      ts: m.ts,
    };
    break;
  }
  return {
    id: conv.id,
    title: conv.title,
    kind: conv.kind,
    memberAgentIds: conv.memberAgentIds,
    memberUserIds: conv.memberUserIds || [conv.ownerId],
    messageCount: conv.messages.length,
    unreadCount: store.unreadCount(conv, userId),
    lastMessage: last,
    status: conv.status,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    config: conv.config,
  };
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  try {
    if (parsed.pathname.startsWith("/api/")) {
      await handleApi(req, res, parsed);
    } else {
      const ok = serveStatic(req, res);
      if (!ok) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
      }
    }
  } catch (e) {
    console.error("[server] error:", e);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: e.message || String(e) });
    }
  }
});

function tryListen(srv, port, host) {
  return new Promise((resolve, reject) => {
    srv.once("error", (e) => {
      if (e.code === "EADDRINUSE" && port < 3020) {
        // 端口被占（可能上个实例没退干净），自动找下一个
        tryListen(srv, port + 1, host).then(resolve, reject);
      } else reject(e);
    });
    srv.listen(port, host, () => resolve(port));
  });
}

tryListen(server, config.port, config.host).then((actualPort) => {
  config.port = actualPort;
  console.log("============================================");
  console.log("  UniSci AI");
  console.log("============================================");
  console.log(`  模式: ${config.isMock ? "演示模式(本地 mock LLM，免 API Key)" : "实跑模式(OpenAI " + config.model + ")"}`);
  console.log(`  Agent 模板: ${registry.all().length} 个`);
  console.log(`  知识库: ${kbStore.all().length} 个`);
  console.log(`  地址: http://localhost:${actualPort}` + (actualPort !== Number(process.env.PORT || 3000) ? `  (默认端口被占，已自动切到 ${actualPort})` : ""));
  console.log("  按 Ctrl+C 停止");
  console.log("============================================");
}).catch((e) => {
  console.error("启动失败：", e.message);
  process.exit(1);
});

module.exports = { server, store, registry, orchestrator };
