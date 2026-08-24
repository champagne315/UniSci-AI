"use strict";
const { Store } = require("../server/store");
const { Registry } = require("../server/agents/registry");
const { Orchestrator } = require("../server/engine/orchestrator");
const store = new Store();
const reg = new Registry(); reg.load();
const orch = new Orchestrator(store, reg);
const conv = store.createConversation({ title: "h", memberAgentIds: ["coordinator","literature_researcher","code_researcher","circuit_researcher","mechanical_researcher"], config: { autoRoute: false, maxRounds: 6, kbIds: [] } });
const ev = [];
store.broadcast = function(cid, e) {
  if (e.type === "agent_start") ev.push("start:" + e.agentId);
  else if (e.type === "agent_end") ev.push("end:" + e.agentId + " chained=" + ((e.message && e.message.mentions) || []).join(","));
  else if (e.type === "message") ev.push("msg:" + e.message.authorType + ":" + (e.message.authorName || ""));
};
function flat(s) { return String(s || "").split("\n").join(" "); }
(async () => {
  console.log("=== @lit handoff to @code ===");
  await orch.runConversation(conv, "@lit 先概述光纤传感器，然后 @code 让它写个采集脚本骨架");
  await new Promise(function(r){ setTimeout(r, 500); });
  console.log("events:", JSON.stringify(ev));
  conv.messages.forEach(function(m){ console.log("  [" + m.authorType + "/" + m.authorName + "] " + flat(m.content).slice(0, 80)); });
  var a = conv.messages.filter(function(m){ return m.authorType === "agent"; }).map(function(m){ return m.authorName; });
  console.log("agents:", JSON.stringify(a));
  console.log(a.length >= 2 ? "PASS chain" : "INFO only " + a.length + " spoke");
})().catch(function(e){ console.error("ERR", e); process.exit(1); });