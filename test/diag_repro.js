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
function flat(s) { return String(s||"").split("\n").join(" "); }
(async () => {
  var c1 = await req("POST", "/api/conversations", { title: "repro", memberAgentIds: ["coordinator","literature_researcher","code_researcher","circuit_researcher","mechanical_researcher"], autoRoute: false });
  var conv = JSON.parse(c1.body).conversation;
  console.log("conv:", conv.id);
  await req("POST", "/api/conversations/" + conv.id + "/messages", { text: "@code 找一下电路研究员" });
  console.log("sent: @code 找一下电路研究员");
  for (var i = 0; i < 45; i++) {
    await sleep(1000);
    var fin = JSON.parse((await req("GET", "/api/conversations/" + conv.id)).body).conversation;
    var agentMsgs = fin.messages.filter(function(m){ return m.authorType === "agent"; });
    if (fin.status === "idle" && i > 2) {
      console.log("idle at t=" + (i+1) + "s");
      fin.messages.forEach(function(m){ console.log("  [" + m.authorType + "/" + m.authorName + "] " + flat(m.content).slice(0, 120)); });
      var circuit = agentMsgs.find(function(m){ return m.author === "circuit_researcher"; });
      if (circuit) {
        var startsWithBracket = /^\[/.test(circuit.content);
        var mentionsCode = circuit.content.indexOf("代码研究员") >= 0 && circuit.content.indexOf("我是负责算法") >= 0;
        console.log("\ncircuit replied: YES");
        console.log("circuit starts with [prefix]: " + startsWithBracket);
        console.log("circuit identity-confused (talks like code): " + mentionsCode);
        console.log(startsWithBracket || mentionsCode ? "FAIL: circuit identity confused" : "PASS: circuit speaks as circuit");
      } else {
        console.log("\ncircuit did NOT reply (chain not triggered)");
      }
      break;
    }
  }
})().catch(function(e){ console.error("ERR", e); process.exit(1); });