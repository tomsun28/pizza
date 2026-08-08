/**
 * Gateway server — the long-running daemon at the heart of agent-to-agent
 * messaging.
 *
 * Responsibilities:
 *   1. Listen on a Unix domain socket (or Windows named pipe) — the single
 *      rendezvous point for all clients.
 *   2. Maintain a pool of {@link RpcClient} connections, one per workspace cwd.
 *      A repeat `_tell` to the same workspace reuses the existing agent process
 *      instead of spawning a fresh one each time.
 *   3. Route `tell` requests: resolve the destination to a cwd, find-or-spawn
 *      the agent, prompt it, and return the agent's final assistant text.
 *
 * The server is process-local state — it lives for the lifetime of the daemon
 * process. It is started via `pizza --mode gateway` and auto-started on demand
 * by the gateway lifecycle module (like `ssh-agent`).
 */

import { type Server, type Socket, createServer } from "node:net";
import { EventEmitter } from "node:events";
import { platform } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { RpcClient } from "../rpc/rpc-client.js";
import { resolveCliSpawn } from "../rpc/cli-spawn.js";
import { listKnownWorkspaces } from "../../src/core/event-store/workspace.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import {
	type GatewayResponse,
	type GatewayTellRequest,
	type GatewayChannelRequest,
	type GatewayRpcFrame,
	type GatewayWorkspaceInfo,
	GATEWAY_DEFAULT_TELL_TIMEOUT,
} from "./protocol.js";
import type { RpcCommand, RpcResponse } from "../rpc/rpc-types.js";

/**
 * Resolve the gateway socket path. On Unix it is
 * `~/.pizza/<socketBasename>.sock`; on Windows a named pipe
 * `\\.\pipe\<socketBasename>`. The socket lives under the user config root so
 * multiple Pizza installs share one gateway.
 */
export function gatewaySocketPath(socketBasename = "gateway"): string {
	if (platform() === "win32") {
		return `\\\\.\\pipe\\${socketBasename}`;
	}
	// Default to ~/.pizza so the gateway is shared across all agents.
	const configRoot = join(homedir(), ".pizza");
	return join(configRoot, `${socketBasename}.sock`);
}

/** Options for {@link createGatewayServer}. */
/**
 * The slice of {@link RpcClient} the gateway actually uses to drive a workspace
 * agent. The real RpcClient satisfies it; tests (and future non-spawn owners)
 * can supply a fake via {@link GatewayServerOptions.createAgent}.
 */
export interface AgentConnection {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: unknown) => void): () => void;
	onExit(listener: () => void): () => void;
	sendCommand(command: RpcCommand): Promise<RpcResponse>;
	promptAndWait(message: string, images?: unknown[], timeout?: number): Promise<unknown[]>;
	getLastAssistantText(): Promise<string | null>;
	getStderr?(): string;
}

export interface GatewayServerOptions {
	/** Socket path (default: {@link gatewaySocketPath}). */
	socketPath?: string;
	/** Agent config directory — shared with spawned agents for auth/models. */
	agentDir: string;
	/** The main agent working directory — excluded from workspace name lookups. */
	mainDir?: string;
	/**
	 * Idle timeout (ms): agent processes with no recent activity are torn down
	 * after this period. Default: 10 minutes. 0 disables idle eviction.
	 */
	agentIdleTimeout?: number;
	/**
	 * Factory for the workspace agent connection. Defaults to spawning a real
	 * `pizza --mode rpc` process via {@link RpcClient}. Inject a fake for tests
	 * (or a non-spawn owner) — it is memoized per cwd by the pool.
	 */
	createAgent?: (cwd: string) => AgentConnection;
}

/** One entry in the agent process pool, keyed by workspace cwd. */
interface PoolEntry {
	client: AgentConnection;
	cwd: string;
	lastActivity: number;
	/** Set when a prompt is in flight, so concurrent tells queue. */
	busy: boolean;
	/** FIFO of pending tells waiting for the agent to become idle. */
	queue: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
		message: string;
		timeout: number;
	}>;
	/** Idle-eviction timer handle. */
	idleTimer?: NodeJS.Timeout;
}

