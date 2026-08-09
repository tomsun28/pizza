/**
 * Pizza SDK 嵌入 Node 服务示例。
 *
 * 用 Node 内置 http 模块起一个 HTTP 服务，把 Pizza agent 包装成一个
 * POST /ask 接口。请求体: { "prompt": "..." }
 * 响应体: { "text": "...", "events": [...] }
 *
 * 用法:
 *   1. 先构建 Pizza:  npm run build
 *   2. 设置 API key:   export ANTHROPIC_API_KEY=sk-...
 *   3. 运行:           node examples/sdk-server.mjs
 *   4. 测试:           curl -s localhost:3001/ask -d '{"prompt":"hi"}' -H 'Content-Type: application/json'
 *
 * 同一个 facade 在多个请求间复用 —— Pizza 会自动管理上下文/压缩/分支。
 * 如果想要每个请求独立会话，把 createFacade() 移到 handleAsk 里每次新建即可。
 */

import { createServer } from "node:http";
import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  DefaultResourceLoader,
  createSessionFacade,
} from "../dist/src/index.js";

const PORT = Number(process.env.PORT ?? 3001);
const CWD = process.cwd();
const AGENT_DIR = process.env.PIZZA_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pizza", "agent");

// ---------- 1. 构造 services（auth / model / settings / resource loader） ----------
const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
const settingsManager = SettingsManager.create(CWD, AGENT_DIR);
const modelRegistry = ModelRegistry.create(authStorage, join(AGENT_DIR, "models.json"));
const resourceLoader = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: AGENT_DIR,
  settingsManager,
});
await resourceLoader.reload();

// ---------- 2. 创建 facade（事件溯源 Session） ----------
const { facade, model } = await createSessionFacade({
  cwd: CWD,
  agentDir: AGENT_DIR,
  authStorage,
  settingsManager,
  modelRegistry,
  resourceLoader,
  // storagePath 留空 -> 默认 SQLite 持久化到 ~/.pizza/agent
  // storagePath: ":memory:",  // 测试用内存库
});

if (!model) {
  console.error("No model available — set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY etc.");
  process.exit(1);
}
console.log(`[pizza-sdk] facade ready, model=${model.provider}/${model.id}`);

// ---------- 3. HTTP 服务 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk) => (buf += chunk));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleAsk(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: "invalid json body" });
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) return sendJson(res, 400, { error: "missing 'prompt'" });

  // 收集本轮事件（可选 —— 给前端做实时渲染用）
  const events = [];
  const unsub = facade.subscribe((event) => events.push(event));

  try {
    await facade.prompt(prompt);
    const messages = facade.getProjection().buildContext().messages;
    const last = messages[messages.length - 1];
    const text =
      last?.role === "assistant"
        ? Array.isArray(last.content)
          ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("")
          : String(last.content ?? "")
        : "";
    return sendJson(res, 200, { text, events });
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    unsub();
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/ask") return handleAsk(req, res);
  if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true, model: model.id });
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[pizza-sdk] listening on http://localhost:${PORT}`);
  console.log(`[pizza-sdk] try: curl -s localhost:${PORT}/ask -d '{"prompt":"hi"}' -H 'Content-Type: application/json'`);
});

// ---------- 4. 优雅退出 ----------
async function shutdown() {
  console.log("\n[pizza-sdk] shutting down...");
  server.close();
  await facade.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
