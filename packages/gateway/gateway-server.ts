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
	type MessageSource,
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
	/**
	 * Hand the agent a prompt. Resolves once the agent has *accepted* it (the
	 * turn then runs asynchronously); rejects when the agent refuses it, e.g.
	 * because a turn is already in flight.
	 */
	prompt(message: string, images?: unknown[]): Promise<void>;
	/**
	 * Queue a message to be handled after the turn currently in flight. Used as
	 * the fallback for async tells when the agent is mid-turn on work the
	 * gateway does not own (e.g. a desktop user's prompt).
	 */
	followUp(message: string, images?: unknown[]): Promise<void>;
	/** Resolve when the agent's current turn settles. Rejects on timeout. */
	waitForIdle(timeout?: number): Promise<void>;
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
	 * Health-check interval (ms): every interval, each idle agent in the pool
	 * receives a lightweight `get_state` RPC. If it doesn't respond within
	 * `agentHealthTimeout` ms, the agent is considered stuck and is torn down
	 * so the next request spawns a fresh one. Default: 60_000. 0 disables.
	 */
	agentHealthCheckInterval?: number;
	/** Per-agent health-check timeout (ms). Default: 10_000. */
	agentHealthTimeout?: number;
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
	/**
	 * Set while a tell-driven turn is in flight, so concurrent tells queue.
	 * Async tells hold it too (they release it in the background when the turn
	 * settles) — the agent is single-threaded, so overlapping prompts are
	 * rejected outright and would be lost.
	 */
	busy: boolean;
	/** FIFO of pending tells waiting for the agent to become idle. */
	queue: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
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
	const healthCheckInterval = options.agentHealthCheckInterval ?? 60_000;
	const healthCheckTimeout = options.agentHealthTimeout ?? 10_000;
	const emitter = new EventEmitter();

	const pool = new Map<string, PoolEntry>();
	let server: Server | undefined;
	let shuttingDown = false;
	const startTime = Date.now();
	const { cliPath, binary } = resolveCliSpawn();
	/** Active client sockets — destroyed on shutdown so connected clients
	 * get EOF immediately instead of waiting for the process to exit. */
	const activeSockets = new Set<Socket>();

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
			// Any event the agent emits (streaming tokens, tool calls, turn
			// lifecycle) is proof of life: refresh lastActivity so the idle
			// timer never evicts an agent mid-turn. This covers the channel
			// `rpc` path (e.g. a desktop prompt) which never touches the
			// `tell` path the timer was originally wired to.
			entry.lastActivity = Date.now();
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

	/** True if at least one channel connection is currently subscribed to `cwd`. */
	function hasLiveSubscribers(cwd: string): boolean {
		return (subscribers.get(cwd)?.size ?? 0) > 0;
	}

	/**
	 * Whether `entry` may be idle-evicted right now. We keep an agent resident
	 * as long as ANY of these hold:
	 *   - it is busy (a tell is in flight),
	 *   - it has queued tells,
	 *   - it emitted activity recently (within the idle window) — this is the
	 *     signal that spans a full turn on the channel `rpc` path, where the
	 *     prompt command is acked instantly and the turn plays out as events,
	 *   - a channel connection is still attached to its workspace (e.g. a
	 *     desktop window is open) — the pool exists precisely to reuse it.
	 */
	function isEntryInUse(entry: PoolEntry): boolean {
		const now = Date.now();
		return (
			entry.busy ||
			entry.queue.length > 0 ||
			now - entry.lastActivity < agentIdleTimeout ||
			hasLiveSubscribers(entry.cwd)
		);
	}

	/**
	 * (Re)start the idle-eviction timer for an entry. No-op once the entry has
	 * left the pool (torn down): a stale timer would otherwise fire later and
	 * evict whatever agent has since taken its place.
	 */
	function scheduleIdleEviction(entry: PoolEntry): void {
		if (agentIdleTimeout <= 0) return;
		if (pool.get(entry.cwd) !== entry) return;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => {
			if (pool.get(entry.cwd) !== entry) return;
			if (isEntryInUse(entry)) {
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
		// Stop fanning this workspace's events out. The forwarder is
		// per-agent (it unsubscribes from the old agent's event stream),
		// but subscribers are per-connection — keep them so a freshly
		// spawned agent (getOrCreateAgent) re-broadcasts to the same
		// channels without requiring each one to re-attach.
		const forwarder = eventForwarders.get(cwd);
		if (forwarder) {
			forwarder();
			eventForwarders.delete(cwd);
		}
		await entry.client.stop().catch(() => {});
		emitter.emit("agentClosed", cwd as never);
	}

/**
 * Render an inbound message as the block the receiving agent sees in its
 * context. Uniform across all source kinds — only `from` varies — so the agent
 * learns one format and can read its reply address straight off the block:
 *
 *   <message from="agent:web" id="m_...">
 *   the message content
 *   </message>
 *
 * `from` serializes a {@link MessageSource} as `kind:id`. A generated `id`
 * tags the message for future `inReplyTo` threading. When `source` is absent
 * the block is omitted and the content is returned bare (the legacy path).
 */
function renderInboundMessage(source: MessageSource | undefined, content: string, id: string): string {
	if (!source) return content;
	// Neutralize any `<message …>`/`</message>` markup the sender embedded:
	// without this a message body can close the block early and forge whatever
	// follows it (a cross-agent prompt injection). The attribute values are
	// quoted, so a `"` in a cwd would break the block the same way.
	const from = `${source.kind}:${source.id}`.replace(/"/g, "&quot;");
	const body = content.replace(/<(\/?)message(\s[^>]*)?>/gi, (_m, slash: string, attrs = "") => `&lt;${slash}message${attrs}&gt;`);
	return `<message from="${from}" id="${id}">\n${body}\n</message>`;
}

/** Unique-per-process message id. Date.now() alone collides within a tick. */
let messageCounter = 0;
function nextMessageId(): string {
	return `m_${Date.now().toString(36)}_${(++messageCounter).toString(36)}`;
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
					entry.queue.push({ resolve: () => resolve(), reject });
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

		// Wrap the message with sender provenance so the receiving agent knows who
		// messaged it (and where to reply). Falls back to the bare message for
		// clients that did not send `from`.
		const messageId = nextMessageId();
		const delivered = renderInboundMessage(request.from, request.message, messageId);

		// From here on we own the agent's turn slot in both paths. Async tells
		// release it in the background when the turn settles; sync tells release
		// it in `finally`.
		entry.busy = true;
		entry.lastActivity = Date.now();

		// Subscribe to the turn BEFORE prompting so a fast turn can't complete
		// between the two calls. Attach a no-op catch immediately: the rejection
		// is handled where the promise is consumed, and an unobserved rejection
		// in the async path would crash the daemon.
		const settled = entry.client.waitForIdle(timeout);
		settled.catch(() => {});

		// Delivery is separate from the turn. A refused prompt means the agent is
		// alive but mid-turn on work the gateway does not own (a desktop user's
		// prompt on the channel `rpc` path), so never tear it down here:
		//   - async: hand the message to the agent's own follow-up queue and ack;
		//     it is picked up when the running turn finishes.
		//   - sync: fail with a clear error — a follow-up would settle behind the
		//     other turn, so we could not tell whose reply we were reading.
		try {
			await entry.client.prompt(delivered);
		} catch (error) {
			const m = error instanceof Error ? error.message : String(error);
			releaseTurnSlot(entry);
			if (request.async) {
				try {
					await entry.client.followUp(delivered);
					emitter.emit("tell", cwd, true, Date.now() - startedAt);
					return { type: "tell_result", id: request.id, ok: true, delivered: true, messageId };
				} catch (followUpError) {
					const fm = followUpError instanceof Error ? followUpError.message : String(followUpError);
					emitter.emit("tell", cwd, false, Date.now() - startedAt);
					return { type: "tell_result", id: request.id, ok: false, error: `async tell to ${cwd} failed: ${fm}` };
				}
			}
			emitter.emit("tell", cwd, false, Date.now() - startedAt);
			return {
				type: "tell_result",
				id: request.id,
				ok: false,
				error: `tell to ${cwd} was not accepted: ${m}. The agent is busy with another turn — retry, or send it asynchronously.`,
			};
		}

		// Async path: ack the delivery now and let the turn play out in the
		// background. The receiver replies on its own (symmetric messaging).
		if (request.async) {
			void settled.then(
				() => emitter.emit("tell", cwd, true, Date.now() - startedAt),
				() => emitter.emit("tell", cwd, false, Date.now() - startedAt),
			).finally(() => releaseTurnSlot(entry));
			return { type: "tell_result", id: request.id, ok: true, delivered: true, messageId };
		}

		// Sync path: wait for the turn and return the agent's final assistant text.
		try {
			await settled;
			const reply = await entry.client.getLastAssistantText();
			emitter.emit("tell", cwd, true, Date.now() - startedAt);
			return { type: "tell_result", id: request.id, ok: true, reply: reply ?? "(no response)" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const stderr = entry.client.getStderr?.() ?? "";
			emitter.emit("tell", cwd, false, Date.now() - startedAt);
			// The turn never settled (timeout/crash) — the agent may be wedged, so
			// tear it down and let the next tell spawn a fresh one.
			await teardownAgent(cwd, "tell failed").catch(() => {});
			return {
				type: "tell_result",
				id: request.id,
				ok: false,
				error: `tell to ${cwd} failed: ${message}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`,
			};
		} finally {
			releaseTurnSlot(entry);
		}
	}

	/**
	 * Release the turn slot held by a tell: mark the agent idle, restart the
	 * idle timer and hand the slot to the next queued tell (if any). Safe to
	 * call on an entry that was already torn down.
	 */
	function releaseTurnSlot(entry: PoolEntry): void {
		entry.busy = false;
		entry.lastActivity = Date.now();
		scheduleIdleEviction(entry);
		entry.queue.shift()?.resolve();
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
				// Refresh activity on dispatch: sendCommand acks instantly for
				// prompt/steer (the turn then streams as events, which also refresh
				// lastActivity via the forwarder), so this closes the brief gap
				// before the first streamed event. We deliberately do NOT toggle
				// `busy` here — the authoritative liveness signal is the event
				// stream, and toggling busy around an instant ack would be wrong.
				entry.lastActivity = Date.now();
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
		activeSockets.add(socket);

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

			if (type === "status") {
				const now = Date.now();
				write({
					type: "status_result",
					uptime: now - startTime,
					channels: subscribers.size,
					agents: Array.from(pool.values()).map((e) => ({
						cwd: e.cwd,
						busy: e.busy,
						queueLength: e.queue.length,
						lastActivityMs: now - e.lastActivity,
					})),
				});
				return;
			}

			if (type === "shutdown") {
				write({ type: "shutdown_ok" });
				void stop().catch(() => {});
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
		socket.on("close", () => { activeSockets.delete(socket); cleanup(); });
		socket.on("error", () => { activeSockets.delete(socket); cleanup(); });
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	/** Periodic health check: ping each idle agent; tear down non-responders. */
	let healthTimer: NodeJS.Timeout | undefined;
	function startHealthCheck(): void {
		if (healthCheckInterval <= 0) return;
		if (healthTimer) return;
		healthTimer = setInterval(async () => {
			const now = Date.now();
			for (const entry of Array.from(pool.values())) {
				// Only check idle agents — busy ones are processing a user
				// request and should not be health-checked (that would queue
				// behind the turn and falsely "timeout").
				if (entry.busy) continue;
				// Stale check: if last activity was recent, skip — the agent
				// is clearly alive (it just handled a request).
				if (now - entry.lastActivity < healthCheckInterval) continue;
				try {
					await entry.client.sendCommand({ type: "get_state", id: `_health_${Date.now()}` });
				} catch {
					// Re-check: if the agent became busy while we were waiting,
					// it's healthy — don't tear it down.
					if (entry.busy) continue;
					emitter.emit("agentClosed", entry.cwd as never);
					void teardownAgent(entry.cwd, "health-check failed").catch(() => {});
				}
			}
		}, healthCheckInterval);
		healthTimer.unref?.();
	}
	function stopHealthCheck(): void {
		if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
	}

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
		startHealthCheck();
	}

	async function stop(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		stopHealthCheck();
		// Tear down all pooled agents.
		const cwds = Array.from(pool.keys());
		await Promise.all(cwds.map((cwd) => teardownAgent(cwd, "shutdown").catch(() => {})));
		// Destroy all active client sockets so connected clients (desktop,
		// CLI, etc.) get EOF immediately and can trigger their reconnect
		// logic. Without this, server.close() only stops accepting NEW
		// connections — existing ones hang until the process fully exits.
		for (const sock of activeSockets) {
			sock.destroy();
		}
		activeSockets.clear();
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