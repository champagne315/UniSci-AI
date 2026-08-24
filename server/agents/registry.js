"use strict";

// Agent 模板注册中心：内置模板对所有用户可见；自定义模板按 ownerId 隔离并保存到 data/agents/<ownerId>/。
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { uid } = require("../store");

class Registry {
  constructor() { this.builtins = new Map(); this.customs = new Map(); }
  load() {
    this.builtins.clear(); this.customs.clear();
    this._loadDir(config.templatesDir, false);
    if (!fs.existsSync(config.customTemplatesDir)) return;
    for (const userId of fs.readdirSync(config.customTemplatesDir)) {
      const dir = path.join(config.customTemplatesDir, userId);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) this._loadDir(dir, true, userId);
    }
  }
  _loadDir(dir, isCustom, ownerId) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const tpl = this._normalize(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")), isCustom, ownerId);
        if (!tpl) continue;
        if (isCustom) this.customs.set(tpl.ownerId + ":" + tpl.id, tpl); else this.builtins.set(tpl.id, tpl);
      } catch (error) { console.error(`[registry] 加载 ${file} 失败:`, error.message); }
    }
  }
  _normalize(raw, isCustom, ownerId) {
    if (!raw || !raw.name) return null;
    const id = raw.id || ("agent_" + raw.name);
    return {
      id, ownerId: isCustom ? (raw.ownerId || ownerId || "") : null,
      name: raw.name, mention: raw.mention || id, role: raw.role || raw.name,
      description: raw.description || raw.role || "", category: raw.category || "通用",
      avatar: raw.avatar || "🤖", color: raw.color || "#475569",
      systemPrompt: raw.systemPrompt || `你是${raw.name}。`, skills: raw.skills || [], tools: raw.tools || [],
      mcp: raw.mcp || [], kbIds: raw.kbIds || [], permissions: raw.permissions || {}, builtin: !isCustom,
    };
  }
  all(ownerId) {
    const custom = Array.from(this.customs.values()).filter((tpl) => tpl.ownerId === ownerId);
    const overridden = new Set(custom.map((tpl) => tpl.id));
    return Array.from(this.builtins.values()).filter((tpl) => !overridden.has(tpl.id)).concat(custom);
  }
  get(id, ownerId) {
    const custom = this.customs.get(ownerId + ":" + id);
    return custom || this.builtins.get(id) || null;
  }
  findByMention(handle, ownerId) {
    if (!handle) return null;
    const h = handle.toLowerCase();
    return this.all(ownerId).find((tpl) => (tpl.mention || "").toLowerCase() === h || tpl.id.toLowerCase() === h) || null;
  }
  saveCustom(template, ownerId) {
    if (!ownerId) throw new Error("缺少用户身份");
    const existing = template.id ? this.get(template.id, ownerId) : null;
    const source = Object.assign({}, existing || {}, template, { id: template.id || uid("agent"), ownerId });
    const tpl = this._normalize(source, true, ownerId);
    const dir = path.join(config.customTemplatesDir, ownerId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, tpl.id + ".json"), JSON.stringify(tpl, null, 2), "utf8");
    this.customs.set(ownerId + ":" + tpl.id, tpl); return tpl;
  }
  deleteCustom(id, ownerId) {
    const tpl = this.customs.get(ownerId + ":" + id);
    if (!tpl) return false;
    this.customs.delete(ownerId + ":" + id);
    const file = path.join(config.customTemplatesDir, ownerId, id + ".json");
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  }
}
module.exports = { Registry };
