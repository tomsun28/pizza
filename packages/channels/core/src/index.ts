/**
 * Channel core — the shared engine every pizza channel relay uses.
 *
 * A "channel" is an external message integration (Discord / Lark / Slack /
 * Telegram / webhook) that delivers inbound messages into a workspace agent and
 * relays the agent's replies back out. This package holds the parts that are
 * identical for every platform so each `packages/channels/<platform>` stays a thin
 * adapter: gateway lifecycle, provenance, config, and the deliver/reply loop.
 *
 *   external platform ──message──▶ runtime.deliver(workspace, text, source)
 *                                          │  synchronous gateway `tell` (carries `from`)
 *                                          ▼
 *                                   pizza gateway ──▶ workspace agent (Reactor)
 *                                   ◀── reply text ──
 *   external platform ◀──reply───── adapter posts it back
 *
 * Provenance is the whole point: `source` becomes a uniform
 * <message from="discord:#dev-alerts"> block inside the agent — the same
 * envelope agent tells, cron ticks, watchers and webhooks all use.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
	GatewayClient,
	ensureGateway,
	gatewaySocketPath,
	type MessageSource,
} from "@tomsun28/pizza/gateway";

export type { MessageSource } from "@tomsun28/pizza/gateway";

/** The integration kinds a channel can be. Open set — a new channel package
 *  adds a value here (and a field branch in the UI ChannelDialog). */
export type ChannelType = "discord" | "lark" | "slack" | "telegram" | "webhook";

/** A persisted channel configuration (mirrors apps/web/src/lib/channels.ts). */
export interface ChannelConfig {
	id: string;
	type: ChannelType;
	/** User-facing label. */
	name: string;
	enabled: boolean;
	/** Platform credential (bot token, signing secret, …). */
	token?: string;
	/** Discord guild / Lark tenant. */
	server?: string;
	/** Discord channel / Lark chat / Slack channel name. */
	channel?: string;
	/** webhook type only. */
	webhookUrl?: string;
	/** Target pizza workspace (cwd or name) that inbound messages route to. */
	workspace: string;
}

/** Build the provenance the agent attributes a message to.
 *  provenance("discord", "#dev-alerts") → { kind:"discord", id:"#dev-alerts" }. */
export function provenance(type: ChannelType, id: string): MessageSource {
	return { kind: type, id };
}

export interface ChannelRuntimeOptions {
	/** Pizza agent dir (default ~/.pizza/agent). */
	agentDir?: string;
	/** Gateway socket path (default gatewaySocketPath()). */
	socketPath?: string;
	/** Connect timeout ms (default 5000). */
	connectTimeout?: number;
	/** Per-deliver tell timeout ms (default 120000). Lets a full agent turn run. */
	tellTimeoutMs?: number;
}

/**
 * One long-lived gateway connection shared by every inbound message. Wraps the
 * synchronous `tell`: deliver `text` to `workspace` tagged with `source`
 * provenance, resolve with the agent's final reply text.
 *
 * Concurrent delivers to the SAME workspace are serialized by the gateway
 * (queued — the agent processes one prompt at a time); delivers to DIFFERENT
 * workspaces run in parallel.
 */
export class ChannelRuntime {
	private readonly client: GatewayClient;
	private readonly agentDir: string;
	private readonly tellTimeoutMs: number;
	private connected = false;

	constructor(options: ChannelRuntimeOptions = {}) {
		this.agentDir = options.agentDir ?? join(homedir(), ".pizza", "agent");
		this.tellTimeoutMs = options.tellTimeoutMs ?? 120_000;
		this.client = new GatewayClient({
			socketPath: options.socketPath ?? gatewaySocketPath(),
			connectTimeout: options.connectTimeout ?? 5_000,
		});
	}

	/** Ensure the gateway daemon is up, then connect. Call once at startup. */
	async start(): Promise<void> {
		if (this.connected) return;
		await ensureGateway(this.agentDir, gatewaySocketPath());
		await this.client.connect();
		this.connected = true;
	}

	/** Deliver `text` to a workspace agent and await its reply. */
	async deliver(workspace: string, text: string, source: MessageSource): Promise<string> {
		if (!this.connected) throw new Error("ChannelRuntime not started — call start() first");
		return this.client.tell(workspace, text, source, this.tellTimeoutMs);
	}

	/** Drop the gateway connection. */
	async stop(): Promise<void> {
		if (!this.connected) return;
		await this.client.disconnect();
		this.connected = false;
	}
}

/**
 * Channel main loop harness. `factory` starts the platform client (using the
 * shared runtime to deliver messages) and returns a `stop()` to tear it down.
 * SIGINT/SIGTERM trigger a graceful shutdown of both the adapter and runtime.
 */
export async function runChannel(
	factory: (runtime: ChannelRuntime) => Promise<() => Promise<void>>,
): Promise<void> {
	const runtime = new ChannelRuntime();
	await runtime.start();
	const stopAdapter = await factory(runtime);

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[channel] ${signal} received, shutting down…`);
		await stopAdapter().catch(() => {});
		await runtime.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Parse a "keyA=valA,keyB=valB" env string into a map. Channels use it for
 * PIZZA_ROUTES ("#dev-alerts=myrepo,#general=myrepo") — the channel → workspace
 * routing that mirrors ChannelConfig.channel → ChannelConfig.workspace.
 */
export function parseRoutes(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		const [key, value] = pair.split("=").map((s) => s.trim());
		if (key && value) out[key] = value;
	}
	return out;
}