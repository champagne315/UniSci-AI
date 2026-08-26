"use strict";

// 文档解析 + 切块：
// 纯文本（.txt .md .json .csv 及常见代码文件）直接读取；
// PDF 用 pdf-parse、Word(.docx) 用 mammoth 提取文本；
// 图片与无文字层的扫描版 PDF 用智谱 GLM-OCR 识别为 Markdown，统一进入同一套切块/索引流程。

const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { embed } = require("./embed");
const { semanticEmbedder } = require("./semantic");
const config = require("../config");
const { uid } = require("../store");

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log",
  ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".c", ".cpp", ".h",
  ".go", ".rs", ".rb", ".sh", ".yaml", ".yml", ".xml", ".html", ".tex",
]);

// 二进制文档解析器（懒加载，缺依赖时给出可读提示而非崩溃）
const DOC_EXT = new Set([".pdf", ".docx"]);

// 图片格式（走 GLM-OCR）
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".bmp": "image/bmp", ".gif": "image/gif",
};

function tryRequire(name) {
  try { return require(name); } catch (_) { return null; }
}

async function extractPdfText(filePath) {
  const pdfParse = tryRequire("pdf-parse");
  if (!pdfParse) throw new Error("缺少 pdf-parse 依赖，无法解析 PDF（请运行 npm install pdf-parse）");
  const data = fs.readFileSync(filePath);
  const result = await pdfParse(data);
  return String((result && result.text) || "");
}

async function extractDocxText(filePath) {
  const mammoth = tryRequire("mammoth");
  if (!mammoth) throw new Error("缺少 mammoth 依赖，无法解析 Word（请运行 npm install mammoth）");
  const result = await mammoth.extractRawText({ path: filePath });
  return String((result && result.value) || "");
}

// 用智谱 GLM-OCR 识别图片 / PDF 为 Markdown 文本（data URL 传文件）
async function extractOcrDataUrl(dataUrl, timeoutMs = config.glmOcrTimeoutMs) {
  if (!config.glmOcrApiKey) {
    throw new Error("未配置 GLM_OCR_API_KEY，无法识别图片（请在 .env 中填写智谱 API key）");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(config.glmOcrBaseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.glmOcrApiKey },
      body: JSON.stringify({ model: config.glmOcrModel, file: dataUrl }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error("GLM-OCR 请求失败：" + (e.name === "AbortError" ? "超时" : e.message));
  }
  clearTimeout(timer);

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.message) ? body.error.message : JSON.stringify(body);
    throw new Error("GLM-OCR 识别失败：" + msg);
  }
  return String(body.md_results || "");
}

async function extractImageText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = IMAGE_MIME[ext] || "application/pdf";
  const dataUrl = "data:" + mime + ";base64," + fs.readFileSync(filePath).toString("base64");
  return extractOcrDataUrl(dataUrl);
}

// GLM-OCR 单次仅支持 50MB / 100 页以内的 PDF；扫描书籍会按页拆分后完整识别。
async function extractLargePdfText(filePath) {
  const source = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  const texts = [];
  for (let start = 0; start < pageCount;) {
    let end = Math.min(start + 90, pageCount);
    let bytes;
    while (end > start) {
      const segment = await PDFDocument.create();
      const pages = await segment.copyPages(source, Array.from({ length: end - start }, (_, index) => start + index));
      pages.forEach((page) => segment.addPage(page));
      bytes = await segment.save();
      if (bytes.length <= 48 * 1024 * 1024 || end === start + 1) break;
      end = start + Math.max(1, Math.floor((end - start) / 2));
    }
    if (!bytes || bytes.length > 50 * 1024 * 1024) throw new Error("PDF 第 " + (start + 1) + " 页单页仍超过 OCR 50MB 限制");
    const text = await extractOcrDataUrl(
      "data:application/pdf;base64," + Buffer.from(bytes).toString("base64"),
      Math.max(config.glmOcrTimeoutMs, 180000),
    );
    if (text.trim()) texts.push("<!-- PDF 第 " + (start + 1) + "–" + end + " 页 -->\n" + text);
    start = end;
  }
  return texts.join("\n\n");
}

function readText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TEXT_EXT.has(ext)) return null;
  return fs.readFileSync(filePath, "utf8");
}

