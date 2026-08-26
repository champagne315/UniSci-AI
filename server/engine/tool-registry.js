"use strict";

const kbStore = require("../kb/storeInstance");
const workspace = require("./workspace");
const web = require("./web");
const { createSkillReader } = require("./skill-reader");
const readSkill = createSkillReader();

// 工作区不是默认能力：只有用户显式授权，或在读取相关 SKILL.md 后由 Skill 解锁。
const BASELINE_TOOL_IDS = ["knowledge_search", "web_search", "web_fetch"];
const WRITE_TOOL_IDS = ["workspace_write_file"];

const CATALOG = {
  knowledge_search: {
    id: "knowledge_search", label: "知识库检索", category: "知识", risk: "read", default: true,
    description: "检索当前智能体或会话已授权的知识库，返回带来源的片段。",
    parameters: { type: "object", properties: { query: { type: "string", description: "检索问题或关键词" }, limit: { type: "integer", minimum: 1, maximum: 8, description: "返回条数" } }, required: ["query"], additionalProperties: false },
    execute: async (input, ctx) => {
      const kbIds = ctx.agent.kbIds && ctx.agent.kbIds.length ? ctx.agent.kbIds : ((ctx.conv.config && ctx.conv.config.kbIds) || []);
      const hits = await kbStore.retrieve(input.query, kbIds, Math.max(1, Math.min(8, Number(input.limit) || 4)), ctx.ownerId);
      return { query: input.query, hits: hits.map((hit) => ({ id: hit.id, source: hit.source, kbName: hit.kbName, score: Number(hit.score || 0).toFixed(3), text: String(hit.text || "").slice(0, 1200) })) };
    },
  },
  workspace_list_files: { id: "workspace_list_files", label: "列举工作区", category: "工作区", risk: "read", default: false, description: "列举当前用户、会话共享或本智能体隔离工作区内的文件。", parameters: { type: "object", properties: { path: { type: "string", description: "以 shared/、user/ 或 agent/ 开头的虚拟路径" }, depth: { type: "integer", minimum: 0, maximum: 5 } }, additionalProperties: false }, execute: (input, ctx) => workspace.listFiles(ctx, input) },
  workspace_read_file: { id: "workspace_read_file", label: "读取文件", category: "工作区", risk: "read", default: false, description: "读取隔离工作区中的 UTF-8 文本文件。", parameters: { type: "object", properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false }, execute: (input, ctx) => workspace.readFile(ctx, input) },
  workspace_search_content: { id: "workspace_search_content", label: "检索工作区", category: "工作区", risk: "read", default: false, description: "在隔离工作区内全文检索文本文件。", parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"], additionalProperties: false }, execute: (input, ctx) => workspace.searchContent(ctx, input) },
  web_search: { id: "web_search", label: "网络搜索", category: "网络", risk: "network", default: true, description: "搜索公开互联网，返回可继续阅读的网页候选项。", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 8 } }, required: ["query"], additionalProperties: false }, execute: web.searchWeb },
  web_fetch: { id: "web_fetch", label: "读取网页", category: "网络", risk: "network", default: true, description: "读取公开网页正文。仅允许公开 HTTP/HTTPS 地址，内网地址会被拒绝。", parameters: { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"], additionalProperties: false }, execute: web.fetchPage },
  workspace_write_file: { id: "workspace_write_file", label: "写入工作区", category: "工作区", risk: "write", default: false, description: "将文本写入用户或会话共享工作区。每次执行都需要用户批准。", parameters: { type: "object", properties: { path: { type: "string", description: "必须以 shared/ 或 user/ 开头" }, content: { type: "string", description: "完整 UTF-8 文本内容" } }, required: ["path", "content"], additionalProperties: false }, execute: (input, ctx) => workspace.writeFile(ctx, input) },
  skill_read: { id: "skill_read", label: "读取 Skill 文件", category: "Skill", risk: "read", default: false, configurable: false, description: "按需读取当前 Agent 已安装 Skill 的 SKILL.md 正文或其 references/、scripts/ 中的文本文件。读取 SKILL.md 后才会解锁该 Skill 声明的专用工具。", parameters: { type: "object", properties: { skillId: { type: "string", description: "已安装 Skill 的 ID" }, path: { type: "string", description: "可选，相对 Skill 目录的文件路径；省略时读取 SKILL.md 正文" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["skillId"], additionalProperties: false }, execute: readSkill },
};

function normalizeIds(agent, options = {}) {
  const configured = Array.isArray(agent.toolIds) ? agent.toolIds : [];
  const legacy = Array.isArray(agent.tools) ? agent.tools : [];
  const loadedSkillIds = new Set(options.loadedSkillIds || []);
  const installedSkills = Array.isArray(agent.installedSkills) ? agent.installedSkills : [];
  const skillTools = installedSkills.filter((skill) => loadedSkillIds.has(skill.id)).flatMap((skill) => Array.isArray(skill.toolIds) ? skill.toolIds : []);
  const skillReader = installedSkills.length ? ["skill_read"] : [];
  return new Set([...BASELINE_TOOL_IDS, ...configured, ...skillReader, ...skillTools, ...legacy.filter((id) => CATALOG[id])]);
}

function availableTools(agent, options) {
  return [...normalizeIds(agent, options)].filter((id) => CATALOG[id]).map((id) => CATALOG[id]);
}
function modelTools(agent, options) { return availableTools(agent, options).map((tool) => ({ type: "function", function: { name: tool.id, description: tool.description, parameters: tool.parameters } })); }
function publicCatalog() { return Object.values(CATALOG).filter((tool) => tool.configurable !== false).map(({ id, label, category, risk, default: isDefault, description }) => ({ id, label, category, risk, default: isDefault, description })); }
function getTool(id) { return CATALOG[id] || null; }

module.exports = { BASELINE_TOOL_IDS, WRITE_TOOL_IDS, availableTools, modelTools, publicCatalog, getTool };
