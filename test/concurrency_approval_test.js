"use strict";

const assert = require("assert");
const { Store, appendMessage } = require("../server/store");
const { Registry } = require("../server/agents/registry");
const { Orchestrator } = require("../server/engine/orchestrator");

function createOrchestrator() {
  const store = new Store();
  const registry = new Registry();
  registry.load();
  return { store, orchestrator: new Orchestrator(store, registry) };
}

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("等待条件超时"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function testBusyConversationQueue() {
  const { store, orchestrator } = createOrchestrator();
  const conv = store.createConversation({
    title: "queue",
    memberAgentIds: ["coordinator"],
    config: { autoRoute: false },
  });

  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  orchestrator.app = {
    stream: async (seed) => {
      calls.push(seed.triggerText);
      if (calls.length === 1) await firstGate;
      return (async function* emptyStream() {})();
    },
  };

  const firstRun = orchestrator.runConversation(conv, "@lead 第一条");
  await waitFor(() => calls.length === 1);
  const queued = await orchestrator.runConversation(conv, "@lead 第二条");
  assert.deepStrictEqual(queued, { queued: true, queueLength: 1 });
  assert.strictEqual(store.pendingRunCount(conv.id), 1);

  releaseFirst();
  await firstRun;
  await waitFor(() => calls.length === 2 && !store.runningLocks.has(conv.id));
  assert.deepStrictEqual(calls, ["@lead 第一条", "@lead 第二条"]);
  assert.strictEqual(store.pendingRunCount(conv.id), 0);
}

async function testApprovalQueueAndHistoryCleanup() {
  const invalid = createOrchestrator();
  const runningConv = invalid.store.createConversation({ title: "running", memberAgentIds: ["coordinator"] });
  assert.strictEqual(invalid.store.tryAcquire(runningConv.id), true);
  runningConv.status = "running";
  await assert.rejects(
    invalid.orchestrator.resumeApproval(runningConv, { approvalId: "missing", approved: true }),
    /没有待处理的审批/
  );
  assert.strictEqual(invalid.store.runningLocks.has(runningConv.id), true);
  invalid.store.release(runningConv.id);

  const { store, orchestrator } = createOrchestrator();
  const conv = store.createConversation({ title: "approval", memberAgentIds: ["coordinator"] });
  assert.strictEqual(store.tryAcquire(conv.id), true);

  const message1 = appendMessage(conv, {
    authorType: "agent",
    author: "coordinator",
    authorName: "协调员",
    content: "操作一",
    pendingApproval: { id: "approval_1", prompt: "批准操作一？" },
  });
  const message2 = appendMessage(conv, {
    authorType: "agent",
    author: "coordinator",
    authorName: "协调员",
    content: "操作二",
    pendingApproval: { id: "approval_2", prompt: "批准操作二？" },
  });

  conv.pendingApproval = {
    id: "approval_1",
    messageId: message1.id,
    agentId: "coordinator",
    prompt: "批准操作一？",
    nextTargets: [],
  };
  conv.pendingApprovalQueue = [{
    id: "approval_2",
    messageId: message2.id,
    agentId: "coordinator",
    prompt: "批准操作二？",
    nextTargets: [],
  }];
  conv.status = "awaiting_approval";
  const approvalRuns = [];
  orchestrator.app = {
    stream: async (seed) => {
      approvalRuns.push(seed);
      return (async function* emptyStream() {})();
    },
  };

  await orchestrator.resumeApproval(conv, { approvalId: "approval_1", approved: true, note: "继续执行" });
  assert.strictEqual(message1.pendingApproval, null);
  assert.strictEqual(message1.meta.approvalDecision.approved, true);
  assert.strictEqual(approvalRuns.length, 1);
  assert.strictEqual(conv.pendingApproval.id, "approval_2");
  assert.strictEqual(conv.status, "awaiting_approval");
  assert.strictEqual(store.runningLocks.has(conv.id), true);

  await assert.rejects(
    orchestrator.resumeApproval(conv, { approvalId: "approval_1", approved: true }),
    /审批已过期/
  );
  await assert.rejects(
    orchestrator.resumeApproval(conv, { approved: true }),
    /缺少 approvalId/
  );
  assert.strictEqual(store.runningLocks.has(conv.id), true);

  await orchestrator.resumeApproval(conv, { approvalId: "approval_2", approved: false });
  assert.strictEqual(message2.pendingApproval, null);
  assert.strictEqual(conv.pendingApproval, null);
  assert.strictEqual(conv.status, "idle");
  assert.strictEqual(store.runningLocks.has(conv.id), false);
}

function testBranchSpecificHandoffs() {
  const { store, orchestrator } = createOrchestrator();
  const conv = store.createConversation({ title: "handoff", memberAgentIds: [] });
  const sourceA = appendMessage(conv, {
    authorType: "agent", author: "a", authorName: "Agent A", content: "A 的专属任务",
  });
  const sourceB = appendMessage(conv, {
    authorType: "agent", author: "b", authorName: "Agent B", content: "B 的专属任务",
  });

  orchestrator._recordHandoffs(conv, sourceA, ["target_a"]);
  orchestrator._recordHandoffs(conv, sourceB, ["target_b"]);
  const triggerA = orchestrator._handoffTrigger(conv, "target_a", "fallback");
  const triggerB = orchestrator._handoffTrigger(conv, "target_b", "fallback");

  assert.match(triggerA, /A 的专属任务/);
  assert.doesNotMatch(triggerA, /B 的专属任务/);
  assert.match(triggerB, /B 的专属任务/);
  assert.doesNotMatch(triggerB, /A 的专属任务/);
}

(async () => {
  await testBusyConversationQueue();
  await testApprovalQueueAndHistoryCleanup();
  testBranchSpecificHandoffs();
  console.log("PASS 并发消息、审批队列、历史清理与分支转交");
})().catch((error) => {
  console.error("FAIL", error.stack || error);
  process.exit(1);
});
