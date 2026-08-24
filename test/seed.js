"use strict";
// 建一个有内容的会话，供截图/UI验证
const http = require("http");
const B = process.env.BASE_URL || process.argv[2] || "http://127.0.0.1:3000";
function req(m, p, b) {
  return new Promise((res, rej) => {
    const r = http.request(B + p, { method: m, headers: b ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) } : {} }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => res({ st: x.statusCode, body: s })); });
    r.on("error", rej); if (b) r.write(b); r.end();
  });
}
(async () => {
  const c = await req("POST", "/api/conversations", JSON.stringify({ title: "自供电传感器系统调研", memberAgentIds: ["coordinator", "literature_researcher", "code_researcher", "circuit_researcher", "mechanical_researcher"] }));
  const conv = JSON.parse(c.body).conversation;
  console.log("conv:", conv.id);
  await req("POST", "/api/conversations/" + conv.id + "/messages", JSON.stringify({ text: "@lead 我们要做一个自供电传感器系统，请协调大家分工" }));
  console.log("sent, waiting for agents...");
  await new Promise((r) => setTimeout(r, 6000));
  const fin = JSON.parse((await req("GET", "/api/conversations/" + conv.id)).body).conversation;
  console.log("messages:", fin.messages.length);
})().catch((e) => console.error("ERR", e));
