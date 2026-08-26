"use strict";

const dns = require("dns/promises");
const net = require("net");
const config = require("../config");

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15000;

function isPrivateIp(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = String(address).toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

async function assertPublicUrl(rawUrl) {
  let target;
  try { target = new URL(String(rawUrl || "")); } catch (_) { throw new Error("URL 格式无效"); }
  if (!/^https?:$/.test(target.protocol)) throw new Error("仅支持 HTTP/HTTPS 地址");
  const host = target.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("不允许访问本地或内网地址");
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error("不允许访问内网地址"); return target; }
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch (_) { throw new Error("无法解析目标域名"); }
  if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) throw new Error("目标域名解析到了受限地址");
  return target;
}

async function fetchLimited(rawUrl, redirectCount = 0) {
  if (redirectCount > 3) throw new Error("重定向次数过多");
  const target = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": "UniSci-Agent/1.0" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向缺少目标地址");
      return fetchLimited(new URL(location, target).toString(), redirectCount + 1);
    }
    if (!response.ok) throw new Error("网页请求失败（HTTP " + response.status + "）");
    const reader = response.body && response.body.getReader();
    if (!reader) return { url: target.toString(), contentType: response.headers.get("content-type") || "", text: "" };
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { try { await reader.cancel(); } catch (_) {} throw new Error("网页正文超过 1MB 上限"); }
      chunks.push(value);
    }
    return { url: target.toString(), contentType: response.headers.get("content-type") || "", text: Buffer.concat(chunks).toString("utf8") };
  } finally { clearTimeout(timer); }
}

function decodeEntities(text) { return String(text || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function stripHtml(html) { return decodeEntities(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()); }

async function searchWeb(input = {}) {
  const query = String(input.query || "").trim();
  const limit = Math.max(1, Math.min(8, Number(input.limit) || 5));
  if (!query) throw new Error("缺少搜索关键词");
  if (query.length > 300) throw new Error("搜索关键词不能超过 300 个字符");
  if (config.webSearchEndpoint) {
    const endpoint = new URL(config.webSearchEndpoint);
    endpoint.searchParams.set("q", query); endpoint.searchParams.set("format", "json");
    const page = await fetchLimited(endpoint.toString());
    const data = JSON.parse(page.text);
    const rows = Array.isArray(data.results) ? data.results : [];
    return { query, provider: "configured", results: rows.slice(0, limit).map((row) => ({ title: String(row.title || "").slice(0, 300), url: row.url, snippet: stripHtml(row.content || row.snippet || "").slice(0, 600) })) };
  }
  const page = await fetchLimited("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
  const results = []; const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let match;
  while ((match = re.exec(page.text)) && results.length < limit) {
    let resultUrl = decodeEntities(match[1]);
    try { const parsed = new URL(resultUrl, "https://duckduckgo.com"); resultUrl = parsed.searchParams.get("uddg") || parsed.toString(); } catch (_) {}
    try { await assertPublicUrl(resultUrl); } catch (_) { continue; }
    results.push({ title: stripHtml(match[2]).slice(0, 300), url: resultUrl, snippet: stripHtml(match[3] || "").slice(0, 600) });
  }
  return { query, provider: "duckduckgo-html", results };
}

async function fetchPage(input = {}) {
  const page = await fetchLimited(input.url);
  const isHtml = /text\/html|application\/xhtml/i.test(page.contentType);
  const content = (isHtml ? stripHtml(page.text) : page.text).slice(0, 30000);
  return { url: page.url, contentType: page.contentType, content, truncated: page.text.length > content.length };
}

module.exports = { searchWeb, fetchPage, assertPublicUrl };
