"use strict";

// LLM 抽象层（LangGraph.js 版）：
// 真模式用 @langchain/openai 的 ChatOpenAI 连 DeepSeek（OpenAI 兼容协议）。
// deepseek-v4-flash 是推理模型，reasoning_content 在 additional_kwargs、content 是最终回答。
// 流式接口约定：async function* stream(messages, ctx)
//   -> yields { kind: "reasoning"|"content", text }
// 兼容字段：返回纯字符串时按 content 处理（老调用方平滑）。

const config = require("../config");
let ChatOpenAI = null;
try { ChatOpenAI = require("@langchain/openai").ChatOpenAI; } catch (e) {}

// 复用 ChatOpenAI 实例（DeepSeek 端点）
let _llm = null;
function getLLM() {
  if (_llm) return _llm;
  if (!ChatOpenAI) throw new Error("@langchain/openai 未安装");
  _llm = new ChatOpenAI({
    model: config.model,
    configuration: {
      baseURL: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
    },
    temperature: 0.7,
    streaming: true,
  });
  return _llm;
}

function toLCMessages(messages) {
  return messages.map((m) => {
    if (m.role === "system") return new (require("@langchain/core/messages").SystemMessage)(m.content);
    if (m.role === "user") return new (require("@langchain/core/messages").HumanMessage)(m.content);
    return new (require("@langchain/core/messages").AIMessage)(m.content);
  });
}

async function* streamOpenAI(messages, ctx) {
  const llm = getLLM();
  const lc = toLCMessages(messages);
  const s = await llm.stream(lc);
  for await (const chunk of s) {
    const content = chunk.content || "";
    const reason = (chunk.additional_kwargs && chunk.additional_kwargs.reasoning_content) || "";
    // 先吐 reasoning（思考过程），再吐 content（正式回答）
    if (reason && config.showReasoning) {
      yield { kind: "reasoning", text: reason };
    }
    if (content) {
      yield { kind: "content", text: String(content) };
    }
  }
}

// ---------- 本地 mock（离线冒烟，不再作为默认路径）----------
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildMockReply(agent, conv, ctx) {
  const { lastHumanText, kbHits, members } = ctx;
  const name = agent.name;
  const role = agent.role || agent.name;
  const skills = (agent.skills || []).slice(0, 3);
  const tools = agent.tools || [];
  const lines = [];
  lines.push(`（${name} · ${role}）`);
  lines.push(pick([`我以 ${role} 的角度回应一下。`, `从我的专业领域看，关键在于：`, `好的，我来切入。`]));
  if (kbHits && kbHits.length) {
    lines.push(`\n依据知识库（${kbHits.length} 条命中）：`);
    kbHits.slice(0, 2).forEach((h, i) => {
      lines.push(`  [${i + 1}] ${(h.text || "").slice(0, 60).replace(/\s+/g, " ")}… ——《${h.source || "知识库"}》`);
    });
  }
  if (skills.length) lines.push(`\n动用 ${skills.join("、")} 推进：拆解边界 → 中间结论 → 指出需配合处。`);
  const others = (members || []).filter((m) => m.id !== agent.id && !lastHumanText.includes("@" + (m.mention || m.id)));
  if (others.length && Math.random() < 0.5) {
    const t = pick(others);
    lines.push(`\n需 ${t.name} 配合，@${t.mention || t.id} 你怎么看？`);
  } else if (tools.length && Math.random() < 0.35) {
    lines.push(`\n此处有关键取舍需你拍板。`);
    lines.push(`[NEEDS_APPROVAL: 是否采纳该方案？（批准后继续 ${tools[0]}）]`);
  } else {
    lines.push(`\n结论先行：先验证最关键假设，再展开。`);
  }
  return lines.join("\n");
}

async function* streamMock(messages, ctx) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = buildMockReply(ctx.agent, ctx.conv, {
    lastHumanText: lastUser ? lastUser.content : "",
    kbHits: ctx.kbHits,
    members: ctx.members,
  });
  const tokens = text.split(/(\s+)/);
  for (const tk of tokens) {
    yield { kind: "content", text: tk };
    if (config.mockTypeDelayMs > 0) await new Promise((r) => setTimeout(r, config.mockTypeDelayMs));
  }
}

async function* stream(messages, ctx) {
  if (config.isMock) {
    yield* streamMock(messages, ctx);
  } else {
    yield* streamOpenAI(messages, ctx);
  }
}

module.exports = { stream, buildMockReply, getLLM };
