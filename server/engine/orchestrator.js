"use strict";
//
// 群聊编排器 —— LangGraph.js StateGraph 实现。
// 图结构：START -> [起点条件边: 选目标 -> Send 扇出] -> respond -> [respond 后条件边: 链式转交或结束] -> END
// 状态里只放可序列化标量（convId/triggerText/activeAgentId/pending/spoken），
// 会话对象一律按 convId(=thread_id) 从 store 取回，避免把非序列化对象塞进图状态。
//
const config = require("../config");
const { StateGraph, START, END, Send, MemorySaver, Annotation } = require("@langchain/langgraph");
const { stream } = require("./llm");
const { parseMentions, resolveExplicit, autoSelect } = require("./router");
const { appendMessage, uid } = require("../store");
const kbStore = require("../kb/storeInstance");

const APPROVAL_RE = /\[NEEDS_APPROVAL:\s*([^\]]*)\]/;
const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));

// ==========================================================================
// 底层协作规则（编排机制，不进用户可配置的 systemPrompt）
// 「只有被 @ 才回复」「转交给谁」「最多 @ 一位」等属于引擎行为，集中在这里维护，
// 避免散落到每个 Agent 的可编辑人设提示词里被用户看到或改坏。
// ==========================================================================

// 每位员工的转交映射：mention -> 遇到何种情况该 @ 谁
const HANDOFF_MAP = {
  code: "@lit 核对方法原意；@circuit 硬件落地；@mech 结构约束；@lead 重新分工",
  circuit: "@mech 空间/封装/接口约束；@code 核对算法需求；@lit 查相关文献；@lead 重新分工",
  mech: "@circuit 接口/电气约束；@code 算法需求；@lit 查相关文献；@lead 重新分工",
  lit: "@code 复现/核对算法；@circuit 电路方案；@mech 结构封装；@lead 重新分工",
  experiment: "@strategy 假设不清；@stats 统计功效与分析模型；@metrology 测量链路；@lead 重新分工",
  strategy: "@lit 文献证据；@experiment 试验落地；@lead 重新分工",
  stats: "@experiment 实验结构不清；@data 数据清洗与版本；@code 分析代码实现；@lead 重新分工",
  data: "@stats 统计建模；@code 自动化脚本；@repro 复现审计；@lead 重新分工",
  metrology: "@circuit 电路链路；@mech 机械夹具与边界条件；@experiment 实验分组；@lead 重新分工",
  writer: "@lit 引用核查；@visual 图表表达；@repro 复现与方法透明性；@lead 重新分工",
  visual: "@stats 数据含义与统计不确定性；@writer 论文叙事；@code 绘图实现；@lead 重新分工",
  repro: "@data 数据链路；@code 代码环境；@stats 统计报告；@lead 重新分工",
  grant: "@strategy 科学问题打磨；@lit 证据与研究现状；@lead 预算与节奏统筹",
  patent: "技术事实不清找对应领域员工；@lit 现有技术文献补充；@lead 转化优先级统筹",
};

// 群聊状态：全部可序列化。会话本体不放这里。
const ChatState = Annotation.Root({
  convId: Annotation({ reducer: (a, b) => (b === undefined ? a : b) }),
  triggerText: Annotation({ reducer: (a, b) => (b === undefined ? a : b) }),
  activeAgentId: Annotation({ reducer: (a, b) => (b === undefined ? a : b) }),
  pending: Annotation({ reducer: union, default: () => [] }),
  spoken: Annotation({ reducer: union, default: () => [] }),
});

class Orchestrator {
  constructor(store, registry) {
    this.store = store;
    this.registry = registry;
    this.app = this._build();
  }

  _conv(state) {
    return this.store.getConversation(state.convId);
  }
  _members(conv) {
    return conv.memberAgentIds.map((id) => this.registry.get(id, conv.ownerId)).filter(Boolean);
  }
  _broadcast(conv, payload) {
    this.store.broadcast(conv.id, Object.assign({ conversationId: conv.id }, payload));
  }

  _registerApproval(conv, approval) {
    conv.pendingApprovalQueue = conv.pendingApprovalQueue || [];
    if (!conv.pendingApproval) {
      conv.pendingApproval = approval;
      return true;
    }
    conv.pendingApprovalQueue.push(approval);
    return false;
  }

  _promoteNextApproval(conv) {
    const queue = conv.pendingApprovalQueue || [];
    conv.pendingApproval = queue.shift() || null;
    return conv.pendingApproval;
  }

