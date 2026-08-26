"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
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

function removeDatabase(databaseFile) {
  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(databaseFile + suffix, { force: true });
}

(async () => {
  const databaseFile = path.join(os.tmpdir(), "unisci-kb-test-" + process.pid + ".sqlite");
  removeDatabase(databaseFile);
  const embedder = new SemanticEmbedder({
    apiKey: "test-key",
    baseUrl: "https://embedding.test/v1",
    model: "test-semantic-model",
    fetchImpl: fakeFetch,
  });

  try {
    const kbStore = new KBStore({ semanticEmbedder: embedder, databaseFile });
    const kb = kbStore.create({ name: "语义测试库", ownerId: "test-user" });
    kb.docs.push(await buildDocument("交通.md", "汽车依靠汽油驱动发动机产生动力。", embedder));
    kb.docs.push(await buildDocument("水果.md", "香蕉和苹果都属于常见水果。", embedder));
    kbStore.persist(kb);

    const hits = await kbStore.retrieve("如何给机动车补充燃料？", [kb.id], 2, "test-user");
    assert(hits.length >= 1);
    assert.strictEqual(hits[0].source, "交通.md");
    assert.strictEqual(hits[0].matchType, "semantic");
    assert(hits[0].semanticScore > 0.99);
    assert.strictEqual(kbStore.status("test-user").semanticChunkCount, 2);
    kbStore.db.close();

    const reloaded = new KBStore({ semanticEmbedder: embedder, databaseFile });
    const reloadedHits = await reloaded.retrieve("如何给机动车补充燃料？", [kb.id], 2, "test-user");
    assert(reloadedHits.length >= 1);
    assert.strictEqual(reloadedHits[0].source, "交通.md");

    // 模拟旧版本把 Map 序列化为 {} 的历史数据，验证启动时会自动重建并迁移。
    const legacyRow = reloaded.db.prepare("SELECT payload FROM knowledge_bases WHERE id = ?").get(kb.id);
    const legacyPayload = JSON.parse(legacyRow.payload);
    for (const doc of legacyPayload.docs) for (const chunk of doc.chunks) chunk.vec = {};
    reloaded.db.prepare("UPDATE knowledge_bases SET payload = ? WHERE id = ?").run(JSON.stringify(legacyPayload), kb.id);
    reloaded.db.close();

    const migrated = new KBStore({ semanticEmbedder: embedder, databaseFile });
    const migratedHits = await migrated.retrieve("如何给机动车补充燃料？", [kb.id], 2, "test-user");
    assert(migratedHits.length >= 1);
    assert(migrated.get(kb.id, "test-user").docs[0].chunks[0].vec instanceof Map);
    const migratedRow = migrated.db.prepare("SELECT payload FROM knowledge_bases WHERE id = ?").get(kb.id);
    assert(migratedRow.payload.includes("__unisciMap"));
    migrated.db.close();

    console.log("PASS 语义向量、持久化重载与旧数据迁移");
  } finally {
    removeDatabase(databaseFile);
  }
})().catch((error) => {
  console.error("FAIL", error);
  process.exitCode = 1;
});
