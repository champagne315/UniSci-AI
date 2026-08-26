"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { uid } = require("../store");

const SKILL_FILE = "SKILL.md";
const MAX_BODY_CHARS = 30000;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".js", ".cjs", ".mjs", ".ts", ".py", ".sh", ".ps1", ".r", ".sql", ".csv"]);
const SKIP_NAMES = new Set([".git", "node_modules", ".env"]);

function stringList(value, limit = 24) {
  const values = Array.isArray(value) ? value : (typeof value === "string" ? value.split(",") : []);
  return Array.from(new Set(values.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}
function normalizeId(value, fallback) {
  return String(value || fallback || "skill_" + uid("skill")).replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "skill_" + uid("skill");
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
  if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized.trim() };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) throw new Error("SKILL.md 的 frontmatter 未闭合");
  const raw = normalized.slice(4, end).split("\n");
  const meta = {}; let activeList = null;
  for (const line of raw) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const list = line.match(/^\s+-\s+(.+)$/);
    if (list && activeList) { meta[activeList].push(yamlValue(list[1])); continue; }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) continue;
    const key = match[1]; const value = match[2] || "";
    if (!value) { meta[key] = []; activeList = key; }
    else { meta[key] = yamlValue(value); activeList = null; }
  }
  const bodyStart = normalized.indexOf("\n", end + 4);
  return { meta, body: (bodyStart < 0 ? "" : normalized.slice(bodyStart + 1)).trim() };
}
function quoteYaml(value) { return JSON.stringify(String(value == null ? "" : value)); }
function serializeSkill(skill) {
  const list = (name, values) => !values.length ? "" : name + ":\n" + values.map((value) => "  - " + quoteYaml(value)).join("\n") + "\n";
  return "---\n" +
    "name: " + quoteYaml(skill.name) + "\n" +
    "description: " + quoteYaml(skill.description) + "\n" +
    "category: " + quoteYaml(skill.category) + "\n" +
    list("keywords", skill.keywords) + list("toolIds", skill.toolIds) +
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
    for (const name of fs.readdirSync(dir)) {
      const rootDir = path.join(dir, name);
      if (!fs.statSync(rootDir).isDirectory() || SKIP_NAMES.has(name)) continue;
      const sourceFile = path.join(rootDir, SKILL_FILE);
      if (!fs.existsSync(sourceFile)) continue;
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(sourceFile, "utf8"));
        const skill = this._normalize(Object.assign({}, meta, { id: name, instructions: body }), isCustom, ownerId, rootDir, sourceFile);
        if (skill) (isCustom ? this.customs : this.builtins).set((isCustom ? skill.ownerId + ":" : "") + skill.id, skill);
      } catch (error) { console.error("[skill-registry] 加载 " + sourceFile + " 失败：", error.message); }
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
        const stat = fs.statSync(full);
        if (stat.size <= MAX_RESOURCE_BYTES) files.push(path.relative(rootDir, full).split(path.sep).join("/"));
      }
    };
    visit(rootDir, 0); return files.sort();
  }
  _normalize(raw, isCustom, ownerId, rootDir, sourceFile) {
    if (!raw || !String(raw.name || "").trim() || !String(raw.description || "").trim()) return null;
    const id = normalizeId(raw.id);
    return {
      id, ownerId: isCustom ? (ownerId || "") : null,
      name: String(raw.name).trim().slice(0, 80), category: String(raw.category || "通用").trim().slice(0, 40),
      description: String(raw.description).trim().slice(0, 400),
      instructions: String(raw.instructions || "").trim().slice(0, MAX_BODY_CHARS),
      keywords: stringList(raw.keywords, 32), toolIds: stringList(raw.toolIds, 16), builtin: !isCustom,
      rootDir, sourceFile, resourceFiles: rootDir ? this._resourceFiles(rootDir) : [],
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
    const existing = raw.id ? this.get(raw.id, ownerId) : null;
    const id = normalizeId(raw.id || (existing && existing.id));
    const rootDir = path.join(config.customSkillsDir, ownerId, id);
    const sourceFile = path.join(rootDir, SKILL_FILE);
    const draft = Object.assign({}, existing || {}, raw, { id });
    if (!String(draft.name || "").trim() || !String(draft.description || "").trim()) throw new Error("SKILL.md 必须包含 name 和 description");
    fs.mkdirSync(rootDir, { recursive: true });
    const skill = this._normalize(draft, true, ownerId, rootDir, sourceFile);
    fs.writeFileSync(sourceFile, serializeSkill(skill), "utf8");
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
    return { skillId: skill.id, skillName: skill.name, path: requested, startLine: from, endLine: to, totalLines: lines.length, content: lines.slice(from - 1, to).join("\n"), declaredTools: requested === SKILL_FILE ? skill.toolIds : undefined, resources: requested === SKILL_FILE ? skill.resourceFiles : undefined };
  }
}

module.exports = { SkillRegistry, SKILL_FILE, parseFrontmatter };