// 统一入口：按扩展名分发到纯文本 / PDF / Word / 图片 OCR 提取，返回文本；不支持则返回 null
async function readFileText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXT.has(ext)) return readText(filePath);
  if (ext === ".docx") return extractDocxText(filePath);
  if (IMAGE_EXT.has(ext)) return extractImageText(filePath);
  if (ext === ".pdf") {
    // 超大 PDF 跳过 pdf-parse 和整文件 Base64，避免解析 50MB+ 扫描书籍时耗尽服务内存。
    const isLargePdf = fs.statSync(filePath).size > 48 * 1024 * 1024;
    if (isLargePdf) {
      const text = await extractLargePdfText(filePath);
      if (String(text).trim()) return text;
      throw new Error("分段 OCR 未提取到可识别的文字");
    }

    // 先尝试提取 PDF 文字层；扫描件再回退到 OCR，并保留两阶段的失败原因。
    let pdfError = null;
    try {
      const text = await extractPdfText(filePath);
      if (String(text).trim()) return text;
    } catch (error) {
      pdfError = error;
    }

    try {
      const text = await extractImageText(filePath);
      if (String(text).trim()) return text;
      throw new Error("OCR 未提取到可识别的文字");
    } catch (ocrError) {
      try {
        const text = await extractLargePdfText(filePath);
        if (String(text).trim()) return text;
        throw new Error("分段 OCR 未提取到可识别的文字");
      } catch (largePdfError) {
        const pdfReason = pdfError
          ? "PDF 文字层提取失败：" + pdfError.message
          : "PDF 未包含可提取的文字层";
        throw new Error(pdfReason + "；OCR 处理失败：" + ocrError.message + "；分段 OCR 处理失败：" + largePdfError.message);
      }
    }
  }
  return null;
}

// 按段落/固定窗口切块，overlap 一段，保证引用连续性
function chunk(text, size = 600, overlap = 80) {
  const clean = text.replace(/\r\n/g, "\n");
  const chunks = [];
  // 先按双换行切段落，再合并到目标大小
  const paras = clean.split(/\n{2,}/);
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > size && buf) {
      chunks.push(buf.trim());
      // overlap：保留尾部
      buf = buf.slice(-overlap) + "\n\n" + p;
    } else {
      buf = buf ? buf + "\n\n" + p : p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  // 兜底：若某段超长，硬切
  const out = [];
  for (const c of chunks) {
    if (c.length <= size * 1.5) { out.push(c); continue; }
    for (let i = 0; i < c.length; i += size) out.push(c.slice(i, i + size));
  }
  return out.filter(Boolean);
}

async function buildDocument(name, text, embedder = semanticEmbedder) {
  const pieces = chunk(text);
  if (!pieces.length) throw new Error("文档没有可入库的文本内容");

  const doc = {
    id: uid("doc"),
    name,
    source: name,
    fullText: String(text).replace(/\r\n/g, "\n"),
    charCount: String(text).length,
    chunks: pieces.map((piece) => ({
      id: uid("chunk"),
      text: piece,
      vec: embed(piece),
      docId: null,
      source: name,
    })),
    semanticStatus: embedder.enabled ? "indexing" : "disabled",
    semanticModel: embedder.enabled ? embedder.model : null,
    semanticError: null,
    createdAt: Date.now(),
  };
  doc.chunks.forEach((item) => { item.docId = doc.id; });

  if (embedder.enabled) {
    try {
      const vectors = await embedder.embedDocuments(pieces);
      doc.chunks.forEach((item, index) => {
        item.semanticVec = vectors[index];
        item.semanticModel = embedder.model;
      });
      doc.semanticStatus = "ready";
    } catch (error) {
      doc.semanticStatus = "fallback";
      doc.semanticError = error.message;
      console.warn("[rag] 语义向量生成失败，已回退词法索引：", error.message);
    }
  }

  return doc;
}

async function ingestFile(kb, filePath, originalName, embedder = semanticEmbedder) {
  const text = await readFileText(filePath);
  if (text == null) {
    throw new Error(`暂不支持该文件类型：${path.extname(filePath)}（支持纯文本、PDF、Word .docx、图片）`);
  }
  if (!String(text).trim()) {
    throw new Error("未能从该文件中提取到文本内容（图片中可能没有可识别的文字）");
  }
  const doc = await buildDocument(originalName || path.basename(filePath), text, embedder);
  kb.docs.push(doc);
  if (kb._store) kb._store.persist(kb);
  return doc;
}

// 直接喂文本（用于 UI 粘贴）
async function ingestText(kb, name, text) {
  const doc = await buildDocument(name || "粘贴文本", text);
  kb.docs.push(doc);
  if (kb._store) kb._store.persist(kb);
  return doc;
}

module.exports = { ingestFile, ingestText, buildDocument, chunk, readText, readFileText, extractImageText, TEXT_EXT, DOC_EXT, IMAGE_EXT };
