/**
 * Transport abstraction — detects Tauri vs browser and provides
 * a unified API for sending commands and receiving events.
 *
 * In Tauri: uses `invoke` + `listen` (Rust bridge to sidecar).
 * In browser: uses HTTP POST + SSE to the dev bridge plugin.
 */

import type {
	WorkspaceMeta,
	RpcHistoryTreeNode,
	RpcHistorySessionView,
	RpcForensicEvent,
} from "./types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- Command sending ---

export async function sendCommandRaw(command: Record<string, unknown>): Promise<string> {
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		return invoke<string>("rpc_command", { command });
	}
	await fetch("/rpc/command", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(command),
	});
	return (command.id as string) ?? Math.random().toString(36).slice(2);
}

export interface RpcResponse<T = unknown> {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: T;
}

export async function sendCommandAwait<T = unknown>(
	command: Record<string, unknown>,
	timeoutMs = 15000,
): Promise<RpcResponse<T>> {
	if (isTauri()) {
		const { listen } = await import("@tauri-apps/api/event");
		// Generate the ID BEFORE sending so the listener can match the response
		// immediately, even if the sidecar responds before sendCommandRaw resolves.
		const id = (command.id as string) ?? crypto.randomUUID();
		command.id = id;
		return new Promise((resolve, reject) => {
			// Tear the listener down exactly once. Several paths race to finish a
			// request (matching response, timeout, send error) and, on page
			// reload, Tauri's internal registry may already be gone — both cases
			// otherwise surface as `listeners[eventId].handlerId` errors.
			let settled = false;
			let unlistenFn: (() => void) | null = null;
			const cleanup = () => { try { unlistenFn?.(); } catch { /* registry gone (reload) */ } };
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cleanup();
				fn();
			};
			const timer = setTimeout(() => {
				finish(() => reject(new Error(`Command "${command.type}" timed out after ${timeoutMs}ms`)));
			}, timeoutMs);
			listen<RpcResponse<T>>("rpc_response", (event) => {
				const payload = event.payload;
				if (payload.id !== id) return;
				finish(() => {
					if (payload.success) {
						resolve(payload);
					} else {
						reject(new Error(payload.error ?? `Command "${command.type}" failed`));
					}
				});
			})
				.then((fn) => {
					// If the request already finished (e.g. timed out) before
					// registration resolved, tear the listener down immediately.
					if (settled) { try { fn(); } catch { /* ignore */ } }
					else unlistenFn = fn;
				})
				.catch(() => { /* registration failed (reload) — swallow */ });
			sendCommandRaw(command).catch((e) => {
				finish(() => reject(e));
			});
		});
	}
	// Browser: generate id, register waiter BEFORE sending to avoid race
	const id = (command.id as string) ?? crypto.randomUUID();
	command.id = id;
	ensureSse();
	const promise = waitForResponse<T>(id, timeoutMs);
	await sendCommandRaw(command);
	return promise;
}

// --- Event subscription ---

export type EventHandler = (event: Record<string, unknown>) => void;
export type ExitHandler = (code: number | null, cwd?: string) => void;

export async function subscribeEvents(handler: EventHandler): Promise<() => void> {
	if (isTauri()) {
		const { listen } = await import("@tauri-apps/api/event");
		// Await registration and swallow failures so a reload-time rejection is
		// never unhandled; the returned unlisten is guarded against a torn-down
		// registry (`listeners[eventId].handlerId`).
		const unlisten = await listen("rpc_event", (event) => handler(event.payload as Record<string, unknown>)).catch(() => null);
		return () => { try { unlisten?.(); } catch { /* registry gone (reload) */ } };
	}
	// Browser: SSE
	return subscribeSse(handler);
}

export async function subscribeSidecarExit(handler: ExitHandler): Promise<() => void> {
	if (isTauri()) {
		const { listen } = await import("@tauri-apps/api/event");
		const unlisten = await listen<{ code: number | null; cwd?: string }>("sidecar_exit", (event) => handler(event.payload.code, event.payload.cwd)).catch(() => null);
		return () => { try { unlisten?.(); } catch { /* registry gone (reload) */ } };
	}
	// Browser: no sidecar exit concept, but we can detect fetch errors
	return () => {};
}

// --- Init ---

