"use strict";
// 验证链式转交与并行扇出。强制 @lit @code 两个 agent 同时被点名。
const path = require("path");
process.chdir(path.resolve(__dirname, ".."));

const { Store } = require("../server/store");
const { Registry } = require("../server/agents/registry");
const { Orchestrator } = require("../server/engine/orchestrator");

const store = new Store();
const registry = new Registry();
registry.load();
const orchestrator = new Orchestrator(store, registry);

(async () => {
  const spoke = new Set();
  store.broadcast = (convId, event) => {
    if (event.type === "agent_start") { console.log("  >> agent_start", event.agentName); spoke.add(event.agentId); }
    else if (event.type === "agent_end") console.log("  >> agent_end", event.agentName, "chained=", (event.message.mentions || []).join(","));
    else if (event.type === "status") console.log("  >> status", event.status);
    else if (event.type === "error") console.log("  >> ERROR", event.message);
  };

  const conv = store.createConversation({
    title: "chain-test",
    memberAgentIds: ["coordinator", "literature_researcher", "code_researcher", "circuit_researcher"],
  });

  console.log("\n=== @lit @code 并行点名 ===\n");
  await orchestrator.runConversation(conv, "@lit @code 我要做光纤传感器，文献和代码都看看");
  console.log("发言的 agent:", Array.from(spoke).join(", "));
  console.log("消息数:", conv.messages.length);
  const verdict = spoke.size >= 2 ? "PASS 并行扇出正常" : "FAIL 仅 " + spoke.size + " 个发言";
  console.log(verdict);
  process.exit(spoke.size >= 2 ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
