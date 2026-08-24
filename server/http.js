"use strict";

// 极简 HTTP 工具集（零依赖）：读 body / 解析 multipart / 发 SSE。

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const lim = limitBytes || 50 * 1024 * 1024;
    req.on("data", (c) => {
      size += c.length;
      if (size > lim) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limitBytes) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new Error("JSON 解析失败：" + e.message);
  }
}

// 从 multipart/form-data 里提取字段与文件。返回 { fields:{}, files:[{fieldname,filename,data}] }
function parseMultipart(buf, boundary) {
  const fields = {};
  const files = [];
  const delim = Buffer.from("--" + boundary);
  let start = 0;
  while (true) {
    const s = buf.indexOf(delim, start);
    if (s === -1) break;
    const partStart = s + delim.length;
    // 跳过 \r\n
    let p = partStart;
    while (p < buf.length && (buf[p] === 0x0d || buf[p] === 0x0a)) p++;
    const nextDelim = buf.indexOf(delim, p);
    if (nextDelim === -1) break;
    let part = buf.slice(p, nextDelim);
    // 去掉末尾 \r\n
    if (part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.slice(0, -2);
    }
    // headers / body 分界 \r\n\r\n
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headerStr = part.slice(0, headerEnd).toString("utf8");
      const body = part.slice(headerEnd + 4);
      const cdMatch = headerStr.match(/Content-Disposition:\s*form-data;[^\r\n]*/i);
      const cd = cdMatch ? cdMatch[0] : "";
      const nameMatch = cd.match(/name="([^"]*)"/);
      const fileMatch = cd.match(/filename="([^"]*)"/);
      const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
      const name = nameMatch ? nameMatch[1] : "";
      if (fileMatch) {
        files.push({
          fieldname: name,
          filename: fileMatch[1],
          contentType: ctMatch ? ctMatch[1].trim() : "application/octet-stream",
          data: body,
        });
      } else {
        fields[name] = body.toString("utf8");
      }
    }
    start = nextDelim;
  }
  return { fields, files };
}

function startSSE(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(": connected\n\n");
  // 心跳，防代理超时
  const hb = setInterval(() => {
    try { res.write(": hb\n\n"); } catch (_) {}
  }, 15000);
  res.on("close", () => clearInterval(hb));
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

module.exports = { readBody, readJson, parseMultipart, startSSE, sendJSON };
