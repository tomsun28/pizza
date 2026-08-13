/**
 * Webhook channel relay — a generic HTTP endpoint that delivers inbound POSTs
 * into a workspace agent and returns the agent's reply as JSON. No external SDK,
 * so it's the simplest channel and a good reference for the others.
 *
 * Run:
 *   npm run build -w @tomsun28/pizza-channel-webhook
 *   PIZZA_WORKSPACE=myrepo WEBHOOK_TOKEN=secret npm start -w @tomsun28/pizza-channel-webhook
 *
 * Test:
 *   curl -s localhost:3002/ \
 *     -H 'content-type: application/json' \
 *     -H 'authorization: Bearer secret' \
 *     -d '{"message":"summarize the last commit","source":"ci-bot"}'
 *   → { "reply": "..." }
 *
 * Env:
 *   PORT            listen port (default 3002)
 *   PIZZA_WORKSPACE default target workspace when the body omits `workspace`
 *   WEBHOOK_TOKEN   optional shared secret; if set, requests must send
 *                   `authorization: Bearer <token>` (or ?token=<token>)
 *
 * Request body:
 *   { "message": "...", "workspace"?: "...", "source"?: "..." }
 * The `source` becomes the provenance id: <message from="webhook:ci-bot">.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { ChannelRuntime, provenance, runChannel } from "@tomsun28/pizza-channel-core";

const PORT = Number(process.env.PORT ?? 3002);
const DEFAULT_WORKSPACE = process.env.PIZZA_WORKSPACE;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

if (!DEFAULT_WORKSPACE) {
	console.error("Missing PIZZA_WORKSPACE (the default workspace inbound webhooks route to).");
	process.exit(1);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	try {
		return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
	} catch {
		throw new Error("invalid JSON body");
	}
}

void runChannel(async (runtime: ChannelRuntime) => {
	const server: Server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		try {
			if (req.method !== "POST") {
				res.writeHead(405);
				return res.end(JSON.stringify({ error: "POST only" }));
			}
			// Optional shared-secret guard.
			if (WEBHOOK_TOKEN) {
				const auth = req.headers.authorization ?? "";
				const url = new URL(req.url ?? "/", "http://localhost");
				const got = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token");
				if (got !== WEBHOOK_TOKEN) {
					res.writeHead(401);
					return res.end(JSON.stringify({ error: "unauthorized" }));
				}
			}

			const body = await readJson(req);
			const message = typeof body.message === "string" ? body.message : "";
			if (!message) {
				res.writeHead(400);
				return res.end(JSON.stringify({ error: "missing 'message'" }));
			}
			const workspace = typeof body.workspace === "string" ? body.workspace : DEFAULT_WORKSPACE;
			const sourceId = typeof body.source === "string" && body.source ? body.source : "webhook";

			const reply = await runtime.deliver(workspace, message, provenance("webhook", sourceId));
			res.writeHead(200);
			res.end(JSON.stringify({ reply }));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error("[webhook] request failed:", reason);
			res.writeHead(502);
			res.end(JSON.stringify({ error: reason }));
		}
	});

	await new Promise<void>((resolve) => server.listen(PORT, resolve));
	console.log(`[webhook] listening on http://localhost:${PORT} → workspace "${DEFAULT_WORKSPACE}"`);
	return async () => await new Promise<void>((resolve) => server.close(() => resolve()));
});