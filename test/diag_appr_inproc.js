"use strict";
const { Store } = require("../server/store");
const { Registry } = require("../server/agents/registry");
const { Orchestrator } = require("../server/engine/orchestrator");
const store = new Store();
const reg = new Registry(); reg.load();
const orch = new Orchestrator(store, reg);
const conv = store.createConversation({ title: "t", memberAgentIds: ["coordinator","literature_researcher","code_researcher","circuit_researcher","mechanical_researcher"], config: { autoRoute: false, maxRounds: 6, kbIds: [] } });
var approvalSeen = false;
store.broadcast = function(cid, e) {
  if (e.type === "approval_request") { approvalSeen = true; console.log("APPROVAL_REQ:", JSON.stringify(e.approval)); }
  else if (e.type === "agent_start") console.log("start:", e.agentName);
  else if (e.type === "agent_end") console.log("end:", e.agentName);
  else if (e.type === "message") console.log("msg:", e.message.authorType, "/", e.message.authorName);
  else if (e.type === "status") console.log("status:", e.status);
  else if (e.type === "error") console.log("ERROR EVT:", e.message);
};
(async () => {
  console.log("=== send risky task ===");
  await orch.runConversation(conv, "@code 跑一下销毁测试数据的清理脚本");
  console.log("after run, status=" + conv.status, "approval=" + JSON.stringify(conv.pendingApproval));
  if (conv.pendingApproval) {
    console.log("\n=== click APPROVE ===");
    try {
      await orch.resumeApproval(conv, { approvalId: conv.pendingApproval.id, approved: true, note: "继续" });
      console.log("after approve, status=" + conv.status, "msgs=" + conv.messages.length);
    } catch (e) { console.log("RESUME ERR:", e.message, e.stack); }
  } else {
    console.log("no approval triggered");
  }
})().catch(function(e){ console.error("ERR", e); process.exit(1); });