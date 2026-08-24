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
  var c1 = await req("POST", "/api/conversations", { title: "appr", memberAgentIds: ["coordinator","literature_researcher","code_researcher","circuit_researcher","mechanical_researcher"], autoRoute: false });
  var conv = JSON.parse(c1.body).conversation;
  console.log("conv:", conv.id);
  // 让 code 执行一个有风险的操作，期望触发审批
  await req("POST", "/api/conversations/" + conv.id + "/messages", { text: "@code 帮我跑一下销毁测试数据的清理脚本" });
  console.log("sent risky task");
  var approvalFound = false;
  for (var i = 0; i < 40; i++) {
    await sleep(1000);
    var fin = JSON.parse((await req("GET", "/api/conversations/" + conv.id)).body).conversation;
    if (fin.pendingApproval) {
      approvalFound = true;
      console.log("approval found at t=" + (i+1) + "s: " + fin.pendingApproval.prompt);
      console.log("clicking APPROVE...");
      await req("POST", "/api/conversations/" + conv.id + "/approval", { approvalId: fin.pendingApproval.id, approved: true, note: "继续" });
      break;
    }
    if (fin.status === "idle" && i > 3) {
      console.log("went idle without approval at t=" + (i+1) + "s");
      fin.messages.forEach(function(m){ console.log("  [" + m.authorType + "/" + m.authorName + "] " + flat(m.content).slice(0, 100)); });
      break;
    }
  }
  if (approvalFound) {
    // 等审批后恢复
    for (var j = 0; j < 20; j++) {
      await sleep(1000);
      var fin2 = JSON.parse((await req("GET", "/api/conversations/" + conv.id)).body).conversation;
      if (fin2.status === "idle" && j > 1) {
        console.log("recovered to idle at t=" + (j+1) + "s after approve");
        console.log("messages after approval: " + fin2.messages.length);
        fin2.messages.forEach(function(m){ console.log("  [" + m.authorType + "/" + m.authorName + "] " + flat(m.content).slice(0, 100)); });
        console.log("PASS: approval click worked");
        break;
      }
    }
  } else {
    console.log("INFO: no approval triggered (agent chose not to)");
  }
})().catch(function(e){ console.error("ERR", e); process.exit(1); });