  _recordHandoffs(conv, sourceMessage, targetIds) {
    conv._turnHandoffs = conv._turnHandoffs || new Map();
    for (const targetId of targetIds) {
      if (!conv._turnHandoffs.has(targetId)) conv._turnHandoffs.set(targetId, []);
      conv._turnHandoffs.get(targetId).push({
        sourceMessageId: sourceMessage.id,
        sourceName: sourceMessage.authorName || sourceMessage.author,
        content: sourceMessage.content,
      });
    }
  }

  _handoffTrigger(conv, targetId, fallback) {
    const handoffs = conv._turnHandoffs && conv._turnHandoffs.get(targetId);
    if (!handoffs || !handoffs.length) return fallback;
    conv._turnHandoffs.delete(targetId);
    return handoffs.map((handoff) =>
      "(@" + handoff.sourceName + " 在群聊中 @ 了你并转交任务，以下是该成员的发言，请据此给出专业回应）\n" + handoff.content
    ).join("\n\n");
  }

  _drainQueuedRun(conv) {
    if (!conv || !this.store.getConversation(conv.id)) return;
    const next = this.store.shiftRun(conv.id);
    if (next == null) return;
    this.runConversation(conv, next).catch((e) => console.error("[queued run] error", e));
  }

  // 算出本轮应发言的 Agent（会话级 _turnSpoken 去重，并发扇出也安全；总量由 maxRounds 封顶）
  _targets(state, conv) {
    const members = this._members(conv);
    const turnSpoken = conv._turnSpoken || new Set();
    const turnScheduled = conv._turnScheduled || new Set();
    const maxRounds = conv.config.maxRounds || config.maxRounds;
    if (turnSpoken.size >= maxRounds) return [];
    let targets = [];
    if (state.pending && state.pending.length) {
      targets = state.pending.map((id) => members.find((m) => m.id === id)).filter(Boolean);
    }
    if (!targets.length) {
      const explicit = resolveExplicit(parseMentions(state.triggerText), members);
      targets = explicit.length ? explicit : (conv.config.autoRoute ? autoSelect(state.triggerText, members) : []);
    }
    return targets.filter((a) => !turnSpoken.has(a.id) && !turnScheduled.has(a.id));
  }

