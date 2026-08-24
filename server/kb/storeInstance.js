"use strict";

// 全局单例；KB 数据在内部按 ownerId 隔离并持久化到本地 SQLite。
const { KBStore } = require("./store");
module.exports = new KBStore();
