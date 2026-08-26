"use strict";

const fs = require("fs/promises");
const path = require("path");
const config = require("../config");

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ITEMS = 120;
const MAX_MATCHES = 80;
const SKIP_NAMES = new Set(["node_modules", ".git", ".env", ".DS_Store"]);

function safeSegment(value, fallback) {
  return String(value || fallback || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96) || fallback;
}

function roots(ctx) {
  const ownerId = safeSegment(ctx.ownerId || (ctx.conv && ctx.conv.ownerId), "user");
  const conversationId = safeSegment(ctx.conversationId || (ctx.conv && ctx.conv.id), "conversation");
  const agentId = safeSegment(ctx.agent && ctx.agent.id, "agent");
  return {
    shared: path.join(config.workspaceDir, "shared", ownerId, conversationId),
    user: path.join(config.workspaceDir, "users", ownerId),
    agent: path.join(config.workspaceDir, "agents", ownerId, agentId, conversationId),
  };
}

function splitVirtualPath(rawPath) {
  const value = String(rawPath || "shared").replace(/\\/g, "/").replace(/^\/+/, "");
  const [scope = "shared", ...parts] = value.split("/").filter(Boolean);
  if (!Object.prototype.hasOwnProperty.call({ shared: 1, user: 1, agent: 1 }, scope)) {
    throw new Error("路径必须以 shared/、user/ 或 agent/ 开头");
  }
  if (parts.some((part) => part === "." || part === ".." || !part)) throw new Error("路径包含不允许的段");
  return { scope, parts };
}

function resolvePath(ctx, rawPath) {
  const { scope, parts } = splitVirtualPath(rawPath);
  const root = roots(ctx)[scope];
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("路径超出工作区范围");
  return { full, root, scope, virtualPath: [scope, ...parts].join("/") };
}

function isBinary(buffer) { return buffer.includes(0); }
function isAllowedName(name) { return !SKIP_NAMES.has(name) && !name.startsWith("."); }

async function ensureRoot(ctx, scope) {
  const root = roots(ctx)[scope];
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function listFiles(ctx, input = {}) {
  const { full, virtualPath } = resolvePath(ctx, input.path || "shared");
  const depth = Math.max(0, Math.min(5, Number(input.depth) || 2));
  const output = [];
  async function visit(dir, currentDepth) {
    if (output.length >= MAX_LIST_ITEMS) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (output.length >= MAX_LIST_ITEMS || !isAllowedName(entry.name)) continue;
      const item = path.join(dir, entry.name);
      const rel = path.relative(config.workspaceDir, item).split(path.sep).join("/");
      if (entry.isDirectory()) {
        output.push({ path: rel, type: "directory" });
        if (currentDepth < depth) await visit(item, currentDepth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(item);
        output.push({ path: rel, type: "file", size: stat.size, modifiedAt: stat.mtimeMs });
      }
    }
  }
  await visit(full, 0);
  return { root: virtualPath, files: output, truncated: output.length >= MAX_LIST_ITEMS };
}

async function readFile(ctx, input = {}) {
  const { full, virtualPath } = resolvePath(ctx, input.path);
  const stat = await fs.stat(full);
  if (!stat.isFile()) throw new Error("目标不是文件");
  if (stat.size > MAX_FILE_BYTES) throw new Error("文件超过 1MB 读取上限");
  const buffer = await fs.readFile(full);
  if (isBinary(buffer)) throw new Error("不支持读取二进制文件");
  const lines = buffer.toString("utf8").split(/\r?\n/);
  const startLine = Math.max(1, Number(input.startLine) || 1);
  const endLine = Math.min(lines.length, Math.max(startLine, Number(input.endLine) || Math.min(lines.length, startLine + 199)));
  return { path: virtualPath, totalLines: lines.length, startLine, endLine, content: lines.slice(startLine - 1, endLine).join("\n") };
}

async function searchContent(ctx, input = {}) {
  const query = String(input.query || "").trim();
  if (!query) throw new Error("缺少检索关键词");
  if (query.length > 200) throw new Error("检索关键词不能超过 200 个字符");
  const { full, virtualPath } = resolvePath(ctx, input.path || "shared");
  const needle = query.toLowerCase();
  const matches = [];
  async function visit(dir, depth) {
    if (matches.length >= MAX_MATCHES || depth > 5) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES || !isAllowedName(entry.name)) continue;
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) { await visit(item, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(item);
      if (stat.size > MAX_FILE_BYTES) continue;
      const buffer = await fs.readFile(item);
      if (isBinary(buffer)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < MAX_MATCHES; index++) {
        if (lines[index].toLowerCase().includes(needle)) {
          matches.push({ path: path.relative(config.workspaceDir, item).split(path.sep).join("/"), line: index + 1, text: lines[index].slice(0, 500) });
        }
      }
    }
  }
  await visit(full, 0);
  return { root: virtualPath, query, matches, truncated: matches.length >= MAX_MATCHES };
}

async function writeFile(ctx, input = {}) {
  const content = String(input.content == null ? "" : input.content);
  if (!input.path) throw new Error("缺少写入路径");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("写入内容超过 1MB 上限");
  const { full, virtualPath, scope } = resolvePath(ctx, input.path);
  if (scope === "agent") throw new Error("Agent 临时区不接受发布写入，请使用 shared/ 或 user/");
  await fs.mkdir(path.dirname(full), { recursive: true });
  const exists = await fs.access(full).then(() => true).catch(() => false);
  await fs.writeFile(full, content, "utf8");
  return { path: virtualPath, bytes: Buffer.byteLength(content, "utf8"), action: exists ? "updated" : "created" };
}

module.exports = { ensureRoot, listFiles, readFile, searchContent, writeFile, resolvePath, roots };