  _build() {
    const self = this;

    // 起点条件边：算出目标 -> 扇出若干 Send 到 respond；无目标 -> END
    const startEdge = (state) => {
      const conv = self._conv(state);
      if (!conv) return "__end__";
      const targets = self._targets(state, conv);
      if (!targets.length) return "__end__";
      conv._turnScheduled = conv._turnScheduled || new Set();
      targets.forEach((a) => conv._turnScheduled.add(a.id));
      return targets.map((a) => new Send("respond", {
        convId: state.convId, triggerText: state.triggerText, activeAgentId: a.id,
        spoken: state.spoken, pending: [],
      }));
    };

    // respond 节点：单个 Agent 流式回复 + 知识库引用 + 链式转交 + 审批挂起
    const respondNode = async (state) => {
      const conv = self._conv(state);
      if (!conv) return { pending: [] };
      const agent = self.registry.get(state.activeAgentId, conv.ownerId);
      if (!agent) return { pending: [], spoken: [state.activeAgentId] };

      self._broadcast(conv, { type: "agent_start", agentId: agent.id, agentName: agent.name, avatar: agent.avatar, color: agent.color });
      conv.runningAgentId = agent.id;
      // 本轮已发言记录挂在会话上，规避并行 Send 的状态合并竞态
      conv._turnSpoken = conv._turnSpoken || new Set();
      conv._turnSpoken.add(agent.id);

      const members = self._members(conv);
      const kbIds = agent.kbIds && agent.kbIds.length ? agent.kbIds : (conv.config.kbIds || []);
      const kbHits = kbIds.length ? await kbStore.retrieve(state.triggerText, kbIds, 4, conv.ownerId) : [];

      const messages = [self._buildSystemMessage(agent, conv)];
      if (kbHits.length) {
        messages.push({
          role: "system",
          content: "以下是知识库相关片段，结论须引用：\n" + kbHits.map((h, i) => "[" + (i + 1) + "]（" + h.source + "） " + h.text.slice(0, 200)).join("\n"),
        });
      }
      messages.push(...self._historyToMessages(conv, config.historyWindow));
      const last = messages[messages.length - 1];
      if (!last || last.role !== "user") {
        messages.push({ role: "user", content: state.triggerText || "（请基于上下文继续）" });
      }

      let contentFull = "";
      let reasoningFull = "";
      try {
        for await (const part of stream(messages, { agent, conv, kbHits, members })) {
          if (part && part.kind === "reasoning") { reasoningFull += part.text; self._broadcast(conv, { type: "agent_reasoning", agentId: agent.id, token: part.text }); }
          else if (part && part.kind === "content") { contentFull += part.text; self._broadcast(conv, { type: "agent_token", agentId: agent.id, token: part.text }); }
          else if (typeof part === "string") { contentFull += part; self._broadcast(conv, { type: "agent_token", agentId: agent.id, token: part }); }
        }
      } catch (e) {
        contentFull += "\n\n[生成失败: " + e.message + "]";
      }

      const am = contentFull.match(APPROVAL_RE);
      const pendingApproval = am ? { id: uid("approval"), prompt: am[1].trim() } : null;
      const chainedIds = resolveExplicit(parseMentions(contentFull), members)
        .filter((a) => a.id !== agent.id)
        .map((a) => a.id);

      const msg = appendMessage(conv, {
        authorType: "agent", author: agent.id, authorName: agent.name, avatar: agent.avatar, color: agent.color,
        content: contentFull, reasoning: reasoningFull || undefined,
        mentions: parseMentions(contentFull),
        meta: { kbHits: kbHits.map((h) => ({
          source: h.source,
          kbId: h.kbId,
          kbName: h.kbName,
          score: h.score,
          semanticScore: h.semanticScore,
          lexicalScore: h.lexicalScore,
          matchType: h.matchType,
        })) },
        pendingApproval,
      });
      if (chainedIds.length) self._recordHandoffs(conv, msg, chainedIds);

      let isActiveApproval = false;
      if (pendingApproval) {
        isActiveApproval = self._registerApproval(conv, {
          id: pendingApproval.id,
          messageId: msg.id,
          agentId: agent.id,
          prompt: pendingApproval.prompt,
          nextTargets: chainedIds,
        });
        conv.status = "awaiting_approval";
      }

      self._broadcast(conv, { type: "agent_end", agentId: agent.id, agentName: agent.name, message: msg });
      conv.runningAgentId = null;

      if (pendingApproval) {
        if (isActiveApproval) self._broadcast(conv, { type: "approval_request", approval: conv.pendingApproval });
        return { pending: [] };
      }

      return { pending: chainedIds, spoken: [agent.id] };
    };

    // respond 之后：还有未发言目标且未超轮次 -> 再扇出；否则 END
    const afterRespond = (state) => {
      const conv = self._conv(state);
      if (!conv) return "__end__";
      const targets = self._targets(state, conv);
      if (!targets.length) return "__end__";
      conv._turnScheduled = conv._turnScheduled || new Set();
      targets.forEach((a) => conv._turnScheduled.add(a.id));
      return targets.map((a) => new Send("respond", {
        convId: state.convId,
        triggerText: self._handoffTrigger(conv, a.id, state.triggerText),
        activeAgentId: a.id,
        spoken: state.spoken,
        pending: [],
      }));
    };

    const graph = new StateGraph(ChatState)
      .addNode("respond", respondNode)
      .addConditionalEdges(START, startEdge, ["respond", "__end__"])
      .addConditionalEdges("respond", afterRespond, ["respond", "__end__"]);

    const checkpointer = new MemorySaver();
    return graph.compile({ checkpointer });
  }

