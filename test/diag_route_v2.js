"use strict";
// 验证：全角＠也能路由；lead 可并行多@。
const path = require("path");
process.chdir(path.resolve(__dirname, ".."));
const { Store } = require("../server/store");
const { Registry } = require("../server/agents/registry");
const { Orchestrator } = require("../server/engine/orchestrator");

const store = new Store();
const registry = new Registry();
registry.load();
const orch = new Orchestrator(store, registry);

async function run(title, members, text) {
  const events = [];
  store.broadcast = (cid, ev) => { events.push(ev); if (ev.type === "agent_token") process.stdout.write(ev.token || ""); };
  const conv = store.createConversation({ title, memberAgentIds: members, config: { autoRoute: false } });
  await orch.runConversation(conv, text);
  const spoke = new Set(events.filter((e) => e.type === "agent_start").map((e) => e.agentId));
  return { spoke: Array.from(spoke) };
}

(async () => {
  console.log("\n[S1] fullwidth @lit -> expect literature_researcher");
  const s1 = await run("fw", ["coordinator", "literature_researcher", "code_researcher"], "\uFF20lit 用一句话说光纤传感器原理");
  console.log("\n  spoke:", JSON.stringify(s1.spoke));
  const p1 = s1.spoke.length >= 1 && s1.spoke.includes("literature_researcher");
  console.log(p1 ? "  PASS fullwidth @" : "  FAIL");

  console.log("\n[S2] @lead parallel dispatch -> lead may fire, may chain to others");
  const s2 = await run("lead", ["coordinator", "literature_researcher", "code_researcher", "circuit_researcher"], "@lead 我们要做光纤传感器项目，请分工");
  console.log("\n  spoke:", JSON.stringify(s2.spoke));
  const p2 = s2.spoke.includes("coordinator");
  console.log(p2 ? "  PASS lead replied" : "  FAIL (lead did not reply)");

  console.log("\n=== " + ((p1 && p2) ? "ALL PASS" : "SOME FAIL") + " ===");
  process.exit((p1 && p2) ? 0 : 1);
})().catch((e) => { console.error("ERR", e.stack || e); process.exit(2); });
