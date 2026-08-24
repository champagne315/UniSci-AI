"use strict";
// 验证 LangGraph.js 1.x + DeepSeek 用法：ChatOpenAI 连通、流式、reasoning_content 处理。
const { ChatOpenAI } = require("@langchain/openai");

(async () => {
  const llm = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "deepseek-v4-flash",
    configuration: { baseURL: process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1", apiKey: process.env.OPENAI_API_KEY },
    temperature: 0.6,
    streaming: true,
  });
  console.log("--- 非流式调用 ---");
  try {
    const r = await llm.invoke([{ role: "user", content: "用一句话说你是谁" }]);
    console.log("type:", r.constructor.name);
    console.log("content:", JSON.stringify(r.content).slice(0, 120));
    console.log("additional_kwargs:", JSON.stringify(r.additional_kwargs).slice(0, 200));
    console.log("lc_kwargs keys:", Object.keys(r.lc_kwargs || {}));
  } catch (e) { console.log("ERR:", e.message); }

  console.log("--- 流式调用 ---");
  try {
    let contentChars = 0, reasonChars = 0, chunkCount = 0;
    const stream = await llm.stream([{ role: "user", content: "说三个字" }]);
    for await (const c of stream) {
      chunkCount++;
      if (c.content) contentChars += String(c.content).length;
      // reasoning 是否出现在 chunk 的某个字段
      const ak = c.additional_kwargs || {};
      if (ak.reasoning_content) reasonChars += String(ak.reasoning_content).length;
      if (chunkCount <= 3) console.log("chunk", chunkCount, "content=", JSON.stringify(c.content).slice(0,30), "ak=", JSON.stringify(ak).slice(0,60));
    }
    console.log("总 chunks:", chunkCount, "| content chars:", contentChars, "| reasoning chars:", reasonChars);
  } catch (e) { console.log("STREAM ERR:", e.message); }
})();