  // 人类审批后续跑链路（同一会话的多个审批按产生顺序逐个处理）
  async resumeApproval(conv, decision) {
    if (!conv || conv.status !== "awaiting_approval" || !conv.pendingApproval) {
      const error = new Error("当前会话没有待处理的审批");
      error.statusCode = 409;
      throw error;
    }
    if (conv._approvalResuming) {
      const error = new Error("该审批正在处理中");
      error.statusCode = 409;
      throw error;
    }

    const approval = conv.pendingApproval;
    if (!decision || !decision.approvalId) {
      const error = new Error("缺少 approvalId");
      error.statusCode = 400;
      throw error;
    }
    if (decision.approvalId !== approval.id) {
      const error = new Error("审批已过期或不是当前待处理项");
      error.statusCode = 409;
      throw error;
    }

    conv._approvalResuming = true;
    try {
      conv.status = "running";
      this._broadcast(conv, { type: "status", status: "running" });

      const note = decision && decision.note ? decision.note.trim() : "";
      const approved = !!(decision && decision.approved);
      let targets = approval.nextTargets || [];
      const dm = appendMessage(conv, {
        authorType: "human", author: "human", authorName: "我",
        content: approved
          ? "✅ 批准" + (note ? "：" + note : "：同意该方案，请继续。")
          : "❌ 驳回" + (note ? "：" + note : "：暂不采纳，请改方案。"),
        mentions: [],
        meta: { approvalId: approval.id, approvalMessageId: approval.messageId, approved },
      });
      this._broadcast(conv, { type: "message", message: dm });

      const sourceMessage = conv.messages.find((m) => m.id === approval.messageId);
      if (sourceMessage) {
        sourceMessage.pendingApproval = null;
        sourceMessage.meta = Object.assign({}, sourceMessage.meta, {
          approvalDecision: { id: approval.id, approved, note, decidedAt: Date.now() },
        });
      }
      this._broadcast(conv, {
        type: "approval_resolved",
        approvalId: approval.id,
        messageId: approval.messageId,
        approved,
      });

      // 批准后：优先用链式转交目标；若没有，则让发起审批的 Agent 回来确认并继续
      if (approved) {
        if (!targets.length && approval.agentId) targets = [approval.agentId];
        if (targets.length) {
          conv._turnSpoken = new Set();
          conv._turnScheduled = new Set();
          conv._turnHandoffs = new Map();
          conv._turnSeq = (conv._turnSeq || 0) + 1;
          const threadConfig = { configurable: { thread_id: conv.id + "#t" + conv._turnSeq }, recursionLimit: 60 };
          const seed = { convId: conv.id, triggerText: "（人类已批准，请继续推进）", pending: targets, spoken: [] };
          const stream$ = await this.app.stream(seed, threadConfig);
          for await (const _evt of stream$) { /* 节点内已广播 token */ }
        }
      }
    } catch (e) {
      console.error("[resumeApproval] error:", e);
      this._broadcast(conv, { type: "error", message: "恢复出错：" + (e && e.message ? e.message : String(e)) });
    } finally {
      conv._approvalResuming = false;
      conv.pendingApproval = null;
      const nextApproval = this._promoteNextApproval(conv);
      if (nextApproval) {
        conv.status = "awaiting_approval";
        this._broadcast(conv, { type: "status", status: "awaiting_approval" });
        this._broadcast(conv, { type: "approval_request", approval: nextApproval });
      } else {
        conv.status = "idle";
        this._broadcast(conv, { type: "status", status: "idle" });
        this.store.release(conv.id);
        this._drainQueuedRun(conv);
      }
    }
  }

  // 底层协作规则：被动响应 + 转交映射 + 审批，统一在引擎里注入，不进入可编辑 systemPrompt
  _collabRule(agent, members = []) {
    const isCoordinator = agent.id === "coordinator" || String(agent.mention || "").toLowerCase() === "lead";
    const approvalRule = "只有当你准备执行某个有风险或不可逆的操作（如运行破坏性脚本、删除数据、消耗资源的仿真）时，才在回复末尾另起一行写 [NEEDS_APPROVAL: 简述操作] 请求人类授权。如果只是信息不足或需要用户补充需求，直接在回复里提问即可，不要触发审批。回答专业、结构化、结论先行，控制在 250 字以内。";

    if (isCoordinator) {
      const roster = members
        .filter((member) => member.id !== agent.id)
        .map((member) => "@" + (member.mention || member.id) + " " + (member.description || member.role || member.name))
        .join("；");
      return "【群聊机制】你只有被 @ 时才会发言，这是你本轮唯一的回复。作为调度者，你可以同时 @ 多个专家并行推进各自独立的子任务。\n" +
        "【本群可调度成员】" + (roster || "当前没有其他成员") + "。仅可 @ 此处列出的成员，不要提及或调用群外 Agent。\n" +
        "@ 别人时请用半角 @ 符号。" + approvalRule;
    }

    const handoff = HANDOFF_MAP[String(agent.mention || agent.id).toLowerCase()];
    const handoffLine = handoff
      ? "如需其他专家协作，最多 @ 一位最相关员工并说明需要对方做什么：" + handoff + "。不要同时 @ 多人，能自己答完的就不要 @ 别人。"
      : "如需其他专家协作，最多 @ 一位最相关员工（重新分工找 @lead）并说明需要对方做什么。不要同时 @ 多人，能自己答完的就不要 @ 别人。";
    return "【群聊机制】你只有被 @ 时才会发言，这是你本轮唯一的回复。" + handoffLine + " @ 别人时请用半角 @ 符号。" + approvalRule;
  }

