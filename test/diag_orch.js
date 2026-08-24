"use strict";
// 直接在进程内调用 orchestrator，抓完整异常堆栈（绕开 HTTP/SSE）。
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
  const agents = registry.all();
  console.log("agents:", agents.map((a) => a.id + "/" + (a.mention || a.id)).join(", "));

  const conv = store.createConversation({
    title: "diag",
    memberAgentIds: ["coordinator", "literature_researcher", "code_researcher"],
  });
  console.log("conv:", conv.id);

  store.broadcast = (convId, event) => {
    if (event.type === "agent_start") console.log("  >> agent_start", event.agentName);
    else if (event.type === "agent_token") process.stdout.write(event.token || "");
    else if (event.type === "agent_end") console.log("\n  >> agent_end mentions=", (event.message.mentions || []).join(","));
    else if (event.type === "error") console.log("  >> ERROR EVT:", event.message);
    else console.log("  >>", event.type, event.status || "");
  };

  console.log("\n=== runConversation ===\n");
  try {
    await orchestrator.runConversation(conv, "@lit 帮我调研光纤传感器的进展，限3篇");
    console.log("\n=== DONE, status =", conv.status, "===");
    console.log("messages:", conv.messages.length);
    conv.messages.forEach((m) =>
      console.log(" -", m.authorType, m.authorName, ":", (m.content || "").slice(0, 80).replace(/\n/g, " "), m.pendingApproval ? "[待批]" : "")
    );
  } catch (e) {
    console.error("\n!!! runConversation threw:");
    console.error(e && e.stack ? e.stack : e);
  }
  process.exit(0);
})();
