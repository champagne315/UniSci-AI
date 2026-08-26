"use strict";

const config = require("../config");
const { completeWithTools } = require("./llm");
const { modelTools, getTool } = require("./tool-registry");
const { execute, evaluate, approvalPreview, compact } = require("./tool-executor");

function asText(content) {
  if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : (item && item.text) || "").join("");
  return String(content || "");
}
function parseArgs(call) {
  if (call && call.function && typeof call.function.arguments === "string") return JSON.parse(call.function.arguments || "{}");
  if (call && typeof call.args === "object") return call.args || {};
  return {};
}
function normalizeCall(call, index) {
  const functionData = call.function || {};
  return { id: call.id || "call_" + Date.now() + "_" + index, name: call.name || functionData.name, args: parseArgs(call) };
}
function toolMessage(call, result) {
  return { role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(result) };
}
function serializeCall(call) { return { id: call.id, name: call.name, args: call.args }; }
function loadedSkillsFromHistory(history) {
  const loaded = new Set();
  for (const message of history || []) {
    if (message.role !== "tool" || message.name !== "skill_read") continue;
    try {
      const result = JSON.parse(message.content || "{}");
      if (result.ok && result.data && result.data.path === "SKILL.md" && result.data.skillId) loaded.add(result.data.skillId);
    } catch (_) { /* 忽略历史中格式不完整的工具消息 */ }
  }
  return loaded;
}

class AgentRuntime {
  async run({ messages, agent, conv, members, kbHits, onEvent, resume }) {
    const history = Array.isArray(messages) ? messages.map((message) => Object.assign({}, message)) : [];
    const loadedSkillIds = loadedSkillsFromHistory(history);
    const ctx = { agent, conv, members, kbHits, ownerId: conv.ownerId, conversationId: conv.id, loadedSkillIds };
    const calls = [];
    const emit = (type, payload) => { if (typeof onEvent === "function") onEvent(type, payload); };

    if (resume && resume.toolCall) {
      const call = resume.toolCall;
      let result;
      if (resume.approved) {
        emit("tool_call_started", { toolCall: serializeCall(call) });
        result = await execute(call.name, call.args, ctx, { approved: true });
      } else {
        result = { ok: false, tool: call.name, error: "用户拒绝执行该操作" };
      }
      calls.push({ ...serializeCall(call), status: result.ok ? "completed" : "rejected", summary: compact(result.data || result.error || "") });
      emit(result.ok ? "tool_call_completed" : "tool_call_failed", { toolCall: serializeCall(call), result });
      history.push(toolMessage(call, result));
    }

    for (let step = 0; step < config.maxToolSteps; step++) {
      const response = await completeWithTools(history, modelTools(agent, { loadedSkillIds }), { agent, conv, kbHits, members });
      const content = asText(response.content);
      const rawCalls = Array.isArray(response.tool_calls) ? response.tool_calls : [];
      if (!rawCalls.length) {
        const chunks = content.match(/.{1,48}(?:\s|$)|.{1,48}/g) || [content];
        for (const chunk of chunks) if (chunk) emit("token", { text: chunk });
        return { content, reasoning: asText(response.reasoning_content), toolCalls: calls };
      }

      const normalized = rawCalls.map(normalizeCall).filter((call) => call.name);
      if (!normalized.length) return { content: content || "模型返回了无法识别的工具调用。", reasoning: asText(response.reasoning_content), toolCalls: calls };
      history.push({ role: "assistant", content, tool_calls: normalized.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) });

      for (let index = 0; index < normalized.length; index++) {
        const call = normalized[index];
        const preflight = evaluate(getTool(call.name), ctx);
        if (preflight.approvalRequired) {
          const result = { ok: false, approvalRequired: true, error: preflight.reason, tool: call.name };
          const blocked = normalized.slice(index + 1);
          for (const skipped of blocked) history.push(toolMessage(skipped, { ok: false, error: "该批工具调用因等待用户审批而未执行，请在获得前一结果后重新请求。" }));
          calls.push({ ...serializeCall(call), status: "waiting_approval", summary: result.error });
          emit("tool_call_waiting_approval", { toolCall: serializeCall(call), approval: approvalPreview(call.name, call.args) });
          return {
            content: "", reasoning: asText(response.reasoning_content), toolCalls: calls,
            waitingApproval: { ...approvalPreview(call.name, call.args), toolCall: serializeCall(call), runtimeState: { messages: history } },
          };
        }
        emit("tool_call_started", { toolCall: serializeCall(call) });
        const result = await execute(call.name, call.args, ctx);
        if (result.ok && call.name === "skill_read" && result.data && result.data.path === "SKILL.md" && result.data.skillId) loadedSkillIds.add(result.data.skillId);
        calls.push({ ...serializeCall(call), status: result.ok ? "completed" : "failed", summary: compact(result.data || result.error || "") });
        emit(result.ok ? "tool_call_completed" : "tool_call_failed", { toolCall: serializeCall(call), result });
        history.push(toolMessage(call, result));
      }
    }
    return { content: "工具调用已达到安全步数上限，请缩小任务范围后重试。", toolCalls: calls };
  }
}

module.exports = { AgentRuntime };
