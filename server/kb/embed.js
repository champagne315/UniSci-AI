"use strict";

// 本地嵌入（零依赖）：
// 中文按字符 bigram + 英文按词，合并成 bag-of-features 向量（TF 加权）。
// 做不到语义，但"上传文档→检索→引用"链路完全跑得通，
// 真模式（有 OPENAI_API_KEY）下 retrieve 会优先用 OpenAI embedding。

const TOKEN_RE = /[a-zA-Z0-9]+/g;

function features(text) {
  const feats = new Map();
  // 英文/数字词
  const words = text.toLowerCase().match(TOKEN_RE) || [];
  for (const w of words) {
    if (w.length > 20) continue;
    feats.set(w, (feats.get(w) || 0) + 1);
  }
  // 中文 bigram（按字符滑窗，跳过空白标点）
  const chars = (text.match(/[\u4e00-\u9fa5]/g) || []).join("");
  for (let i = 0; i < chars.length - 1; i++) {
    const bg = chars.slice(i, i + 2);
    feats.set(bg, (feats.get(bg) || 0) + 1);
  }
  return feats;
}

// 把 feature map 归一化成单位向量（L2）以便余弦=点积
function normalize(feats) {
  let norm = 0;
  for (const v of feats.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const out = new Map();
  for (const [k, v] of feats) out.set(k, v / norm);
  return out;
}

function embed(text) {
  return normalize(features(text));
}

function cosine(a, b) {
  // a, b 都是归一化后的 Map<feature, weight>
  let dot = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w) dot += v * w;
  }
  return dot;
}

module.exports = { embed, cosine, features, normalize };
