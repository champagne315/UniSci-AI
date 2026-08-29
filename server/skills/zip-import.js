"use strict";

const zlib = require("zlib");

const LIMITS = {
  maxArchiveBytes: 10 * 1024 * 1024,
  maxEntries: 100,
  maxEntryBytes: 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};
const ZIP_EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const UINT32_MAX = 0xFFFFFFFF;

function readUInt64LE(buffer, offset, label) {
  if (offset + 8 > buffer.length) throw new Error("ZIP64 " + label + " 无效");
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ZIP64 " + label + " 超出支持范围");
  return Number(value);
}
function safePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts;
}
function isMetadata(parts) {
  return parts[0] === "__MACOSX" || parts[parts.length - 1] === ".DS_Store" || parts[parts.length - 1] === "Thumbs.db";
}
function findEndOfCentralDirectory(buffer) {
  const from = Math.max(0, buffer.length - 0xFFFF - 22);
  for (let index = buffer.length - 22; index >= from; index -= 1) {
    if (buffer.readUInt32LE(index) === ZIP_EOCD) return index;
  }
  throw new Error("压缩包不是有效的 ZIP 文件");
}
function readZip64Directory(buffer, eocd) {
  const locator = eocd - 20;
  if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new Error("ZIP64 定位记录无效");
  const recordOffset = readUInt64LE(buffer, locator + 8, "定位偏移");
  if (recordOffset + 56 > buffer.length || buffer.readUInt32LE(recordOffset) !== ZIP64_EOCD) throw new Error("ZIP64 中央目录记录无效");
  const recordSize = readUInt64LE(buffer, recordOffset + 4, "目录记录长度");
  if (recordSize < 44 || recordOffset + 12 + recordSize > buffer.length) throw new Error("ZIP64 中央目录长度无效");
  return {
    entriesCount: readUInt64LE(buffer, recordOffset + 32, "文件数"),
    centralSize: readUInt64LE(buffer, recordOffset + 40, "中央目录大小"),
    centralOffset: readUInt64LE(buffer, recordOffset + 48, "中央目录偏移"),
  };
}
function readZip64Extra(extra, needs) {
  let pointer = 0;
  while (pointer + 4 <= extra.length) {
    const id = extra.readUInt16LE(pointer);
    const size = extra.readUInt16LE(pointer + 2);
    const end = pointer + 4 + size;
    if (end > extra.length) throw new Error("ZIP 扩展字段无效");
    if (id === 0x0001) {
      let cursor = pointer + 4;
      const values = {};
      for (const key of needs) {
        if (cursor + 8 > end) throw new Error("ZIP64 扩展字段不完整");
        values[key] = readUInt64LE(extra, cursor, key);
        cursor += 8;
      }
      return values;
    }
    pointer = end;
  }
  throw new Error("ZIP 缺少必要的 ZIP64 扩展字段");
}
function readArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("上传的压缩包为空");
  if (buffer.length > LIMITS.maxArchiveBytes) throw new Error("Skill 压缩包不能超过 10MB");
  if (buffer.length < 22) throw new Error("压缩包不是有效的 ZIP 文件");
  const eocd = findEndOfCentralDirectory(buffer);
  let entriesCount = buffer.readUInt16LE(eocd + 10);
  let centralSize = buffer.readUInt32LE(eocd + 12);
  let centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entriesCount === 0xFFFF || centralSize === UINT32_MAX || centralOffset === UINT32_MAX) {
    ({ entriesCount, centralSize, centralOffset } = readZip64Directory(buffer, eocd));
  }
  if (entriesCount === 0) throw new Error("压缩包不包含文件");
  if (entriesCount > LIMITS.maxEntries) throw new Error("Skill 压缩包文件数不能超过 " + LIMITS.maxEntries + "（当前 " + entriesCount + " 个）");
  if (centralOffset + centralSize > eocd || centralOffset < 0) throw new Error("ZIP 中央目录无效");
  const entries = [];
  let pointer = centralOffset;
  let totalBytes = 0;
  for (let count = 0; count < entriesCount; count += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== ZIP_CENTRAL) throw new Error("ZIP 目录条目无效");
    const flags = buffer.readUInt16LE(pointer + 8);
    const compression = buffer.readUInt16LE(pointer + 10);
    let compressedSize = buffer.readUInt32LE(pointer + 20);
    let uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const externalAttributes = buffer.readUInt32LE(pointer + 38);
    let localOffset = buffer.readUInt32LE(pointer + 42);
    const recordEnd = pointer + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > buffer.length) throw new Error("ZIP 目录条目长度无效");
    if ((flags & 0x1) !== 0) throw new Error("不支持加密的 Skill 压缩包");
    if (compression !== 0 && compression !== 8) throw new Error("Skill 压缩包仅支持存储或 Deflate 压缩");
    const extra = buffer.subarray(pointer + 46 + nameLength, pointer + 46 + nameLength + extraLength);
    const zip64Needs = [];
    if (uncompressedSize === UINT32_MAX) zip64Needs.push("uncompressedSize");
    if (compressedSize === UINT32_MAX) zip64Needs.push("compressedSize");
    if (localOffset === UINT32_MAX) zip64Needs.push("localOffset");
    if (zip64Needs.length) {
      const zip64 = readZip64Extra(extra, zip64Needs);
      if (zip64.uncompressedSize != null) uncompressedSize = zip64.uncompressedSize;
      if (zip64.compressedSize != null) compressedSize = zip64.compressedSize;
      if (zip64.localOffset != null) localOffset = zip64.localOffset;
    }
    if (uncompressedSize > LIMITS.maxEntryBytes) throw new Error("压缩包内单个文件不能超过 1MB");
    totalBytes += uncompressedSize;
    if (totalBytes > LIMITS.maxTotalBytes) throw new Error("压缩包解压后总大小不能超过 20MB");
    const rawName = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString("utf8");
    const isDirectory = rawName.endsWith("/");
    const pathParts = safePath(rawName);
    if (!pathParts) throw new Error("压缩包中存在不安全的文件路径");
    const ignorable = isMetadata(pathParts);
    if (!ignorable && pathParts.some((part) => part.startsWith("."))) throw new Error("压缩包中存在不允许的隐藏路径");
    const unixFileType = (externalAttributes >>> 16) & 0o170000;
    if (unixFileType === 0o120000) throw new Error("Skill 压缩包不能包含符号链接");
    if (!isDirectory && !ignorable) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL) throw new Error("ZIP 本地文件头无效");
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buffer.length) throw new Error("ZIP 文件数据无效");
      const compressed = buffer.subarray(dataStart, dataEnd);
      let data;
      try { data = compression === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: LIMITS.maxEntryBytes }); }
      catch (_) { throw new Error("ZIP 文件解压失败或超过大小限制"); }
      if (data.length !== uncompressedSize) throw new Error("ZIP 文件大小校验失败");
      entries.push({ path: pathParts.join("/"), parts: pathParts, data });
    }
    pointer = recordEnd;
  }
  if (pointer !== centralOffset + centralSize) throw new Error("ZIP 中央目录长度无效");
  return entries;
}
function normalizeSkillEntries(buffer) {
  const entries = readArchive(buffer);
  const skillEntries = entries.filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"));
  if (skillEntries.length !== 1) throw new Error("压缩包必须且只能包含一个 SKILL.md");
  const skillEntry = skillEntries[0];
  const wrapper = skillEntry.parts.slice(0, -1);
  if (wrapper.length > 1) throw new Error("SKILL.md 必须位于压缩包根目录或唯一的一级 Skill 目录中");
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    const relativeParts = wrapper.length ? entry.parts.slice(wrapper.length) : entry.parts;
    if (!relativeParts.length || (wrapper.length && entry.parts[0] !== wrapper[0])) throw new Error("压缩包只能包含一个 Skill 目录");
    const relativePath = relativeParts.join("/");
    if (seen.has(relativePath)) throw new Error("压缩包中包含重复文件：" + relativePath);
    seen.add(relativePath);
    normalized.push({ path: relativePath, data: entry.data });
  }
  if (!seen.has("SKILL.md")) throw new Error("压缩包缺少 SKILL.md");
  return normalized;
}

module.exports = { LIMITS, normalizeSkillEntries };
