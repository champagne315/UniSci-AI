"use strict";

const config = require("../config");

function normalizeDense(values) {
  if (!Array.isArray(values) || !values.length) return null;
  let norm = 0;
  const out = values.map((value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error("Embedding 返回了无效向量");
    norm += n * n;
    return n;
  });
  norm = Math.sqrt(norm);
  if (!norm) throw new Error("Embedding 返回了零向量");
  return out.map((value) => value / norm);
}

function cosineDense(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return score;
}

class SemanticEmbedder {
  constructor(options = {}) {
    this.apiKey = options.apiKey !== undefined ? options.apiKey : config.embeddingApiKey;
    this.baseUrl = (options.baseUrl || config.embeddingBaseUrl || "").replace(/\/$/, "");
    this.model = options.model || config.embeddingModel;
    this.dimensions = options.dimensions !== undefined ? options.dimensions : config.embeddingDimensions;
    this.singleInput = options.singleInput !== undefined
      ? options.singleInput
      : /embedding-vision/i.test(this.model || "");
    this.batchSize = this.singleInput ? 1 : (options.batchSize || config.embeddingBatchSize);
    this.timeoutMs = options.timeoutMs || config.embeddingTimeoutMs;
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.lastError = null;
    this.dimension = null;
  }

  get enabled() {
    return Boolean(this.apiKey && this.baseUrl && this.model && this.fetchImpl);
  }

  status() {
    return {
      enabled: this.enabled,
      provider: this.baseUrl.includes("/api/plan/") ? "volcengine-agent-plan" : "openai-compatible",
      model: this.model || null,
      dimension: this.dimension,
      inputMode: this.singleInput ? "single" : "batch",
      lastError: this.lastError,
    };
  }

  async embedDocuments(texts) {
    return this._embed(texts);
  }

  async embedQuery(text) {
    const vectors = await this._embed([text]);
    return vectors[0];
  }

  async _embed(texts) {
    if (!this.enabled) throw new Error("未配置语义向量服务");
    const inputs = (texts || []).map((text) => String(text || "").trim());
    if (!inputs.length || inputs.some((text) => !text)) throw new Error("Embedding 输入不能为空");

    const all = [];
    for (let start = 0; start < inputs.length; start += this.batchSize) {
      const batch = inputs.slice(start, start + this.batchSize);
      const vectors = await this._requestBatch(batch);
      all.push(...vectors);
    }
    return all;
  }

  async _requestBatch(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const payload = {
      model: this.model,
      input: this.singleInput ? input[0] : input,
      encoding_format: "float",
    };
    if (this.dimensions) payload.dimensions = this.dimensions;

    try {
      const response = await this.fetchImpl(this.baseUrl + "/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body && body.error && body.error.message ? body.error.message : "HTTP " + response.status;
        throw new Error("语义向量请求失败：" + message);
      }
      const data = Array.isArray(body.data)
        ? body.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0))
        : (body.data && Array.isArray(body.data.embedding) ? [{ index: 0, embedding: body.data.embedding }] : []);
      if (data.length !== input.length) throw new Error("Embedding 返回数量与输入不一致");
      const vectors = data.map((item) => normalizeDense(item.embedding));
      const dimension = vectors[0] && vectors[0].length;
      if (!dimension || vectors.some((vector) => vector.length !== dimension)) throw new Error("Embedding 向量维度不一致");
      this.dimension = dimension;
      this.lastError = null;
      return vectors;
    } catch (error) {
      const message = error && error.name === "AbortError" ? "语义向量请求超时" : error.message;
      this.lastError = message;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }
}

const semanticEmbedder = new SemanticEmbedder();

module.exports = { SemanticEmbedder, semanticEmbedder, normalizeDense, cosineDense };
