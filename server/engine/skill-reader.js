"use strict";

const fs = require("fs");
const path = require("path");
const { SKILL_FILE, parseFrontmatter } = require("../skills/registry");

const MAX_RESOURCE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".js", ".cjs", ".mjs", ".ts", ".py", ".sh", ".ps1", ".r", ".sql", ".csv"]);

function installedSkill(agent, skillId) {
  return (Array.isArray(agent.installedSkills) ? agent.installedSkills : []).find((skill) => skill.id === skillId) || null;
}
function safePath(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length && !parts.some((part) => part === "." || part === ".." || part.startsWith(".")) ? parts : null;
}

function createSkillReader() {
  return async function readSkill(input = {}, ctx) {
    const skillId = String(input.skillId || "").trim();
    const skill = installedSkill(ctx.agent, skillId);
    if (!skill || !skill.rootDir) throw new Error("只能读取当前 Agent 已安装的 Skill");
    const requested = input.path ? String(input.path) : SKILL_FILE;
    const parts = requested === SKILL_FILE ? [SKILL_FILE] : safePath(requested);
    if (!parts) throw new Error("Skill 文件路径不合法");
    const full = path.resolve(skill.rootDir, ...parts);
    if (full !== skill.rootDir && !full.startsWith(skill.rootDir + path.sep)) throw new Error("Skill 文件路径超出目录范围");
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error("Skill 文件不存在");
    if (fs.statSync(full).size > MAX_RESOURCE_BYTES) throw new Error("Skill 文件超过 1MB 读取上限");
    if (requested !== SKILL_FILE && !TEXT_EXTENSIONS.has(path.extname(full).toLowerCase())) throw new Error("不支持读取该类型的 Skill 文件");
    const raw = fs.readFileSync(full, "utf8");
    const content = requested === SKILL_FILE ? parseFrontmatter(raw).body : raw;
    const lines = content.split(/\r?\n/);
    const startLine = Math.max(1, Number(input.startLine) || 1);
    const endLine = Math.min(lines.length, Math.max(startLine, Number(input.endLine) || Math.min(lines.length, startLine + 239)));
    return {
      skillId: skill.id, skillName: skill.displayName || skill.name, path: requested, startLine, endLine, totalLines: lines.length,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      resources: requested === SKILL_FILE ? skill.resourceFiles : undefined,
    };
  };
}

module.exports = { createSkillReader };
