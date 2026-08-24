"use strict";
// 进程内直跑：验证 @lit 只触发 lit，无@给系统提示。绕开 HTTP/SSE。
const path = require("path");
process.chdir(path.resolve(__dirname, ".."));
const { Store } = require("../server/store");
const { Registry } = require("../server/agents/registry");
const { Orchestrator } = require("../server/engine/orchestrator");

const store = new Store();
const registry = new Registry();
registry.load();
const orch = new Orchestrator(store, registry);

async function run(title, text) {
  const events = [];
  const origBcast = store.broadcast.bind(store);
  store.broadcast = (cid, ev) => {
    events.push(ev);
    if (ev.type === "agent_token") process.stdout.write(ev.token || "");
  };
  const conv = store.createConversation({ title, memberAgentIds: ["coordinator", "literature_researcher", "code_researcher"], config: { autoRoute: false } });
  await orch.runConversation(conv, text);
  store.broadcast = origBcast;
  const spoke = new Set(events.filter((e) => e.type === "agent_start").map((e) => e.agentId));
  const sys = conv.messages.find((m) => m.authorType === "system");
  return { spoke: Array.from(spoke), agentMsgs: conv.messages.filter((m) => m.authorType === "agent").length, sys: sys ? sys.content : null };
}

(async () => {
  console.log("\n[S1] @lit -> expect only literature_researcher");
  const s1 = await run("lit-only", "@lit 用两句话简述光纤传感器原理");
  console.log("\n  spoke:", JSON.stringify(s1.spoke), "| agentMsgs:", s1.agentMsgs);
  const pass1 = s1.spoke.length === 1 && s1.spoke[0] === "literature_researcher";
  console.log(pass1 ? "  PASS" : "  FAIL");

  console.log("\n[S2] no @ -> expect system hint, no agent");
  const s2 = await run("no-mention", "讲讲自供电传感器");
  console.log("  spoke:", JSON.stringify(s2.spoke), "| sys:", s2.sys ? "YES" : "NO");
  const pass2 = s2.spoke.length === 0 && !!s2.sys;
  console.log(pass2 ? "  PASS" : "  FAIL");

  console.log("\n[S3] leader prompt -> expect only group members in roster");
  const rosterConv = store.createConversation({
    title: "leader-roster",
    memberAgentIds: ["coordinator", "literature_researcher"],
    config: { autoRoute: false },
  });
  const leader = registry.get("coordinator");
  const leaderPrompt = orch._buildSystemMessage(leader, rosterConv).content;
  const pass3 = leaderPrompt.includes("@lit") && !leaderPrompt.includes("@code") && !leaderPrompt.includes("@patent");
  console.log(pass3 ? "  PASS" : "  FAIL");

  const allPass = pass1 && pass2 && pass3;
  console.log("\n=== " + (allPass ? "ALL PASS" : "SOME FAIL") + " ===");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("ERR", e.stack || e); process.exit(2); });
