"use strict";

const assert = require("assert");
const { SemanticEmbedder } = require("../server/kb/semantic");
const { buildDocument } = require("../server/kb/ingest");
const { KBStore } = require("../server/kb/store");

const semanticMap = {
  "汽车依靠汽油驱动发动机产生动力。": [1, 0, 0],
  "香蕉和苹果都属于常见水果。": [0, 1, 0],
  "如何给机动车补充燃料？": [1, 0, 0],
};

const fakeFetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  const input = Array.isArray(body.input) ? body.input : [body.input];
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: input.map((text, index) => ({ index, embedding: semanticMap[text] || [0, 0, 1] })) }),
  };
};

(async () => {
  const embedder = new SemanticEmbedder({
    apiKey: "test-key",
    baseUrl: "https://embedding.test/v1",
    model: "test-semantic-model",
    fetchImpl: fakeFetch,
  });
  const kbStore = new KBStore({ semanticEmbedder: embedder });
  const kb = kbStore.create({ name: "语义测试库" });

  kb.docs.push(await buildDocument("交通.md", "汽车依靠汽油驱动发动机产生动力。", embedder));
  kb.docs.push(await buildDocument("水果.md", "香蕉和苹果都属于常见水果。", embedder));

  const hits = await kbStore.retrieve("如何给机动车补充燃料？", [kb.id], 2);
  assert(hits.length >= 1);
  assert.strictEqual(hits[0].source, "交通.md");
  assert.strictEqual(hits[0].matchType, "semantic");
  assert(hits[0].semanticScore > 0.99);
  assert.strictEqual(kbStore.status().semanticChunkCount, 2);

  console.log("PASS 语义向量入库与混合检索");
})().catch((error) => {
  console.error("FAIL", error);
  process.exitCode = 1;
});
