import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BUILTIN_PROVIDERS = [
	"anthropic", "openai", "google", "zai", "openrouter",
	"groq", "mistral", "deepseek", "xai", "fireworks",
	"together", "perplexity", "cohere", "amazon-bedrock",
];

function authPath() {
	return path.join(os.homedir(), ".pizza", "agent", "auth.json");
}

function readAuth() {
	try {
		const raw = fs.readFileSync(authPath(), "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeAuth(data) {
	const dir = path.dirname(authPath());
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(authPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function listProviders() {
	const auth = readAuth();
	const providers = [];
	for (const id of BUILTIN_PROVIDERS) {
		const cred = auth[id];
		providers.push({
			id,
			has_api_key: cred != null,
			auth_type: cred?.type ?? null,
		});
	}
	for (const key of Object.keys(auth)) {
		if (!BUILTIN_PROVIDERS.includes(key)) {
			providers.push({ id: key, has_api_key: true, auth_type: auth[key]?.type ?? null });
		}
	}
	return providers;
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (e) {
				reject(e);
			}
		});
	});
}

function sendJson(res, status, obj) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(obj));
}

/**
 * Vite dev plugin: spawns `pizza rpc` as a child process and exposes
 * HTTP endpoints for the browser to communicate with it.
 *
 *   POST /rpc/command   → send a JSON command to pizza stdin
 *   GET  /rpc/events    → SSE stream of stdout lines (responses + events)
 *   GET  /rpc/state     → convenience: sends get_state and returns the response
 *
 * In Tauri mode this plugin is not needed — the Rust bridge handles IPC.
 */
export function pizzaRpcBridge() {
	let child = null;
	let stdoutBuffer = [];
	const sseClients = new Set();

	function ensureChild() {
		if (child) return;
		console.log("[pizza-rpc-bridge] spawning pizza --mode rpc...");
		child = spawn("pizza", ["--mode", "rpc"], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: process.cwd(),
		});

		let lineBuf = "";
		child.stdout.on("data", (chunk) => {
			lineBuf += chunk.toString();
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop();
			for (const line of lines) {
				if (!line.trim()) continue;
				stdoutBuffer.push(line);
				for (const res of sseClients) {
					res.write(`data: ${line}\n\n`);
				}
			}
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString().trim();
			if (text) console.error(`[pizza-rpc-bridge stderr] ${text}`);
		});

		child.on("error", (err) => {
			console.error(`[pizza-rpc-bridge] spawn error: ${err.message}`);
			child = null;
		});

		child.on("exit", (code, signal) => {
			console.log(`[pizza-rpc-bridge] child exited code=${code} signal=${signal}`);
			child = null;
		});
	}

	return {
		name: "pizza-rpc-bridge",
		configureServer(server) {
			ensureChild();

			server.middlewares.use("/rpc/init", (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end("Method Not Allowed");
				return;
			}
			// Send get_state and wait for the response
			const cmd = JSON.stringify({ type: "get_state", id: "init" }) + "\n";
			if (!child?.stdin?.writable) {
				res.statusCode = 503;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "pizza not running" }));
				return;
			}

			// Listen for the init response in the stdout buffer
			let resolved = false;
			const initTimer = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				res.statusCode = 504;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "init timed out" }));
			}, 10000);

			// Check if response is already buffered
			for (const line of stdoutBuffer) {
				try {
					const parsed = JSON.parse(line);
					if (parsed.type === "response" && parsed.command === "get_state") {
						resolved = true;
						clearTimeout(initTimer);
						res.statusCode = 200;
						res.setHeader("Content-Type", "application/json");
						res.end(line);
						return;
					}
				} catch {}
			}

			// Not buffered yet — listen for it via a one-time SSE check
			const checkBuffer = setInterval(() => {
				for (const line of stdoutBuffer) {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === "response" && parsed.command === "get_state" && !resolved) {
							resolved = true;
							clearTimeout(initTimer);
							clearInterval(checkBuffer);
							res.statusCode = 200;
							res.setHeader("Content-Type", "application/json");
							res.end(line);
							return;
						}
					} catch {}
				}
			}, 100);

			// Send the command
			child.stdin.write(cmd);
		});

		server.middlewares.use("/rpc/command", (req, res) => {
				if (req.method !== "POST") {
					res.statusCode = 405;
					res.end("Method Not Allowed");
					return;
				}
				let body = "";
				req.on("data", (chunk) => (body += chunk));
				req.on("end", () => {
					try {
						const cmd = JSON.parse(body);
						if (child?.stdin?.writable) {
							child.stdin.write(JSON.stringify(cmd) + "\n");
							res.statusCode = 200;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ ok: true }));
						} else {
							res.statusCode = 503;
							res.end(JSON.stringify({ error: "pizza process not running" }));
						}
					} catch (e) {
						res.statusCode = 400;
						res.end(JSON.stringify({ error: e.message }));
					}
				});
			});

			server.middlewares.use("/rpc/providers", (req, res) => {
				if (req.method === "GET") {
					sendJson(res, 200, listProviders());
					return;
				}
				if (req.method === "POST") {
					readJsonBody(req).then((body) => {
						const { provider, apiKey, remove } = body;
						if (!provider) return sendJson(res, 400, { error: "provider required" });
						const auth = readAuth();
						if (remove) {
							delete auth[provider];
						} else {
							if (!apiKey) return sendJson(res, 400, { error: "apiKey required" });
							auth[provider] = { type: "api_key", key: apiKey };
						}
						writeAuth(auth);
						sendJson(res, 200, { ok: true });
					}).catch((e) => sendJson(res, 400, { error: e.message }));
					return;
				}
				res.statusCode = 405;
				res.end("Method Not Allowed");
			});

			server.middlewares.use("/rpc/events", (req, res) => {
				if (req.method !== "GET") {
					res.statusCode = 405;
					res.end("Method Not Allowed");
					return;
				}
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				// Send buffered lines first
				for (const line of stdoutBuffer) {
					res.write(`data: ${line}\n\n`);
				}
				sseClients.add(res);
				req.on("close", () => sseClients.delete(res));
			});
		},
	};
}
