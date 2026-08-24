"use strict";
// KB 链路测试：建库 -> 入库 -> 检索
const http = require("http");
const B = process.env.BASE_URL || process.argv[2] || "http://127.0.0.1:3000";
function req(m, p, b, ct) {
  return new Promise((res, rej) => {
    const r = http.request(B + p, { method: m, headers: b ? { "Content-Type": ct || "application/json", "Content-Length": Buffer.byteLength(b) } : {} }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => res({ st: x.statusCode, body: s })); });
    r.on("error", rej); if (b) r.write(b); r.end();
  });
}
(async () => {
  const kb = await req("POST", "/api/kbs", JSON.stringify({ name: "测试KB" }));
  const kbId = JSON.parse(kb.body).kb.id;
  console.log("建KB:", kb.st, kbId);
  const txt = JSON.stringify({ text: "自供电传感器利用压电效应将机械能转为电能。摩擦纳米发电机TENG在2023年实现了突破性输出功率。文献综述显示该领域顶刊为Nature Energy。压电材料PZT是常用方案。", name: "粘贴.txt" });
  const ing = await req("POST", "/api/kbs/" + kbId + "/upload", txt);
  const ingested = JSON.parse(ing.body).saved[0];
  console.log("入库:", ing.st, ing.body.slice(0, 150));
  const detail = await req("GET", "/api/kbs/" + kbId + "/docs/" + ingested.id);
  const document = JSON.parse(detail.body).document;
  if (detail.st !== 200 || !document.fullText.includes("压电效应") || !document.chunks.length || "vec" in document.chunks[0]) {
    throw new Error("文档全文/Chunk 详情接口验证失败");
  }
  console.log("文档查看:", detail.st, "chars=" + document.charCount, "chunks=" + document.chunkCount);
  const sr = await req("POST", "/api/kbs/" + kbId + "/search", JSON.stringify({ query: "自供电传感器" }));
  const hits = JSON.parse(sr.body).hits;
  console.log("检索:", sr.st, "hits=" + hits.length);
  if (hits.length) console.log("top1 片段:", hits[0].text.slice(0, 50), "| 分数:", hits[0].score.toFixed(3));
  console.log(hits.length > 0 ? "PASS KB 检索" : "FAIL 无命中");
})().catch((e) => console.error("ERR", e));