export async function initSidecar(cwd?: string): Promise<Record<string, unknown> | null> {
	if (isTauri()) {
		const core = await import("@tauri-apps/api/core");
		const result = await core.invoke<string>("init_sidecar", { cwd: cwd ?? null });
		let parsed = result;
		if (typeof parsed === "string") {
			parsed = JSON.parse(parsed);
		}
		const state = (parsed as unknown as Record<string, unknown>)?.data ?? parsed ?? null;
		return state as Record<string, unknown> | null;
	}
	// Browser: simple GET /rpc/init — bridge sends get_state and returns response
	try {
		const resp = await fetch("/rpc/init");
		if (!resp.ok) {
			console.error("[init] /rpc/init failed:", resp.status);
			return null;
		}
		const json = await resp.json();
		return json.data ?? null;
	} catch (e) {
		console.error("[init] fetch /rpc/init error:", e);
		return null;
	}
}

// --- New workspace (Tauri only) ---

export async function newWorkspace(): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("new_workspace");
}

// --- List workspaces (Tauri only) ---

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
	if (!isTauri()) return [];
	const core = await import("@tauri-apps/api/core");
	const result = await core.invoke<WorkspaceMeta[]>("list_workspaces");
	return result;
}

// --- History tree / event forensics (right dock) ---

export async function historyTreeList(query?: string): Promise<RpcHistoryTreeNode[]> {
	const r = await sendCommandAwait<{ action: "list"; nodes: RpcHistoryTreeNode[] }>({ type: "history_tree", action: "list", query });
	return r.data?.nodes ?? [];
}

export async function historyTreeView(sessionId: string, maxMessages?: number): Promise<RpcHistorySessionView | null> {
	const r = await sendCommandAwait<{ action: "view"; view: RpcHistorySessionView | null }>({ type: "history_tree", action: "view", sessionId, maxMessages });
	return r.data?.view ?? null;
}

export async function historyTreeJump(sessionId: string, reason?: string): Promise<{ session_id: string; reopened: boolean }> {
	const r = await sendCommandAwait<{ action: "jump"; session_id: string; reopened: boolean }>({ type: "history_tree", action: "jump", sessionId, reason });
	return { session_id: r.data?.session_id ?? sessionId, reopened: r.data?.reopened ?? false };
}

export async function historyTreeFork(sessionId: string): Promise<{ session_id: string }> {
	const r = await sendCommandAwait<{ action: "fork"; session_id: string }>({ type: "history_tree", action: "fork", sessionId });
	return { session_id: r.data?.session_id ?? sessionId };
}

export async function historyTreeRename(sessionId: string, name: string): Promise<void> {
	await sendCommandAwait({ type: "history_tree", action: "rename", sessionId, name });
}

export async function getEvents(opts?: { eventTypes?: string[]; limit?: number; sessionScoped?: boolean }): Promise<RpcForensicEvent[]> {
	const r = await sendCommandAwait<{ events: RpcForensicEvent[] }>({ type: "get_events", ...opts }, 30000);
	return r.data?.events ?? [];
}

/** Fork/rewind at a specific event id (used for "replay from here"). */
export async function rewindToEvent(targetEventId: string): Promise<void> {
	await sendCommandAwait({ type: "rewind", targetEventId });
}

export interface BashRunResult {
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
}

export async function runBash(command: string): Promise<BashRunResult> {
	const r = await sendCommandAwait<BashRunResult>({ type: "bash", command }, 120000);
	return r.data ?? { output: "", cancelled: false, truncated: false };
}

export async function abortBash(): Promise<void> {
	try { await sendCommandAwait({ type: "abort_bash" }, 5000); } catch { /* ignore */ }
}

// --- Tool approval (safe mode) ---

/** Approve a pending tool call awaiting user approval. */
export async function approveToolCall(intentEventId: string): Promise<void> {
	try {
		await sendCommandAwait({ type: "approve", intentEventId }, 5000);
	} catch { /* ignore */ }
}

/** Reject (deny) a pending tool call awaiting user approval. */
export async function rejectToolCall(intentEventId: string): Promise<void> {
	try {
		await sendCommandAwait({ type: "reject", intentEventId }, 5000);
	} catch { /* ignore */ }
}

