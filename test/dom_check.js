"use strict";
// 用 Chrome DevTools Protocol（CDP）远程验证前端：启动 headless Chrome -> 打开页 -> 等初始化 -> 点击会话 -> 收集 console + DOM 摘要。
// 零依赖：手写 CDP over WebSocket。
const { spawn } = require("child_process");
const http = require("http");
const WebSocket = require ? null : null; // 占位；下面用 net 手写最小 WS 客户端

// CDP 需要 WebSocket。Node 没内置 WS 客户端，但我们可用 chrome --dump-dom + --virtual-time-budget 做轻量验证。
// 这里走轻量路线：用 --virtual-time-budget 让 JS 跑一段时间后 dump-dom。
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = process.env.BASE_URL || "http://127.0.0.1:3992/";

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err }));
    setTimeout(() => { try { p.kill(); } catch (e) {} }, 20000);
  });
}

(async () => {
  // dump-dom：让页面跑 6 秒（virtual-time-budget）后输出 DOM
  const r = await run([
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--virtual-time-budget=6000",
    "--window-size=1440,900",
    "--dump-dom",
    URL,
  ]);
  const dom = r.out;
  // 检查关键元素
  const checks = [
    ["modeBadge 有内容", /id="modeBadge"[^>]*>\s*\S/],
    ["Agent 名册有项", /class="agent-item"/],
    ["会话列表有项", /class="conv-item"/],
    ["chat-title 有内容", /id="chatTitle"[^>]*>[^<]+/],
  ];
  let pass = 0;
  for (const [name, re] of checks) {
    const ok = re.test(dom);
    console.log((ok ? "PASS " : "FAIL ") + name);
    if (ok) pass++;
  }
  console.log("DOM 长度:", dom.length, "| 通过", pass + "/" + checks.length);
  if (r.err) console.log("stderr(前200):", r.err.slice(0, 200));
})().catch((e) => { console.error("ERR", e); process.exit(1); });
(async () => {
  // dump-dom：让页面跑 8 秒（virtual-time-budget）后输出 DOM
  const r = await run([
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--virtual-time-budget=8000",
    "--run-all-compositor-stages-before-draw",
    "--window-size=1440,900",
    "--dump-dom",
    URL,
  ]);
  const dom = r.out;
  require("fs").writeFileSync(require("path").join(__dirname, "..", "data", "dom_dump.html"), dom);
  const checks = [
    ["modeBadge 有内容", /id="modeBadge"[^>]*>\s*[^<\s]/],
    ["Agent 名册有项", /class="agent-item"/],
    ["会话列表有项", /class="conv-item"/],
    ["chat 容器存在", /id="chat"/],
    ["brand 存在", /brand-mark/],
    ["含Agent名(文献研究员)", /文献研究员/],
  ];
  let pass = 0;
  for (const [name, re] of checks) {
    const ok = re.test(dom);
    console.log((ok ? "PASS " : "FAIL ") + name);
    if (ok) pass++;
  }
  console.log("DOM 长度:", dom.length, "| 通过", pass + "/" + checks.length);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
