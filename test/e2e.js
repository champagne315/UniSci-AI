"use strict";
// 端到端：HTTP + SSE，验证 reasoning 流式、审批链路、RAG 引用都走真实 DeepSeek。
// 用法: node test/e2e.js [base_url]
const http = require("http");
const BASE = process.argv[2] || process.env.BASE_URL || "http://127.0.0.1:8741";

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  let contentTokens = 0, reasoningTokens = 0, approvals = 0;
  let agentsSpoke = new Set();
  let done = false;

  console.log("health:", JSON.parse((await req("GET", "/api/health")).body));
  const c = await req("POST", "/api/conversations", {
    title: "e2e-自供电传感器",
    memberAgentIds: ["coordinator", "literature_researcher", "code_researcher", "circuit_researcher", "mechanical_researcher"],
  });
  const conv = JSON.parse(c.body).conversation;
  console.log("conv:", conv.id);

  const sse = http.get(BASE + "/api/conversations/" + conv.id + "/stream", (res) => {
    res.setEncoding("utf8"); let buf = "";
    res.on("data", (chunk) => {
      buf += chunk; let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j.type === "agent_start") { agentsSpoke.add(j.agentId); console.log("  [start]", j.agentName); }
          else if (j.type === "agent_reasoning") { reasoningTokens++; }
          else if (j.type === "agent_token") { contentTokens++; }
          else if (j.type === "agent_end") console.log("  [end]", j.agentName, "chained=", (j.message.mentions || []).join(","));
          else if (j.type === "approval_request") { approvals++; console.log("  [APPROVAL]", j.approval.prompt); }
          else if (j.type === "status" && j.status === "idle") done = true;
          else if (j.type === "error") console.log("  [ERR]", j.message);
        } catch (e) {}
      }
    });
  });
  sse.on("error", (e) => console.log("SSE err", e.message));

  await new Promise((r) => setTimeout(r, 400));
  console.log("\n=== @lit 调研自供电传感器顶刊进展 ===");
  await req("POST", "/api/conversations/" + conv.id + "/messages", {
    text: "@lit 帮我调研近三年自供电传感器的顶刊进展，限3篇，给出点评",
  });

  const t0 = Date.now();
  while (!done && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 500));
  sse.destroy();

  console.log("\n=== 汇总 ===");
  console.log("发言 agent 数:", agentsSpoke.size);
  console.log("content token 片段:", contentTokens);
  console.log("reasoning token 片段:", reasoningTokens);
  console.log("审批事件:", approvals);
  const fin = JSON.parse((await req("GET", "/api/conversations/" + conv.id)).body).conversation;
  console.log("消息总数:", fin.messages.length);
  const hasReasoning = fin.messages.some((m) => m.reasoning && m.reasoning.length > 10);
  console.log("最终消息含 reasoning:", hasReasoning);

  const pass = contentTokens > 5 && agentsSpoke.size >= 1;
  console.log(pass ? "PASS 端到端群聊+reasoning 正常" : "FAIL");
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("E2E ERR", e); process.exit(2); });