/** Toggle safe mode (master switch for requiring tool approval). */
export async function setSafeMode(enabled: boolean): Promise<boolean> {
	const r = await sendCommandAwait<{ safeMode: boolean }>({ type: "set_safe_mode", enabled }, 5000);
	return r.data?.safeMode ?? enabled;
}
export interface SkillInfo {
	command: string;
	name: string;
	description?: string;
}

/** Start a new conversation session (clears context for a fresh task). */
export async function newSession(): Promise<string | null> {
	try {
		const r = await sendCommandAwait<{ sessionId: string }>({ type: "new_session" }, 5000);
		return r.data?.sessionId ?? null;
	} catch (e) {
		console.error("[composer] new_session failed", e);
		return null;
	}
}

/** List available skills (invocable as slash commands). */
export async function getSkills(): Promise<SkillInfo[]> {
	try {
		const r = await sendCommandAwait<{ skills: SkillInfo[] }>({ type: "get_skills" }, 10000);
		return r.data?.skills ?? [];
	} catch {
		return [];
	}
}

// --- Delete workspace (Tauri only) ---

export async function deleteWorkspace(workspaceId: string): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("delete_workspace", { workspaceId });
}

// --- Reveal workspace in file manager (Tauri only) ---

export async function revealWorkspace(cwd: string): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("reveal_workspace", { cwd });
}

// --- Provider management (Tauri only) ---

export interface ProviderInfo {
	id: string;
	/** Human-readable display name (from pi-ai built-ins); falls back to id. */
	name?: string;
	has_api_key: boolean;
	auth_type: string | null;
}

export async function listProviders(): Promise<ProviderInfo[]> {
	if (!isTauri()) {
		const resp = await fetch("/rpc/providers");
		if (!resp.ok) return [];
		return resp.json();
	}
	const core = await import("@tauri-apps/api/core");
	return core.invoke<ProviderInfo[]>("list_providers");
}

export async function setProviderApiKey(provider: string, apiKey: string): Promise<void> {
	if (!isTauri()) {
		await fetch("/rpc/providers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider, apiKey }),
		});
		return;
	}
	const core = await import("@tauri-apps/api/core");
	await core.invoke("set_provider_api_key", { provider, apiKey });
}

export async function removeProviderApiKey(provider: string): Promise<void> {
	if (!isTauri()) {
		await fetch("/rpc/providers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider, remove: true }),
		});
		return;
	}
	const core = await import("@tauri-apps/api/core");
	await core.invoke("remove_provider_api_key", { provider });
}

// --- SSE implementation for browser mode ---

let sseSource: EventSource | null = null;
const sseHandlers = new Set<EventHandler>();
const responseWaiters = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function ensureSse() {
	if (sseSource) return;
	sseSource = new EventSource("/rpc/events");
	sseSource.onmessage = (ev) => {
		try {
			const line = JSON.parse(ev.data);
			if (line.type === "response") {
				// Try to match by id first
				if (line.id && responseWaiters.has(line.id)) {
					const waiter = responseWaiters.get(line.id)!;
					clearTimeout(waiter.timer);
					responseWaiters.delete(line.id);
					if (line.success) {
						waiter.resolve(line);
					} else {
						waiter.reject(new Error(line.error ?? "Command failed"));
					}
					return;
				}
				// Fallback: if no id match, resolve the oldest waiter
				// (pizza rpc may not echo back the id)
				const oldest = responseWaiters.entries().next();
				if (!oldest.done) {
					const [waiterId, waiter] = oldest.value;
					responseWaiters.delete(waiterId);
					clearTimeout(waiter.timer);
					if (line.success) {
						waiter.resolve(line);
					} else {
						waiter.reject(new Error(line.error ?? "Command failed"));
					}
					return;
				}
			}
			// Forward to all handlers (events + unmatched responses)
			for (const h of sseHandlers) {
				h(line);
			}
		} catch {
			// ignore non-JSON
		}
	};
	sseSource.onerror = () => {
		// Will auto-reconnect
	};
}

function subscribeSse(handler: EventHandler): () => void {
	ensureSse();
	sseHandlers.add(handler);
	return () => {
		sseHandlers.delete(handler);
	};
}

function waitForResponse<T>(id: string, timeoutMs: number): Promise<RpcResponse<T>> {
	ensureSse();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			responseWaiters.delete(id);
			reject(new Error(`Command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		responseWaiters.set(id, { resolve: resolve as (r: RpcResponse) => void, reject, timer });
	});
}
