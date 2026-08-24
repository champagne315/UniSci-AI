"use strict";
// 最小 DeepSeek API 连通性测试：验证 key + 模型名。
const BASE = process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "deepseek-v4-flash";
(async () => {
  if (!KEY) { console.log("SKIP: 无 API key"); process.exit(0); }
  console.log("base:", BASE, "| model:", MODEL, "| key len:", KEY.length);
  try {
    const r = await fetch(BASE.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "回复一个字：好" }], max_tokens: 16 }),
    });
    console.log("status:", r.status);
    const txt = await r.text();
    console.log("body(前400):", txt.slice(0, 400));
    if (r.ok) console.log("PASS API 连通");
    else console.log("FAIL API 返回非200");
  } catch (e) {
    console.log("NET ERR:", e.message);
  }
})();