export interface GatewayServer {
	/** Bind the socket and begin accepting connections. */
	start: () => Promise<void>;
	/** Tear down all agents, close the server, remove the socket file. */
	stop: () => Promise<void>;
	readonly socketPath: string;
	on: (event: keyof GatewayServerEvents, listener: (...args: any[]) => void) => void;
}

export interface GatewayServerEvents {
	/** A client connected. */
	connection: (remote: string) => void;
	/** A `tell` completed (ok or error). */
	tell: (to: string, ok: boolean, durationMs: number) => void;
	/** An agent process was spawned. */
	agentSpawned: (cwd: string) => void;
	/** An agent process was torn down (idle eviction or shutdown). */
	agentClosed: (cwd: string) => void;
	/** Server started listening. */
	listening: (socketPath: string) => void;
	/** An unexpected error. */
	error: (error: Error) => void;
}

/**
 * Create (but not yet start) a gateway server. Call `.start()` to bind the
 * socket and begin accepting connections. Call `.stop()` on shutdown.
 */
export function createGatewayServer(options: GatewayServerOptions): GatewayServer {
	const socketPath = options.socketPath ?? gatewaySocketPath();
	const agentDir = options.agentDir;
	const mainDir = options.mainDir;
	const agentIdleTimeout = options.agentIdleTimeout ?? 10 * 60_000;
	const emitter = new EventEmitter();

	const pool = new Map<string, PoolEntry>();
	let server: Server | undefined;
	let shuttingDown = false;
	const { cliPath, binary } = resolveCliSpawn();

	// ── channel subscriptions ─────────────────────────────────────────────
	// Each workspace can have many channel connections watching it. The gateway
	// fans agent events out to every subscriber; responses are routed back to the
	// originating channel by frame.id inside handleChannelRequest.
	type ConnWriter = (obj: GatewayResponse) => void;
	/** workspace cwd → set of connection writers currently subscribed. */
	const subscribers = new Map<string, Set<ConnWriter>>();
	/** workspace cwd → unsubscribe fn for the agent onEvent forwarder (attached once). */
	const eventForwarders = new Map<string, () => void>();

	/** Fan an agent event out to every channel subscribed to `cwd`. */
	function broadcastEvent(cwd: string, frame: GatewayRpcFrame): void {
		const subs = subscribers.get(cwd);
		if (!subs || subs.size === 0) return;
		const envelope: GatewayResponse = { type: "rpc", workspace: cwd, frame };
		for (const writer of subs) {
			writer(envelope);
		}
	}

	/** Attach the (single) event forwarder for a workspace's agent, if not already. */
	function ensureForwarder(cwd: string, entry: PoolEntry): void {
		if (eventForwarders.has(cwd)) return;
		const unsubscribe = entry.client.onEvent((event) => {
			broadcastEvent(cwd, event as unknown as GatewayRpcFrame);
		});
		eventForwarders.set(cwd, unsubscribe);
	}

	// ── workspace resolution ──────────────────────────────────────────────

	/**
	 * Resolve a destination string (`to`) to a workspace cwd. Accepts:
	 *   - an absolute cwd path (used directly)
	 *   - a workspace name (last path component), matched against known
	 *     workspaces — case-insensitive, most-recently-accessed wins.
	 * Returns null when no match is found.
	 */
	function resolveDestination(to: string): string | null {
		const trimmed = to.trim();
		if (!trimmed) return null;
		// Absolute or relative path → resolve to absolute.
		if (
			trimmed.startsWith("/") ||
			trimmed.startsWith("~") ||
			/^[a-zA-Z]:[\\/]/.test(trimmed) ||
			trimmed.startsWith("..") ||
			trimmed.startsWith(".")
		) {
			const expanded = trimmed.startsWith("~/")
				? join(homedir(), trimmed.slice(2))
				: trimmed;
			return expanded.replace(/\\/g, "/");
		}
		// Otherwise treat as a workspace name (last path component).
		const workspaces = listKnownWorkspaces(agentDir, mainDir);
		const lower = trimmed.toLowerCase();
		for (const ws of workspaces) {
			const lastComponent = ws.cwd.replace(/\/+$/, "").split("/").pop() ?? ws.cwd;
			if (lastComponent.toLowerCase() === lower) {
				return ws.cwd.replace(/\\/g, "/");
			}
		}
		return null;
	}

	// ── agent pool management ─────────────────────────────────────────────

	function makeEnv(): Record<string, string> {
		return { PIZZA_AGENT_DIR: agentDir };
	}

	/** Find or spawn the RpcClient for `cwd`. */
	async function getOrCreateAgent(cwd: string): Promise<PoolEntry> {
		const existing = pool.get(cwd);
		if (existing) return existing;

		// If this cwd is the main agent directory, spawn the sub-agent with
		// --main so it loads SOUL.md, long-term memory, and the main agent
		// system prompt (and acquires the main lock instead of the workspace
		// lock). The gateway itself does NOT hold the main lock — only the
		// per-workspace agent does.
		const isMainAgent = mainDir !== undefined && cwd === mainDir;
		const extraArgs = isMainAgent ? ["--main"] : undefined;
		const client = options.createAgent
			? options.createAgent(cwd)
			: new RpcClient({ cwd, cliPath, binary, env: makeEnv(), args: extraArgs });
		await client.start();
		const entry: PoolEntry = {
			client,
			cwd,
			lastActivity: Date.now(),
			busy: false,
			queue: [],
		};
		pool.set(cwd, entry);
		scheduleIdleEviction(entry);
		ensureForwarder(cwd, entry);
		// If the agent process dies on its own (crash, OOM, etc.), evict the dead
		// entry immediately so the next request spawns a fresh agent instead of
		// timing out against a corpse for 30s (or waiting for idle eviction).
		entry.client.onExit(() => {
			if (pool.get(cwd) === entry) {
				void teardownAgent(cwd, "agent exited").catch(() => {});
			}
		});
		emitter.emit("agentSpawned", cwd as never);
		return entry;
	}

	/** (Re)start the idle-eviction timer for an entry. */
	function scheduleIdleEviction(entry: PoolEntry): void {
		if (agentIdleTimeout <= 0) return;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => {
			if (entry.busy || entry.queue.length > 0) {
				// Still active — reschedule.
				scheduleIdleEviction(entry);
				return;
			}
			void teardownAgent(entry.cwd, "idle");
		}, agentIdleTimeout);
		entry.idleTimer.unref?.();
	}

	/** Tear down and remove an agent from the pool. */
	async function teardownAgent(cwd: string, _reason: string): Promise<void> {
		const entry = pool.get(cwd);
		if (!entry) return;
		pool.delete(cwd);
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		// Reject any queued waiters.
		for (const waiter of entry.queue) {
			waiter.reject(new Error(`agent for ${cwd} was torn down before the message was delivered`));
		}
		entry.queue.length = 0;
		// Stop fanning this workspace's events out and drop its subscriber set.
		const forwarder = eventForwarders.get(cwd);
		if (forwarder) {
			forwarder();
			eventForwarders.delete(cwd);
		}
		subscribers.delete(cwd);
		await entry.client.stop().catch(() => {});
		emitter.emit("agentClosed", cwd as never);
	}

	// ── tell routing ──────────────────────────────────────────────────────

	/**
	 * Process a single tell: resolve destination → find/spawn agent → prompt →
	 * reply. Concurrent tells to the SAME agent are serialized (queued) so the
	 * single-threaded agent isn't asked to process two prompts at once.
	 *
	 * Returns the wire response to write back to the client.
	 */
	async function handleTell(request: GatewayTellRequest): Promise<GatewayResponse> {
		const startedAt = Date.now();
		const timeout = request.timeout ?? GATEWAY_DEFAULT_TELL_TIMEOUT;

		const cwd = resolveDestination(request.to);
		if (!cwd) {
			emitter.emit("tell", request.to, false, Date.now() - startedAt);
			return {
				type: "tell_result",
				id: request.id,
				ok: false,
				error: `Unknown workspace "${request.to}". Use a project path (cwd) or a workspace name from _tell list.`,
			};
		}

		let entry: PoolEntry;
		try {
			entry = await getOrCreateAgent(cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emitter.emit("tell", cwd, false, Date.now() - startedAt);
			return {
				type: "tell_result",
				id: request.id,
				ok: false,
				error: `Failed to start agent for ${cwd}: ${message}`,
			};
		}

		// Serialize: if the agent is busy, wait for it to drain.
		if (entry.busy) {
			try {
				await new Promise<void>((resolve, reject) => {
					entry.queue.push({
						message: request.message,
						timeout,
						resolve: () => resolve(),
						reject,
					});
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				emitter.emit("tell", cwd, false, Date.now() - startedAt);
				return { type: "tell_result", id: request.id, ok: false, error: message };
			}
			// If the entry was torn down while waiting, bail.
			if (pool.get(cwd) !== entry) {
				emitter.emit("tell", cwd, false, Date.now() - startedAt);
				return {
					type: "tell_result",
					id: request.id,
					ok: false,
					error: `agent for ${cwd} was torn down before the message was delivered`,
				};
			}
		}

		// Run the prompt.
		entry.busy = true;
		entry.lastActivity = Date.now();
		try {
			await entry.client.promptAndWait(request.message, undefined, timeout);
			const reply = await entry.client.getLastAssistantText();
			emitter.emit("tell", cwd, true, Date.now() - startedAt);
			return { type: "tell_result", id: request.id, ok: true, reply: reply ?? "(no response)" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const stderr = entry.client.getStderr?.() ?? "";
			emitter.emit("tell", cwd, false, Date.now() - startedAt);
			// A failed prompt may leave the agent in a bad state — tear it down
			// so the next tell gets a fresh agent.
			await teardownAgent(cwd, "tell failed").catch(() => {});
			return {
				type: "tell_result",
				id: request.id,
				ok: false,
				error: `tell to ${cwd} failed: ${message}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`,
			};
		} finally {
			entry.busy = false;
			entry.lastActivity = Date.now();
			scheduleIdleEviction(entry);
			// Drain one queued tell (the agent can now process it).
			const next = entry.queue.shift();
			if (next) {
				next.resolve();
			}
		}
	}

	// ── channel request handling ─────────────────────────────────────────

	/**
	 * Handle a Layer-1 channel request from a connection. `write` is that
	 * connection's writer (used both for direct replies and for subscribing to
	 * event fan-out). `subscribedCwds` tracks this connection's subscriptions so
	 * they can be cleaned up on disconnect.
	 */
	async function handleChannelRequest(
		request: GatewayChannelRequest,
		write: ConnWriter,
		subscribedCwds: Set<string>,
	): Promise<void> {
		switch (request.type) {
			case "attach": {
				const cwd = resolveDestination(request.workspace);
				if (!cwd) {
					write({ type: "error", message: `Unknown workspace "${request.workspace}". Use a project path (cwd) or a workspace name from list.` });
					return;
				}
				try {
					const entry = await getOrCreateAgent(cwd);
					ensureForwarder(cwd, entry);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					write({ type: "error", message: `Failed to start agent for ${cwd}: ${message}` });
					return;
				}
				let subs = subscribers.get(cwd);
				if (!subs) {
					subs = new Set();
					subscribers.set(cwd, subs);
				}
				subs.add(write);
				subscribedCwds.add(cwd);
				write({ type: "attach_ok", workspace: cwd });
				return;
			}
			case "detach": {
				const cwd = resolveDestination(request.workspace);
				if (!cwd) return;
				const subs = subscribers.get(cwd);
				if (subs) {
					subs.delete(write);
					if (subs.size === 0) subscribers.delete(cwd);
				}
				subscribedCwds.delete(cwd);
				return;
			}
			case "rpc": {
				const cwd = resolveDestination(request.workspace);
				if (!cwd) {
					write({ type: "error", message: `Unknown workspace "${request.workspace}".` });
					return;
				}
				const entry = await getOrCreateAgent(cwd);
				const response = await entry.client.sendCommand(request.frame as RpcCommand);
				// Route the response back to THIS channel only (events fan out separately).
				write({ type: "rpc", workspace: cwd, frame: response as GatewayRpcFrame });
				return;
			}
			case "list": {
				const known = listKnownWorkspaces(agentDir, mainDir);
				const workspaces: GatewayWorkspaceInfo[] = known.map((ws) => ({
					workspace_id: ws.workspace_id,
					cwd: ws.cwd,
					name: ws.cwd.replace(/\\+$/, "").split("/").pop() ?? ws.cwd,
					last_accessed_at: ws.last_accessed_at,
				}));
				write({ type: "list_result", workspaces });
				return;
			}
		}
	}

	// ── connection handling ───────────────────────────────────────────────

	function handleConnection(socket: Socket): void {
		const remote = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`;
		emitter.emit("connection", remote as never);

		const write: ConnWriter = (obj: GatewayResponse): void => {
			if (!socket.destroyed) {
				socket.write(`${serializeJsonLine(obj)}\n`);
			}
		};

		// Workspaces this connection is subscribed to — cleaned up on disconnect.
		const subscribedCwds = new Set<string>();

		const detach = attachJsonlLineReader(socket, (line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				write({ type: "error", message: "Failed to parse JSON line" });
				return;
			}

			const type = (parsed as { type?: string })?.type;
			if (type === "ping") {
				write({ type: "pong" });
				return;
			}
			if (type === "tell") {
				const request = parsed as GatewayTellRequest;
				if (!request.id || typeof request.id !== "string") {
					write({ type: "error", message: "tell requires a string `id`" });
					return;
				}
				// Fire-and-forget; the result is written when the promise settles.
				void handleTell(request).then(write).catch((error: unknown) => {
					write({
						type: "tell_result",
						id: request.id,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				});
				return;
			}

			// Channel protocol: attach / detach / rpc / list.
			if (type === "attach" || type === "detach" || type === "rpc" || type === "list") {
				void handleChannelRequest(parsed as GatewayChannelRequest, write, subscribedCwds).catch((error: unknown) => {
					write({ type: "error", message: error instanceof Error ? error.message : String(error) });
				});
				return;
			}

			write({ type: "error", message: `Unknown message type: ${type ?? "?"}` });
		});

		const cleanup = (): void => {
			detach();
			// Remove this connection from every workspace it was watching.
			for (const cwd of subscribedCwds) {
				const subs = subscribers.get(cwd);
				if (subs) {
					subs.delete(write);
					if (subs.size === 0) subscribers.delete(cwd);
				}
			}
			subscribedCwds.clear();
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	async function start(): Promise<void> {
		if (server) return;
		server = createServer(handleConnection);

		await new Promise<void>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE" && platform() !== "win32") {
					// Stale socket from a crashed daemon — remove and retry once.
					try {
						const { unlinkSync } = require("node:fs") as typeof import("node:fs");
						unlinkSync(socketPath);
					} catch {
						/* ignore */
					}
					server!.listen(socketPath, () => {
						server!.off("error", onError);
						emitter.emit("listening", socketPath as never);
						resolve();
					});
					return;
				}
				reject(error);
			};
			server!.once("error", onError);
			server!.listen(socketPath, () => {
				server!.off("error", onError);
				emitter.emit("listening", socketPath as never);
				resolve();
			});
		});
	}

	async function stop(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		// Tear down all pooled agents.
		const cwds = Array.from(pool.keys());
		await Promise.all(cwds.map((cwd) => teardownAgent(cwd, "shutdown").catch(() => {})));
		// Close the server.
		await new Promise<void>((resolve) => {
			if (!server) return resolve();
			server.close(() => resolve());
		});
		// Remove the socket file (Unix only).
		if (platform() !== "win32") {
			try {
				const { unlinkSync } = require("node:fs") as typeof import("node:fs");
				unlinkSync(socketPath);
			} catch {
				/* ignore */
			}
		}
	}

	return {
		start,
		stop,
		socketPath,
		on(event, listener) {
			emitter.on(event, listener);
		},
	};
}