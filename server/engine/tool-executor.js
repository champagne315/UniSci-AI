"use strict";

const { getTool, availableTools } = require("./tool-registry");

function compact(value, max = 900) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function validateArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象");
  const schema = tool.parameters || {};
  for (const key of schema.required || []) if (args[key] == null || args[key] === "") throw new Error("缺少参数：" + key);
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error("不支持的参数：" + key);
  }
}

function evaluate(tool, ctx, options = {}) {
  if (!tool) return { allowed: false, reason: "工具不存在" };
  if (!availableTools(ctx.agent, { loadedSkillIds: ctx.loadedSkillIds }).some((item) => item.id === tool.id)) return { allowed: false, reason: "该智能体尚未获授权使用此工具；请先按需读取对应 Skill 的 SKILL.md" };
  if (tool.risk === "write" && !options.approved) return { allowed: false, approvalRequired: true, reason: "写入工作区会修改资料，需用户批准" };
  return { allowed: true };
}

async function execute(toolId, args, ctx, options = {}) {
  const tool = getTool(toolId);
  const policy = evaluate(tool, ctx, options);
  if (!policy.allowed) return { ok: false, approvalRequired: !!policy.approvalRequired, error: policy.reason, tool: toolId };
  try {
    validateArguments(tool, args);
    const startedAt = Date.now();
    const data = await tool.execute(args, ctx);
    return { ok: true, tool: toolId, data, summary: compact(data), durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, tool: toolId, error: error.message || String(error), summary: error.message || String(error) };
  }
}

function approvalPreview(toolId, args) {
  const tool = getTool(toolId);
  return { toolId, toolLabel: tool ? tool.label : toolId, args: compact(args, 700), prompt: "允许执行「" + (tool ? tool.label : toolId) + "」吗？该操作将写入工作区。" };
}

module.exports = { execute, evaluate, approvalPreview, compact };
