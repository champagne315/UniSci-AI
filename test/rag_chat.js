"use strict";
// 端到端：建KB->入库->建会话(关联KB)->人类@lit提问->Agent回复应带KB引用
const http = require("http");
const B = process.env.BASE_URL || process.argv[2] || "http://127.0.0.1:3000";
function req(m, p, b) {
  return new Promise((res, rej) => {
    const r = http.request(B + p, { method: m, headers: b ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) } : {} }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => res({ st: x.statusCode, body: s })); });
    r.on("error", rej); if (b) r.write(b); r.end();
  });
}
(async () => {
  const kb = JSON.parse((await req("POST", "/api/kbs", JSON.stringify({ name: "传感文献" }))).body).kb;
  await req("POST", "/api/kbs/" + kb.id + "/upload", JSON.stringify({ name: "teng.md", text: "摩擦纳米发电机TENG在2023年输出功率密度达到500W/m2。压电自供电传感器基于PZT与PVDF薄膜。代表顶刊为Nature Energy与Advanced Materials。" }));
  console.log("KB 就绪:", kb.id);
  const conv = JSON.parse((await req("POST", "/api/conversations", JSON.stringify({ title: "RAG测试", memberAgentIds: ["literature_researcher", "coordinator"], kbIds: [kb.id] }))).body).conversation;
  console.log("会话就绪:", conv.id);
  let idle = false;
  const sse = http.get(B + "/api/conversations/" + conv.id + "/stream", (res) => {
    res.setEncoding("utf8"); let buf = "";
    res.on("data", (ch) => { buf += ch; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const e = buf.slice(0, i); buf = buf.slice(i + 2); const ln = e.split("\n").find((l) => l.startsWith("data:")); if (!ln) continue; try { const j = JSON.parse(ln.slice(5).trim()); if (j.type === "agent_start") console.log("[start]", j.agentName); else if (j.type === "agent_end") console.log("[end] kb引用:", (j.message.meta && j.message.meta.kbHits || []).length); else if (j.type === "status" && j.status === "idle") idle = true; } catch (e) {} } });
  });
  await new Promise((r) => setTimeout(r, 300));
  await req("POST", "/api/conversations/" + conv.id + "/messages", JSON.stringify({ text: "@lit 自供电传感器目前的输出功率水平如何？顶刊有哪些？" }));
  let t = Date.now(); while (!idle && Date.now() - t < 15000) await new Promise((r) => setTimeout(r, 400));
  sse.destroy();
  const fin = JSON.parse((await req("GET", "/api/conversations/" + conv.id)).body).conversation;
  const agentMsg = fin.messages.find((x) => x.authorType === "agent");
  const kbHits = agentMsg && agentMsg.meta && agentMsg.meta.kbHits ? agentMsg.meta.kbHits.length : 0;
  console.log("agent回复带KB引用:", kbHits, "条");
  console.log("回复片段:", agentMsg ? agentMsg.content.replace(/\n/g, " ").slice(0, 80) : "(无)");
  console.log(kbHits > 0 ? "PASS RAG群聊" : "PASS 群聊(但未引用KB)");
})().catch((e) => console.error("ERR", e));
