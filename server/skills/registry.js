"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { normalizeSkillEntries } = require("./zip-import");

const SKILL_FILE = "SKILL.md";
const MAX_BODY_CHARS = 30000;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".js", ".cjs", ".mjs", ".ts", ".py", ".sh", ".ps1", ".r", ".sql", ".csv"]);
const SKIP_NAMES = new Set([".git", "node_modules", ".env"]);
const STANDARD_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function stringList(value, limit = 24) {
  const values = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[,\s]+/) : []);
  return Array.from(new Set(values.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}
function yamlValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try { return text.startsWith('"') ? JSON.parse(text) : text.slice(1, -1).replace(/''/g, "'"); } catch (_) { return text.slice(1, -1); }
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : text; } catch (_) { return text.slice(1, -1).split(",").map((item) => item.trim()); }
  }
  return text;
}
function parseFrontmatter(source) {
  const normalized = String(source || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md 必须以 YAML frontmatter 开始");
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) throw new Error("SKILL.md 的 frontmatter 未闭合");
  const meta = {};
  let activeObject = null;
  for (const line of normalized.slice(4, end).split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = line.match(/^\s{2,}([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (nested && activeObject) {
      meta[activeObject][nested[1]] = yamlValue(nested[2]);
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) continue;
    const key = match[1]; const value = match[2] || "";
    if (!value && key === "metadata") { meta.metadata = {}; activeObject = "metadata"; }
    else { meta[key] = yamlValue(value); activeObject = null; }
  }
  const bodyStart = normalized.indexOf("\n", end + 4);
  return { meta, body: (bodyStart < 0 ? "" : normalized.slice(bodyStart + 1)).trim() };
}
function quoteYaml(value) { return JSON.stringify(String(value == null ? "" : value)); }
function isStandardName(value) {
  const name = String(value || "").trim();
  return name.length >= 1 && name.length <= 64 && STANDARD_NAME_RE.test(name) && !name.includes("--");
}
function validateSkillName(name) {
  if (!isStandardName(name)) throw new Error("Skill 名称必须为 1–64 位小写字母、数字和单连字符，例如 literature-review");
}
function serializeSkill(skill) {
  const displayName = String(skill.displayName || "").trim();
  return "---\n" +
    "name: " + quoteYaml(skill.name) + "\n" +
    "description: " + quoteYaml(skill.description) + "\n" +
    (skill.license ? "license: " + quoteYaml(skill.license) + "\n" : "") +
    (displayName && displayName !== skill.name ? "metadata:\n  display_name: " + quoteYaml(displayName) + "\n" : "") +
    "---\n\n" + String(skill.instructions || "").trim() + "\n";
}
function isSafeRelativePath(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.startsWith("."))) return null;
  return parts;
}

class SkillRegistry {
  constructor() { this.builtins = new Map(); this.customs = new Map(); }
  load() {
    this.builtins.clear(); this.customs.clear();
    this._loadDir(config.skillsDir, false);
    if (!fs.existsSync(config.customSkillsDir)) return;
    for (const ownerId of fs.readdirSync(config.customSkillsDir)) {
      const dir = path.join(config.customSkillsDir, ownerId);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) this._loadDir(dir, true, ownerId);
    }
  }
  _loadDir(dir, isCustom, ownerId) {
    if (!fs.existsSync(dir)) return;
    for (const directoryName of fs.readdirSync(dir)) {
      const rootDir = path.join(dir, directoryName);
      if (!fs.statSync(rootDir).isDirectory() || SKIP_NAMES.has(directoryName)) continue;
      const sourceFile = path.join(rootDir, SKILL_FILE);
      if (!fs.existsSync(sourceFile)) continue;
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(sourceFile, "utf8"));
        const skill = this._normalize(Object.assign({}, meta, { instructions: body }), isCustom, ownerId, rootDir, sourceFile, directoryName);
        (isCustom ? this.customs : this.builtins).set((isCustom ? skill.ownerId + ":" : "") + skill.id, skill);
      } catch (error) { console.error("[skill-registry] 跳过不符合 Agent Skills 规范的 " + sourceFile + "：" + error.message); }
    }
  }
  _resourceFiles(rootDir) {
    const files = [];
    const visit = (dir, depth) => {
      if (depth > 4 || files.length >= 80) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { visit(full, depth + 1); continue; }
        if (!entry.isFile() || entry.name === SKILL_FILE || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        if (fs.statSync(full).size <= MAX_RESOURCE_BYTES) files.push(path.relative(rootDir, full).split(path.sep).join("/"));
      }
    };
    visit(rootDir, 0); return files.sort();
  }
  _normalize(raw, isCustom, ownerId, rootDir, sourceFile, directoryName) {
    const name = String(raw && raw.name || "").trim();
    const description = String(raw && raw.description || "").trim();
    validateSkillName(name);
    if (directoryName && name !== directoryName) throw new Error("frontmatter 的 name 必须与目录名一致（期望 " + directoryName + "）");
    if (!description || description.length > 1024) throw new Error("description 必填且不得超过 1024 个字符");
    const metadata = raw && raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
    return {
      id: name, name, ownerId: isCustom ? (ownerId || "") : null,
      displayName: String(metadata.display_name || metadata.displayName || raw.displayName || name).trim().slice(0, 80),
      description: description.slice(0, 1024),
      instructions: String(raw && raw.instructions || "").trim().slice(0, MAX_BODY_CHARS),
      license: String(raw && raw.license || "").trim().slice(0, 200),
      builtin: !isCustom, rootDir, sourceFile, resourceFiles: rootDir ? this._resourceFiles(rootDir) : [],
    };
  }
  _public(skill) {
    if (!skill) return null;
    const { rootDir, sourceFile, ...publicSkill } = skill;
    return publicSkill;
  }
  all(ownerId) {
    const custom = Array.from(this.customs.values()).filter((skill) => skill.ownerId === ownerId);
    const overridden = new Set(custom.map((skill) => skill.id));
    return Array.from(this.builtins.values()).filter((skill) => !overridden.has(skill.id)).concat(custom).map((skill) => this._public(skill));
  }
  get(id, ownerId) { return this.customs.get(ownerId + ":" + id) || this.builtins.get(id) || null; }
  resolve(ids, ownerId) { return stringList(ids).map((id) => this.get(id, ownerId)).filter(Boolean); }
  saveCustom(raw, ownerId) {
    if (!ownerId) throw new Error("缺少用户身份");
    const requestedName = String(raw && raw.name || "").trim();
    validateSkillName(requestedName);
    if (raw.id && raw.id !== requestedName) throw new Error("已创建 Skill 的标准名称不可修改；请新建一个 Skill");
    const existing = this.get(requestedName, ownerId);
    const rootDir = path.join(config.customSkillsDir, ownerId, requestedName);
    const sourceFile = path.join(rootDir, SKILL_FILE);
    const draft = Object.assign({}, existing || {}, raw, { name: requestedName, id: requestedName });
    if (!String(draft.description || "").trim()) throw new Error("SKILL.md 必须包含 description");
    fs.mkdirSync(rootDir, { recursive: true });
    const skill = this._normalize(draft, true, ownerId, rootDir, sourceFile, requestedName);
    fs.writeFileSync(sourceFile, serializeSkill(skill), "utf8");
    this.customs.set(ownerId + ":" + skill.id, skill);
    return this._public(skill);
  }
  importZip(archive, ownerId) {
    if (!ownerId) throw new Error("缺少用户身份");
    const entries = normalizeSkillEntries(archive);
    const skillEntry = entries.find((entry) => entry.path === SKILL_FILE);
    if (!skillEntry) throw new Error("压缩包缺少 SKILL.md");
    if (skillEntry.data.includes(0)) throw new Error("SKILL.md 必须是 UTF-8 文本文件");
    let parsed;
    try { parsed = parseFrontmatter(skillEntry.data.toString("utf8")); }
    catch (error) { throw new Error("SKILL.md 格式无效：" + error.message); }
    const name = String(parsed.meta.name || "").trim();
    validateSkillName(name);
    if (this.customs.has(ownerId + ":" + name)) throw new Error("已存在同名的个人 Skill：" + name);
    const ownerDir = path.join(config.customSkillsDir, ownerId);
    const rootDir = path.join(ownerDir, name);
    const sourceFile = path.join(rootDir, SKILL_FILE);
    if (fs.existsSync(rootDir)) throw new Error("Skill 目录已存在：" + name);
    const draft = Object.assign({}, parsed.meta, { instructions: parsed.body });
    const normalized = this._normalize(draft, true, ownerId, null, null, name);
    fs.mkdirSync(ownerDir, { recursive: true });
    const stagingDir = path.join(ownerDir, ".import-" + crypto.randomUUID());
    try {
      fs.mkdirSync(stagingDir);
      for (const entry of entries) {
        const target = path.resolve(stagingDir, ...entry.path.split("/"));
        if (!target.startsWith(stagingDir + path.sep)) throw new Error("压缩包中存在不安全的文件路径");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data, { flag: "wx" });
      }
      fs.renameSync(stagingDir, rootDir);
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(rootDir, { recursive: true, force: true });
      throw error;
    }
    const skill = Object.assign({}, normalized, { rootDir, sourceFile, resourceFiles: this._resourceFiles(rootDir) });
    this.customs.set(ownerId + ":" + skill.id, skill);
    return this._public(skill);
  }
  deleteCustom(id, ownerId) {
    const skill = this.customs.get(ownerId + ":" + id);
    if (!skill) return false;
    this.customs.delete(ownerId + ":" + id);
    fs.rmSync(skill.rootDir, { recursive: true, force: true });
    return true;
  }
  read(skillId, ownerId, relativePath, startLine, endLine) {
    const skill = this.get(skillId, ownerId);
    if (!skill) throw new Error("未找到已安装的 Skill");
    const requested = relativePath ? String(relativePath) : SKILL_FILE;
    const parts = requested === SKILL_FILE ? [SKILL_FILE] : isSafeRelativePath(requested);
    if (!parts) throw new Error("Skill 文件路径不合法");
    const full = path.resolve(skill.rootDir, ...parts);
    if (full !== skill.rootDir && !full.startsWith(skill.rootDir + path.sep)) throw new Error("Skill 文件路径超出目录范围");
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error("Skill 文件不存在");
    if (fs.statSync(full).size > MAX_RESOURCE_BYTES) throw new Error("Skill 文件超过 1MB 读取上限");
    if (requested !== SKILL_FILE && !TEXT_EXTENSIONS.has(path.extname(full).toLowerCase())) throw new Error("不支持读取该类型的 Skill 文件");
    const raw = fs.readFileSync(full, "utf8");
    const content = requested === SKILL_FILE ? parseFrontmatter(raw).body : raw;
    const lines = content.split(/\r?\n/);
    const from = Math.max(1, Number(startLine) || 1);
    const to = Math.min(lines.length, Math.max(from, Number(endLine) || Math.min(lines.length, from + 239)));
    return { skillId: skill.id, skillName: skill.displayName, path: requested, startLine: from, endLine: to, totalLines: lines.length, content: lines.slice(from - 1, to).join("\n"), resources: requested === SKILL_FILE ? skill.resourceFiles : undefined };
  }
}

module.exports = { SkillRegistry, SKILL_FILE, parseFrontmatter, isStandardName };
