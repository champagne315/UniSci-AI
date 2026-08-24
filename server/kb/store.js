"use strict";

// 本地 SQLite 知识库存储。每个 KB 与其文档、切块、向量序列化为一条本地记录，按 ownerId 隔离。
const { DatabaseSync } = require("node:sqlite");
const config = require("../config");
const { uid } = require("../store");
const { embed, cosine } = require("./embed");
const { semanticEmbedder, cosineDense } = require("./semantic");

function newKB({ name, description, ownerId }) {
  return { id: uid("kb"), ownerId: ownerId || "", name: name || "未命名知识库", description: description || "", docs: [], createdAt: Date.now() };
}

class KBStore {
  constructor(options = {}) {
    this.kbs = new Map();
    this.semanticEmbedder = options.semanticEmbedder || semanticEmbedder;
    this.db = new DatabaseSync(config.databaseFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kbs_owner ON knowledge_bases(owner_id, created_at DESC);
    `);
    for (const row of this.db.prepare("SELECT payload FROM knowledge_bases").all()) {
      try { this._attach(JSON.parse(row.payload)); } catch (_) { /* 忽略损坏旧记录 */ }
    }
  }
  _attach(kb) {
    kb.docs = Array.isArray(kb.docs) ? kb.docs : [];
    Object.defineProperty(kb, "_store", { value: this, enumerable: false, configurable: true });
    this.kbs.set(kb.id, kb); return kb;
  }
  persist(kb) {
    if (!kb || !kb.id || !kb.ownerId) return;
    this.db.prepare(`INSERT INTO knowledge_bases (id, owner_id, created_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, created_at = excluded.created_at, payload = excluded.payload`)
      .run(kb.id, kb.ownerId, kb.createdAt || Date.now(), JSON.stringify(kb));
  }
  create(opts) { const kb = this._attach(newKB(opts)); this.persist(kb); return kb; }
  get(id, ownerId) { const kb = this.kbs.get(id); return kb && (!ownerId || kb.ownerId === ownerId) ? kb : null; }
  all(ownerId) { return Array.from(this.kbs.values()).filter((kb) => !ownerId || kb.ownerId === ownerId); }
  delete(id, ownerId) {
    const kb = this.get(id, ownerId); if (!kb) return false;
    this.kbs.delete(id); this.db.prepare("DELETE FROM knowledge_bases WHERE id = ? AND owner_id = ?").run(id, kb.ownerId); return true;
  }
  status(ownerId) {
    let chunkCount = 0; let semanticChunkCount = 0;
    for (const kb of this.all(ownerId)) for (const doc of kb.docs) { chunkCount += doc.chunks.length; semanticChunkCount += doc.chunks.filter((item) => Array.isArray(item.semanticVec)).length; }
    return { ...this.semanticEmbedder.status(), mode: this.semanticEmbedder.enabled ? "hybrid" : "lexical-fallback", chunkCount, semanticChunkCount };
  }
  async retrieve(query, kbIds, topK = 4, ownerId) {
    if (!query || !kbIds || !kbIds.length) return [];
    const lexicalQuery = embed(query); const candidates = [];
    for (const kbId of kbIds) {
      const kb = this.get(kbId, ownerId); if (!kb) continue;
      for (const doc of kb.docs) for (const chunk of doc.chunks) candidates.push({ kb, doc, chunk });
    }
    if (!candidates.length) return [];
    const canUseSemantic = this.semanticEmbedder.enabled && candidates.some(({ chunk }) => Array.isArray(chunk.semanticVec));
    let semanticQuery = null;
    if (canUseSemantic) { try { semanticQuery = await this.semanticEmbedder.embedQuery(query); } catch (error) { console.warn("[rag] 查询语义向量失败，已回退词法检索：", error.message); } }
    const semanticWeight = config.semanticWeight;
    const scored = candidates.map(({ kb, doc, chunk }) => {
      const lexicalScore = cosine(lexicalQuery, chunk.vec); const hasSemantic = semanticQuery && Array.isArray(chunk.semanticVec);
      const semanticScore = hasSemantic ? Math.max(0, cosineDense(semanticQuery, chunk.semanticVec)) : 0;
      const score = hasSemantic ? semanticScore * semanticWeight + lexicalScore * (1 - semanticWeight) : lexicalScore;
      return { id: chunk.id, text: chunk.text, docId: chunk.docId, source: doc.source, kbId: kb.id, kbName: kb.name, score, semanticScore, lexicalScore, matchType: hasSemantic ? (lexicalScore > 0.001 ? "hybrid" : "semantic") : "lexical", semanticModel: hasSemantic ? chunk.semanticModel : null };
    }).filter((hit) => hit.score > (semanticQuery ? 0.05 : 0.001));
    scored.sort((a, b) => b.score - a.score); return scored.slice(0, Math.max(1, Number(topK) || 4));
  }
}
module.exports = { KBStore, newKB };
