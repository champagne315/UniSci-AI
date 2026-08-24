"use strict";

// 群聊路由器（Router）：
// 1. 显式 @ 优先：从文本里解析出 @handle，映射到会话成员 Agent（支持一条消息 @ 多个 -> 并行扇出）。
// 2. 无 @ 时自动选择（autoRoute）：按关键词命中成员 Agent 的 skills/role/name 打分，取 top；命中不到返回空（=等人类）。
// 这一层对应 TDD 里的"条件边决策函数"，可整体替换为 LLM selector 而不改动引擎主循环。

// 兼容半角 @ 与中文输入法常见的全角 ＠（U+FF20）
const MENTION_RE = /[@＠]([a-zA-Z0-9_-]+)/g;

function parseMentions(text) {
  if (!text) return [];
  const out = [];
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) {
    out.push(m[1]);
  }
  // 去重保序
  return Array.from(new Set(out));
}

// 把 @handle 列表映射成会话内的 Agent（不在会话成员里的 @ 被忽略）
function resolveExplicit(handles, members) {
  const res = [];
  for (const h of handles) {
    const lower = h.toLowerCase();
    const a = members.find(
      (x) =>
        (x.mention || "").toLowerCase() === lower ||
        x.id.toLowerCase() === lower
    );
    if (a) res.push(a);
  }
  return res;
}

function scoreAgent(agent, text) {
  const t = (text || "").toLowerCase();
  let score = 0;
  const bag = []
    .concat(agent.skills || [], [agent.role || ""], [agent.name || ""]);
  for (const kw of bag) {
    if (!kw) continue;
    if (t.includes(String(kw).toLowerCase())) score += 2;
  }
  return score;
}

// 无 @ 时的自动选择
function autoSelect(text, members) {
  if (!members.length) return [];
  const scored = members
    .map((a) => ({ a, s: scoreAgent(a, text) }))
    .sort((x, y) => y.s - x.s);
  if (scored[0] && scored[0].s > 0) return [scored[0].a];
  // 兜底：若有协调员，交给它分流；否则第一个发言
  const coord = members.find((a) => a.id === "coordinator");
  return coord ? [coord] : [members[0]];
}

module.exports = { parseMentions, resolveExplicit, autoSelect, scoreAgent };
