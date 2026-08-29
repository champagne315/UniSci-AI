"use strict";

const path = require("path");
const { loadEnv } = require("./env");

loadEnv();
const ROOT = path.resolve(__dirname, "..");

const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 8080,
  host: process.env.HOST || "0.0.0.0",

  root: ROOT,
  webDir: path.join(ROOT, "web"),
  dataDir: path.join(ROOT, "data"),
  databaseFile: path.join(ROOT, "data", "research-workbench.sqlite"),
  uploadDir: path.join(ROOT, "data", "uploads"),
  avatarUploadDir: path.join(ROOT, "data", "uploads", "avatars"),
  chatUploadDir: path.join(ROOT, "data", "uploads", "chat"),
  maxChatAttachmentBytes: 10 * 1024 * 1024,
  maxChatAttachments: 5,
  maxChatAttachmentsTotalBytes: 50 * 1024 * 1024,
  templatesDir: path.join(ROOT, "server", "agents", "builtin"),
  customTemplatesDir: path.join(ROOT, "data", "agents"),
  skillsDir: path.join(ROOT, "server", "skills", "builtin"),
  customSkillsDir: path.join(ROOT, "data", "skills"),
  workspaceDir: process.env.AGENT_WORKSPACE_DIR || path.join(ROOT, "data", "workspaces"),
  // 所有账户自动获得的 ARC 知识库来源目录；可用环境变量覆盖以适配部署目录。
  defaultKnowledgeBaseRoot: process.env.DEFAULT_KB_ROOT || path.join(ROOT, "default-knowledge-base"),

  // LLM 配置：默认 DeepSeek（真实 API）。无 key 时回退本地 mock 仅用于离线冒烟。
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1",
  model: process.env.OPENAI_MODEL || "deepseek-v4-flash",

  // 语义检索使用独立的 OpenAI 兼容 Embedding 端点。
  // 显式配置 key 后启用；未配置时自动回退到本地词法检索，不影响上传和问答。
  embeddingApiKey: process.env.OPENAI_EMBEDDING_API_KEY || "",
  embeddingBaseUrl: process.env.OPENAI_EMBEDDING_BASE_URL || "https://api.openai.com/v1",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  embeddingDimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS || 0) || undefined,
  embeddingBatchSize: Math.max(1, Number(process.env.EMBEDDING_BATCH_SIZE || 32)),
  embeddingTimeoutMs: Math.max(1000, Number(process.env.EMBEDDING_TIMEOUT_MS || 30000)),
  semanticWeight: Math.min(1, Math.max(0, Number(process.env.RAG_SEMANTIC_WEIGHT || 0.75))),

  // 图片 / 扫描件 OCR：智谱 GLM-OCR（layout_parsing 专用端点，非 OpenAI 兼容）。
  // 未配置 key 时，图片与无文字层的 PDF 会给出明确提示而非静默失败。
  glmOcrApiKey: process.env.GLM_OCR_API_KEY || "",
  glmOcrBaseUrl: process.env.GLM_OCR_BASE_URL || "https://open.bigmodel.cn/api/paas/v4/layout_parsing",
  glmOcrModel: process.env.GLM_OCR_MODEL || "glm-ocr",
  glmOcrTimeoutMs: Math.max(5000, Number(process.env.GLM_OCR_TIMEOUT_MS || 60000)),

  // 离线冒烟开关：强制用本地 mock（仅用于无网络测试）
  forceMock: String(process.env.FORCE_MOCK || "").toLowerCase() === "true",

  // 群聊调度参数
  maxRounds: Number(process.env.MAX_ROUNDS || 8),
  historyWindow: Number(process.env.HISTORY_WINDOW || 12),
  maxToolSteps: Math.max(1, Math.min(12, Number(process.env.MAX_TOOL_STEPS || 6))),
  // 可选的 SearXNG/兼容 JSON 搜索端点；未配置时使用 DuckDuckGo HTML 搜索适配器。
  webSearchEndpoint: String(process.env.WEB_SEARCH_ENDPOINT || "").trim(),

  // Mock 流式节奏（毫秒/词）
  mockTypeDelayMs: Number(process.env.MOCK_TYPE_DELAY || 35),
  // 推理模型：是否把 reasoning_content 作为"思考过程"单独广播给前端
  showReasoning: String(process.env.SHOW_REASONING || "true").toLowerCase() !== "false",
};

// 仅在显式 forceMock 时走 mock；默认走真实 DeepSeek API
config.isMock = config.forceMock;

module.exports = config;
