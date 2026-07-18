/**
 * Transport abstraction — detects Tauri vs browser and provides
 * a unified API for sending commands and receiving events.
 *
 * In Tauri: uses `invoke` + `listen` (Rust bridge to sidecar).
 * In browser: uses HTTP POST + SSE to the dev bridge plugin.
 */

import type { WorkspaceMeta } from "./types";

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
		// Register listener BEFORE sending to avoid race condition where
		// the response arrives before we start listening.
		return new Promise((resolve, reject) => {
			let sentId: string | undefined;
			const timer = setTimeout(() => {
				unlisten.then((fn) => fn()).catch(() => {});
				reject(new Error(`Command "${command.type}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const unlisten = listen<RpcResponse<T>>("rpc_response", (event) => {
				const payload = event.payload;
				if (sentId !== undefined && payload.id === sentId) {
					clearTimeout(timer);
					unlisten.then((fn) => fn()).catch(() => {});
					if (payload.success) {
						resolve(payload);
					} else {
						reject(new Error(payload.error ?? `Command "${command.type}" failed`));
					}
				}
			});
			// Now send the command — sentId will be set once invoke returns.
			sendCommandRaw(command).then((id) => {
				sentId = id;
			}).catch((e) => {
				clearTimeout(timer);
				unlisten.then((fn) => fn()).catch(() => {});
				reject(e);
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
		return listen("rpc_event", (event) => handler(event.payload as Record<string, unknown>));
	}
	// Browser: SSE
	return subscribeSse(handler);
}

export async function subscribeSidecarExit(handler: ExitHandler): Promise<() => void> {
	if (isTauri()) {
		const { listen } = await import("@tauri-apps/api/event");
		return listen<{ code: number | null; cwd?: string }>("sidecar_exit", (event) => handler(event.payload.code, event.payload.cwd));
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