  _buildSystemMessage(agent, conv) {
    if (conv && conv.kind === "direct") {
      return {
        role: "system",
        content: agent.systemPrompt +
          "\n\n【单聊模式】你正在和用户一对一直接对话。任何用户消息都必须由你直接、认真回复——不需要等待 @，也不需要指定其他 Agent。专注于这件事本身，给出最专业的答案。只有当你准备执行有风险或不可逆的操作（如运行破坏性脚本、删除数据、消耗资源的仿真）时，才在回复末尾另起一行写 [NEEDS_APPROVAL: 简述操作] 请求人类授权；如果只是信息不足或需要用户补充需求，直接在回复里提问即可，不要触发审批。回答专业、结构化、结论先行，控制在 250 字以内。",
      };
    }
    return {
      role: "system",
      content: agent.systemPrompt + "\n\n" + this._collabRule(agent, this._members(conv)),
    };
  }

  _historyToMessages(conv, windowSize) {
    const recent = conv.messages.slice(-windowSize);
    return recent.map((m) => ({
      role: m.authorType === "agent" ? "assistant" : "user",
      content: (m.authorName || m.author) + "：" + m.content,
    }));
  }

  async runConversation(conv, triggerText) {
    if (!this.store.tryAcquire(conv.id)) {
      const queueLength = this.store.enqueueRun(conv.id, triggerText);
      this._broadcast(conv, { type: "message_queued", queueLength });
      return { queued: true, queueLength };
    }
    try {
      conv.status = "running";
      this._broadcast(conv, { type: "status", status: "running" });

      // 新一轮人类消息：重置本轮发言记录，并用全新 thread_id 跑图
      // （否则 MemorySaver 里 union reducer 会让上一轮的 pending/spoken 跨轮累积，
      //  上一轮发言过的 Agent 永远留在 pending 里，下一轮又被错误扇出）
      conv._turnSpoken = new Set();
      conv._turnScheduled = new Set();
      conv._turnHandoffs = new Map();
      conv._turnSeq = (conv._turnSeq || 0) + 1;

      const members = this._members(conv);
      let seed = [];
      if (conv.kind === "direct") {
        // 单聊：只许一位成员，强制定向，不走 @ 也不走 autoRoute
        seed = members.slice(0, 1);
        if (!seed.length) {
          const hint = appendMessage(conv, {
            authorType: "system", author: "system", authorName: "系统",
            content: "单聊里没有可用成员。",
            mentions: [],
          });
          this._broadcast(conv, { type: "message", message: hint });
          conv.status = "idle";
          this._broadcast(conv, { type: "status", status: "idle" });
          return;
        }
      } else {
        const initial = resolveExplicit(parseMentions(triggerText), members);
        seed = initial.length ? initial : (conv.config.autoRoute ? autoSelect(triggerText, members) : []);
        if (!seed.length) {
          // 无显式 @ 且未开启自动路由：静默不响应，不产生任何提示
          conv.status = "idle";
          this._broadcast(conv, { type: "status", status: "idle" });
          return;
        }
      }

      const threadConfig = { configurable: { thread_id: conv.id + "#t" + conv._turnSeq }, recursionLimit: 60 };
      const stream$ = await this.app.stream(
        { convId: conv.id, triggerText, pending: seed.map((a) => a.id), spoken: [] },
        threadConfig
      );
      for await (const _evt of stream$) { /* 节点内已广播 token */ }

      if (conv.status !== "awaiting_approval") {
        conv.status = "idle";
        this._broadcast(conv, { type: "status", status: "idle" });
      }
    } catch (e) {
      console.error("[orchestrator] error:", e);
      conv.status = "idle";
      this._broadcast(conv, { type: "error", message: "群聊出错：" + (e && e.message ? e.message : String(e)) });
    } finally {
      if (conv.status !== "awaiting_approval") {
        this.store.release(conv.id);
        this._drainQueuedRun(conv);
      }
    }
  }
}

module.exports = { Orchestrator };
