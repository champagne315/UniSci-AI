"use strict";
// 复现 bug：先 @A 再 @B，第二轮是否 A 又冒出来回答。
const path = require("path");
process.chdir(path.resolve(__dirname, ".."));
const { Store } = require("../server/store");
const { Registry } = require("../server/agents/registry");
const { Orchestrator } = require("../server/engine/orchestrator");

const store = new Store();
const registry = new Registry();
registry.load();
const orch = new Orchestrator(store, registry);

async function turn(conv, text, label) {
  const speakers = [];
  store.broadcast = (cid, ev) => {
    if (ev.type === "agent_start") { speakers.push(ev.agentId); console.log("    [" + label + "] start:", ev.agentName); }
    else if (ev.type === "agent_token") process.stdout.write(ev.token || "");
    else if (ev.type === "agent_end") console.log("\n    [" + label + "] end:", ev.agentName, "chained=", (ev.message.mentions || []).join(","));
    else if (ev.type === "message" && ev.message && ev.message.authorType === "system") console.log("    [" + label + "] SYSTEM:", ev.message.content.slice(0, 40));
  };
  console.log("\n=== TURN " + label + ": " + text + " ===");
  await orch.runConversation(conv, text);
  return speakers;
}

(async () => {
  const conv = store.createConversation({
    title: "seq-bug",
    memberAgentIds: ["coordinator", "literature_researcher", "code_researcher"],
    config: { autoRoute: false },
  });
  const t1 = await turn(conv, "@lit 用一句话讲光纤传感器原理", "1-@lit");
  const t2 = await turn(conv, "@code 用 Python 写一个 hello world", "2-@code");

  console.log("\n=== RESULT ===");
  console.log("turn1 speakers:", JSON.stringify(t1));
  console.log("turn2 speakers:", JSON.stringify(t2));
  const bug = t2.includes("literature_researcher");
  console.log(bug ? "BUG CONFIRMED: lit spoke in turn2 despite @code" : "OK: turn2 only code (or empty)");
  process.exit(bug ? 1 : 0);
})().catch((e) => { console.error("ERR", e.stack || e); process.exit(2); });
