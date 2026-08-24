"use strict";
// 验证精确路由：单@只该 agent 回复；无@给系统提示、无 agent 乱答。
const http = require("http");
const B = process.env.BASE_URL || process.argv[2] || "http://127.0.0.1:8080";
function req(m, p, b) {
  return new Promise((res, rej) => {
    const data = b ? JSON.stringify(b) : null;
    const r = http.request(B + p, { method: m, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => res({ st: x.statusCode, body: s })); });
    r.on("error", rej); if (data) r.write(data); r.end();
  });
}
function scenario(title, members, msg, waitMs) {
  return new Promise(async (resolve) => {
    const c = JSON.parse((await req("POST", "/api/conversations", JSON.stringify({ title, memberAgentIds: members, autoRoute: false }))).body).conversation;
    const spoke = new Set();
    let systemMsg = null, idle = false;
    const sse = http.get(B + "/api/conversations/" + c.id + "/stream", (res) => {
      res.setEncoding("utf8"); let buf = "";
      res.on("data", (ch) => { buf += ch; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const e = buf.slice(0, i); buf = buf.slice(i + 2); const ln = e.split("\n").find((l) => l.startsWith("data:")); if (!ln) continue; try { const j = JSON.parse(ln.slice(5).trim()); if (j.type === "agent_start") spoke.add(j.agentId); else if (j.type === "message" && j.message && j.message.authorType === "system") systemMsg = j.message.content; else if (j.type === "status" && j.status === "idle") idle = true; } catch (er) {} } });
    });
    await new Promise((r) => setTimeout(r, 300));
    await req("POST", "/api/conversations/" + c.id + "/messages", JSON.stringify({ text: msg }));
    const t0 = Date.now();
    while (!idle && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 400));
    sse.destroy();
    const fin = JSON.parse((await req("GET", "/api/conversations/" + c.id)).body).conversation;
    resolve({ spoke: Array.from(spoke), systemMsg, agentMsgCount: fin.messages.filter((m) => m.authorType === "agent").length });
  });
}
(async () => {
  console.log("\n[S1] @lit single mention -- expect ONLY literature_researcher");
  const s1 = await scenario("routing-lit", ["coordinator", "literature_researcher", "code_researcher"], "@lit 用两句话简述光纤传感器原理", 40000);
  console.log("  spoke agents: [" + s1.spoke.join(", ") + "]");
  console.log("  agent msg count: " + s1.agentMsgCount);
  const pass1 = s1.spoke.length === 1 && s1.spoke[0] === "literature_researcher";
  console.log(pass1 ? "  PASS only lit replied" : "  FAIL");

  console.log("\n[S2] no @ -- expect system hint, no agent auto-reply");
  const s2 = await scenario("routing-none", ["coordinator", "literature_researcher"], "讲讲自供电传感器", 6000);
  console.log("  spoke agents: [" + s2.spoke.join(", ") + "]");
  console.log("  system hint: " + (s2.systemMsg ? "YES" : "NO"));
  const pass2 = s2.spoke.length === 0 && !!s2.systemMsg;
  console.log(pass2 ? "  PASS no auto-reply + system hint" : "  FAIL");

  const allPass = pass1 && pass2;
  console.log("\n=== " + (allPass ? "ALL PASS" : "SOME FAIL") + " ===");
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
