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
  var c1 = await req("POST", "/api/conversations", { title: "sse", memberAgentIds: ["coordinator","literature_researcher","code_researcher","circuit_researcher","mechanical_researcher"], autoRoute: false });
  var conv = JSON.parse(c1.body).conversation;
  console.log("conv:", conv.id);
  var types = [];
  var sse = http.get(B + "/api/conversations/" + conv.id + "/stream", function(res) {
    res.setEncoding("utf8"); var buf = "";
    res.on("data", function(ch) {
      buf += ch; var i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        var e = buf.slice(0, i); buf = buf.slice(i + 2);
        var ln = e.split("\n").find(function(l){ return l.startsWith("data:"); });
        if (!ln) continue;
        try { var j = JSON.parse(ln.slice(5).trim());
          if (j.type === "agent_start") { types.push("START:" + j.agentId); console.log("  EVT start " + j.agentId + " name=" + j.agentName); }
          else if (j.type === "agent_end") { types.push("END:" + j.agentId); console.log("  EVT end " + j.agentId + " mentions=" + ((j.message&&j.message.mentions)||[]).join(",")); }
          else if (j.type === "status") { types.push("STATUS:" + j.status); console.log("  EVT status " + j.status); }
          else if (j.type === "message") { types.push("MSG:" + j.message.authorType); console.log("  EVT msg " + j.message.authorType); }
          else if (j.type !== "agent_token" && j.type !== "agent_reasoning" && j.type !== "snapshot") { types.push(j.type); console.log("  EVT " + j.type); }
        } catch (err) {}
      }
    });
  });
  await sleep(400);
  await req("POST", "/api/conversations/" + conv.id + "/messages", { text: "@lit 概述光纤传感器，然后 @code 写采集脚本" });
  await sleep(30000);
  sse.destroy();
  console.log("event sequence:", JSON.stringify(types));
})().catch(function(e){ console.error("ERR", e); process.exit(1); });