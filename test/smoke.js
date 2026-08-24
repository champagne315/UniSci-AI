"use strict";
// 端到端冒烟测试：建会话 -> 发带@消息 -> 收 SSE 流 -> 打印 agent 回复与链式转交。
// 用法: node test/smoke.js [base_url]

const http = require("http");
const BASE = process.argv[2] || process.env.BASE_URL || "http://127.0.0.1:3000";

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log("health:", (await req("GET", "/api/health")).body);
  const c = await req("POST", "/api/conversations", {
    title: "测试：自供电传感器调研",
    memberAgentIds: ["coordinator", "literature_researcher", "code_researcher", "circuit_researcher", "mechanical_researcher"],
  });
  const conv = JSON.parse(c.body).conversation;
  console.log("会话:", conv.id, "| 成员:", conv.memberAgentIds.length);

  let done = false;
  let tokens = 0;
  const sse = http.get(BASE + "/api/conversations/" + conv.id + "/stream", (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j.type === "agent_start") console.log("  [agent_start]", j.agentName);
          else if (j.type === "agent_token") { process.stdout.write(j.token); tokens++; }
          else if (j.type === "agent_end") console.log("\n  [agent_end] mentions=" + (j.message.mentions || []).join(",") + (j.message.pendingApproval ? " NEEDS_APPROVAL" : ""));
          else if (j.type === "approval_request") console.log("  [APPROVAL_REQ]", j.approval.prompt);
          else if (j.type === "status" && j.status === "idle") done = true;
          else if (j.type !== "snapshot" && j.type !== "status") console.log("  [" + j.type + "]");
        } catch (e) {}
      }
    });
  });
  sse.on("error", (e) => console.log("SSE err", e.message));

  await new Promise((r) => setTimeout(r, 400));
  console.log("\n=== 人类: @lit 帮我调研近三年自供电传感器 ===\n");
  await req("POST", "/api/conversations/" + conv.id + "/messages", {
    text: "@lit 帮我调研近三年自供电传感器的进展，限顶刊。",
  });

  // 等到 status idle（最多 15s）
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 300));
  sse.destroy();

  const fin = await req("GET", "/api/conversations/" + conv.id);
  const conv2 = JSON.parse(fin.body).conversation;
  console.log("\n=== 总 token 片段:", tokens, "| 消息数:", conv2.messages.length, "===");
  conv2.messages.forEach((m) => console.log(" -", m.authorType, m.authorName, ":", (m.content || "").slice(0, 50).replace(/\n/g, " "), m.pendingApproval ? "[待批]" : ""));
  // 期望: 1 人类 + >=1 agent 回复
  const agentMsgs = conv2.messages.filter((m) => m.authorType === "agent");
  console.log(agentMsgs.length >= 1 ? "PASS 群聊链路正常" : "FAIL 无 agent 回复");
  process.exit(agentMsgs.length >= 1 ? 0 : 1);
})().catch((e) => { console.error("TEST ERR", e); process.exit(2); });
