"use strict";
const http = require("http");
const B = process.argv[2] || "http://127.0.0.1:8080";
function req(m, p, b) {
  return new Promise(function(res, rej) {
    var data = b ? JSON.stringify(b) : null;
    var r = http.request(B + p, { method: m, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, function(x) { var s = ""; x.on("data", function(c){ s += c; }); x.on("end", function(){ res({ st: x.statusCode, body: s }); }); });
    r.on("error", rej); if (data) r.write(data); r.end();
  });
}
function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
(async () => {
  var c1 = await req("POST", "/api/conversations", { title: "chain-http", memberAgentIds: ["coordinator","literature_researcher","code_researcher","circuit_researcher","mechanical_researcher"], autoRoute: false });
  var conv = JSON.parse(c1.body).conversation;
  console.log("conv:", conv.id);
  await req("POST", "/api/conversations/" + conv.id + "/messages", { text: "@lit 先概述光纤传感器，然后 @code 让它写个采集脚本骨架" });
  console.log("sent, waiting for chain...");
  var agentMsgs = 0;
  for (var i = 0; i < 40; i++) {
    await sleep(1000);
    var fin = JSON.parse((await req("GET", "/api/conversations/" + conv.id)).body).conversation;
    agentMsgs = fin.messages.filter(function(m){ return m.authorType === "agent"; }).length;
    if (fin.status === "idle" && i > 2) {
      console.log("idle at t=" + (i+1) + "s, agentMsgs=" + agentMsgs);
      fin.messages.forEach(function(m){ console.log("  [" + m.authorType + "/" + m.authorName + "] " + String(m.content||"").split("\n").join(" ").slice(0, 70)); });
      break;
    }
    if (i % 5 === 4) console.log("  t=" + (i+1) + "s status=" + fin.status + " agentMsgs=" + agentMsgs);
  }
  console.log(agentMsgs >= 2 ? "PASS HTTP chain (" + agentMsgs + " agents)" : "FAIL HTTP chain only " + agentMsgs + " agent");
})().catch(function(e){ console.error("ERR", e); process.exit(1); });