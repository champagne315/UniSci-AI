"use strict";

// 所有用户共享同一份 ARC 固定资料切片：首个账户负责从源目录构建，后续账户即时克隆，避免重复解析大文件。
const fs = require("fs");
const path = require("path");
const config = require("../config");
const kbStore = require("./storeInstance");
const { ingestFile, TEXT_EXT, DOC_EXT, IMAGE_EXT } = require("./ingest");

const DEFAULT_KB_SPECS = [
  { key: "arc-code", name: "ARC代码知识库", directory: "代码篇", description: "ARC 代码、控制与嵌入式开发资料。" },
  { key: "arc-circuit", name: "ARC电路知识库", directory: "电路篇", description: "ARC 电路、PCB 与电子设计资料。" },
  { key: "arc-mechanism", name: "ARC机构知识库", directory: "机构篇", description: "ARC 机构、底盘与机械设计资料。" },
];
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXT, ...DOC_EXT, ...IMAGE_EXT]);
const LOCAL_LEXICAL_EMBEDDER = { enabled: false };
const runningUsers = new Map();
let seedQueue = Promise.resolve();

function listFiles(directory) {
  if (!fs.existsSync(directory)) throw new Error("固定知识库目录不存在：" + directory);
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(filePath));
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(filePath);
  }
  return output.sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function getOrCreateDefaultKb(userId, spec) {
  let kb = kbStore.all(userId).find((item) => item.defaultKey === spec.key);
  if (!kb) kb = kbStore.all(userId).find((item) => item.name === spec.name);
  if (!kb) kb = kbStore.create({ name: spec.name, description: spec.description, ownerId: userId });
  let changed = false;
  if (kb.defaultKey !== spec.key) { kb.defaultKey = spec.key; changed = true; }
  if (kb.defaultSourceDirectory !== spec.directory) { kb.defaultSourceDirectory = spec.directory; changed = true; }
  if (!kb.defaultSeedStatus) { kb.defaultSeedStatus = "pending"; changed = true; }
  if (changed) kbStore.persist(kb);
  return kb;
}

function ensureDefaultKnowledgeBases(userId) {
  if (!userId) return [];
  return DEFAULT_KB_SPECS.map((spec) => getOrCreateDefaultKb(userId, spec));
}

function cloneDocuments(docs) {
  return typeof structuredClone === "function" ? structuredClone(docs) : JSON.parse(JSON.stringify(docs));
}

function findDonor(spec, ignoredKbId) {
  return kbStore.all()
    .filter((kb) => kb.id !== ignoredKbId && kb.defaultKey === spec.key && Array.isArray(kb.docs) && kb.docs.length)
    .sort((left, right) => right.docs.length - left.docs.length)[0] || null;
}

// 历史用户和新用户均优先从已有的完整 ARC 库克隆切片，登录后可立即看到资料而不是等待长队列。
function hydrateDefaultKnowledgeBases(userId) {
  const kbs = ensureDefaultKnowledgeBases(userId);
  for (let index = 0; index < DEFAULT_KB_SPECS.length; index++) {
    const kb = kbs[index];
    const donor = findDonor(DEFAULT_KB_SPECS[index], kb.id);
    // 早期后台导入留下的半成品库也用完整供体补齐，确保用户首次打开即看到完整切片。
    if (!donor || donor.docs.length <= kb.docs.length) continue;
    kb.docs = cloneDocuments(donor.docs);
    kb.defaultSeedStatus = donor.defaultSeedStatus === "ready" ? "ready" : "partial";
    kb.defaultSeedError = donor.defaultSeedError || null;
    kb.defaultSeedFiles = { ...(donor.defaultSeedFiles || {}), cloned: true };
    kbStore.persist(kb);
  }
  return kbs;
}

async function seedDefaultKnowledgeBases(userId) {
  const kbs = ensureDefaultKnowledgeBases(userId);
  for (let index = 0; index < DEFAULT_KB_SPECS.length; index++) {
    const spec = DEFAULT_KB_SPECS[index];
    const kb = kbs[index];
    const sourceDirectory = path.join(config.defaultKnowledgeBaseRoot, spec.directory);
    try {
      const files = listFiles(sourceDirectory);
      const processed = new Set(kb.docs.map((doc) => doc.defaultSourceKey).filter(Boolean));
      const failures = [];
      kb.defaultSeedStatus = "indexing";
      kb.defaultSeedError = null;
      kb.defaultSeedFiles = { total: files.length, completed: processed.size, failed: 0 };
      kbStore.persist(kb);

      for (const filePath of files) {
        const sourceKey = path.relative(sourceDirectory, filePath).replace(/\\/g, "/");
        if (processed.has(sourceKey)) continue;
        try {
          const doc = await ingestFile(kb, filePath, sourceKey, LOCAL_LEXICAL_EMBEDDER);
          doc.defaultSourceKey = sourceKey;
          doc.defaultSourcePath = path.relative(config.defaultKnowledgeBaseRoot, filePath).replace(/\\/g, "/");
          processed.add(sourceKey);
        } catch (error) {
          failures.push(sourceKey + "：" + error.message);
          console.warn("[default-kb] 入库失败：", userId, spec.name, sourceKey, error.message);
        }
        kb.defaultSeedFiles = { total: files.length, completed: processed.size, failed: failures.length };
        kbStore.persist(kb);
      }

      kb.defaultSeedStatus = failures.length ? "partial" : "ready";
      kb.defaultSeedError = failures.length ? failures.join("\n") : null;
      kb.defaultSeedFiles = { total: files.length, completed: processed.size, failed: failures.length };
      kbStore.persist(kb);
    } catch (error) {
      kb.defaultSeedStatus = "failed";
      kb.defaultSeedError = error.message;
      kbStore.persist(kb);
      console.error("[default-kb] 初始化失败：", userId, spec.name, error.message);
    }
  }
}

function scheduleDefaultKnowledgeBases(userId) {
  const kbs = hydrateDefaultKnowledgeBases(userId);
  if (!userId || runningUsers.has(userId) || kbs.every((kb) => kb.docs.length)) return kbs;
  const work = seedQueue
    .then(() => seedDefaultKnowledgeBases(userId))
    .catch((error) => console.error("[default-kb] 用户初始化异常：", userId, error.message))
    .finally(() => runningUsers.delete(userId));
  seedQueue = work.catch(() => {});
  runningUsers.set(userId, work);
  return kbs;
}

function scheduleForUsers(users) {
  // 先即时克隆已有切片；仅在没有任何可用供体的全新部署中排队解析一次源资料。
  for (const user of users || []) scheduleDefaultKnowledgeBases(user && user.id ? user.id : user);
}

module.exports = { DEFAULT_KB_SPECS, ensureDefaultKnowledgeBases, hydrateDefaultKnowledgeBases, scheduleDefaultKnowledgeBases, scheduleForUsers, seedDefaultKnowledgeBases, listFiles };
