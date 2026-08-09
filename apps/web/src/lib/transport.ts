/**
 * Transport abstraction — detects Tauri vs browser and provides
 * a unified API for sending commands and receiving events.
 *
 * In Tauri: uses `invoke` + `listen` (Rust bridge to sidecar).
 * In browser: uses HTTP POST + SSE to the dev bridge plugin.
 */

import type {
	WorkspaceMeta,
	RpcSessionState,
	RpcHistoryTreeNode,
	RpcHistorySessionView,
	RpcForensicEvent,
} from "./types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- Command sending ---

/**
 * Invoke a Tauri command directly. Convenience wrapper around `@tauri-apps/api/core`
 * that no-ops in the browser. Use for non-RPC commands like revealing files
 * in the OS file manager.
 */
export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T | null> {
	if (typeof window === "undefined") return null;
	if (!isTauri()) return null;
	try {
		const mod = await import("@tauri-apps/api/core");
		return await mod.invoke<T>(command, args);
	} catch {
		return null;
	}
}

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

export interface MainAgentStatus {
	running: boolean;
	pid?: number | null;
	command?: string | null;
	lockPath: string;
}

export async function mainAgentStatus(): Promise<MainAgentStatus | null> {
	if (!isTauri()) return null;
	const core = await import("@tauri-apps/api/core");
	return await core.invoke<MainAgentStatus>("main_agent_status");
}

export async function stopMainAgent(): Promise<MainAgentStatus | null> {
	if (!isTauri()) return null;
	const core = await import("@tauri-apps/api/core");
	return await core.invoke<MainAgentStatus>("stop_main_agent");
}

export async function getSessionState(timeoutMs = 5000): Promise<RpcSessionState | null> {
	const r = await sendCommandAwait<RpcSessionState>({ type: "get_state" }, timeoutMs);
	return r.data ?? null;
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

export async function historyTreeSwitch(sessionId: string, reason?: string): Promise<{ session_id: string }> {
	const r = await sendCommandAwait<{ action: "switch"; session_id: string }>({ type: "history_tree", action: "switch", sessionId, reason });
	return { session_id: r.data?.session_id ?? sessionId };
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

export type ExtensionKind = "builtin" | "user" | "project" | "cli" | "package";

export interface ExtensionInfo {
	id: string;
	name: string;
	description?: string;
	kind: ExtensionKind;
	enabled: boolean;
	canToggle: boolean;
	installable: boolean;
	installed: boolean;
	path: string;
	toolCount: number;
	commandCount: number;
}

/** List all extensions (built-in + user-installed), including disabled built-ins. */
export async function getExtensions(): Promise<ExtensionInfo[]> {
	try {
		const r = await sendCommandAwait<{ extensions: ExtensionInfo[] }>({ type: "get_extensions" }, 10000);
		return r.data?.extensions ?? [];
	} catch {
		return [];
	}
}

/** Enable or disable a built-in extension. Returns whether a reload is required. */
export async function setExtensionEnabled(id: string, enabled: boolean): Promise<boolean> {
	const r = await sendCommandAwait<{ requiresReload: boolean }>(
		{ type: "set_extension_enabled", extensionId: id, enabled },
		5000,
	);
	return r.data?.requiresReload ?? true;
}

/** Install an extension's external dependency (e.g. the agent-browser CLI). Long-running. */
export async function installExtension(
	id: string,
): Promise<{ ok: boolean; message: string; installed: boolean }> {
	const r = await sendCommandAwait<{ ok: boolean; message: string; installed: boolean }>(
		{ type: "install_extension", extensionId: id },
		600000,
	);
	return { ok: r.data?.ok ?? false, message: r.data?.message ?? "", installed: r.data?.installed ?? false };
}

/** Uninstall an extension's external dependency. */
export async function uninstallExtension(
	id: string,
): Promise<{ ok: boolean; message: string; installed: boolean }> {
	const r = await sendCommandAwait<{ ok: boolean; message: string; installed: boolean }>(
		{ type: "uninstall_extension", extensionId: id },
		120000,
	);
	return { ok: r.data?.ok ?? false, message: r.data?.message ?? "", installed: r.data?.installed ?? false };
}

// --- Skills.sh directory ---

export interface SkillsShSkill {
	id: string;
	source: string;
	slug: string;
	name: string;
	url: string;
	installUrl?: string;
	installs?: number;
}

/**
 * Fetch skill directory from skills.sh by scraping the HTML leaderboard.
 * The official API requires Vercel OIDC auth, but the HTML page contains
 * all skill links rendered server-side.
 */
export async function fetchSkillsSh(): Promise<SkillsShSkill[]> {
	try {
		let html: string;
		if (isTauri()) {
			const core = await import("@tauri-apps/api/core");
			html = await core.invoke<string>("fetch_skills_sh");
		} else {
			const res = await fetch("https://www.skills.sh/", {
				headers: { Accept: "text/html" },
			});
			if (!res.ok) return [];
			html = await res.text();
		}
		const seen = new Set<string>();
		const skills: SkillsShSkill[] = [];
		const linkRegex = /href="\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)"/g;
		let match: RegExpExecArray | null;
		while ((match = linkRegex.exec(html)) !== null) {
			const link = "/" + match[1];
			if (link.startsWith("/_next") || seen.has(link)) continue;
			seen.add(link);
			const parts = link.slice(1).split("/");
			const source = parts.slice(0, -1).join("/");
			const slug = parts[parts.length - 1];
			skills.push({
				id: `${source}/${slug}`,
				source,
				slug,
				name: slug,
				url: `https://www.skills.sh${link}`,
				installUrl: `https://github.com/${source}`,
			});
		}
		return skills;
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

// --- File explorer (Tauri only) ---

export interface DirEntry {
	name: string;
	path: string;
	is_dir: boolean;
	size: number;
}

export async function listDir(cwd: string, subPath?: string): Promise<DirEntry[]> {
	if (!isTauri()) return [];
	const core = await import("@tauri-apps/api/core");
	return core.invoke<DirEntry[]>("list_dir", { cwd, subPath: subPath ?? null });
}

export interface FileSearchEntry {
	/** Basename of the file. */
	name: string;
	/** Path relative to the workspace root (e.g. "src/components/Terminal.tsx"). */
	path: string;
	is_dir: boolean;
}

/**
 * Recursively search files under the workspace (Tauri only). Returns files at
 * all depths (skipping node_modules / target / dist / …), ordered shallowest
 * first. When `query` is given, only files whose relative path contains it
 * (case-insensitive) are returned. Capped at `limit` (default 1000).
 */
export async function searchFiles(
	cwd: string,
	query?: string | null,
	limit?: number,
): Promise<FileSearchEntry[]> {
	if (!isTauri()) return [];
	const core = await import("@tauri-apps/api/core");
	return core.invoke<FileSearchEntry[]>("search_files", {
		cwd,
		query: query ?? null,
		limit: limit ?? null,
	});
}

export async function readFileContent(cwd: string, filePath: string): Promise<string> {
	if (!isTauri()) return "";
	const core = await import("@tauri-apps/api/core");
	return core.invoke<string>("read_file", { cwd, filePath });
}

export async function openInEditor(cwd: string, filePath: string): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("open_in_editor", { cwd, filePath });
}

export async function revealPath(cwd: string, subPath: string): Promise<void> {
	if (!isTauri()) return;
	const core = await import("@tauri-apps/api/core");
	await core.invoke("reveal_path", { cwd, subPath });
}

// --- Git status / diff (right dock Git tab, Tauri only) ---

export interface GitStatusEntry {
	/** Two-char porcelain status code, e.g. " M", "M ", "A ", "??". */
	xy: string;
	/** File path relative to the repo root. */
	path: string;
	/** Original path for renames/copies, if any. */
	orig_path?: string | null;
	/** Added lines vs HEAD; null for untracked or binary files. */
	additions?: number | null;
	/** Removed lines vs HEAD; null for untracked or binary files. */
	deletions?: number | null;
}

/** Which diff `gitDiff` should return for a path. */
export type GitDiffMode = "staged" | "worktree" | "untracked";

export interface GitStatusSummary {
	is_repo: boolean;
	branch: string;
	head: string;
	head_subject: string;
	upstream: string;
	ahead: number;
	behind: number;
	entries: GitStatusEntry[];
	untracked: number;
	staged: number;
	unstaged: number;
}

export async function gitStatus(cwd: string): Promise<GitStatusSummary> {
	if (!isTauri()) {
		return {
			is_repo: false, branch: "", head: "", head_subject: "", upstream: "",
			ahead: 0, behind: 0, entries: [], untracked: 0, staged: 0, unstaged: 0,
		};
	}
	const core = await import("@tauri-apps/api/core");
	return core.invoke<GitStatusSummary>("git_status", { cwd });
}

export async function gitDiff(cwd: string, path: string, mode: GitDiffMode): Promise<string> {
	if (!isTauri()) return "";
	const core = await import("@tauri-apps/api/core");
	return core.invoke<string>("git_diff", { cwd, path, mode });
}

export interface GitBranchEntry {
	/** Branch name (without remotes/ prefix). */
	name: string;
	/** True if this is the current branch (HEAD). */
	is_current: boolean;
	/** True if this is a remote-tracking branch. */
	is_remote: boolean;
	/** Upstream tracking ref, if any. */
	upstream?: string | null;
}

/** List all git branches (local + remote) in the repo at `cwd`. Empty if not a repo. */
export async function gitBranches(cwd: string): Promise<GitBranchEntry[]> {
	if (!isTauri()) return [];
	const core = await import("@tauri-apps/api/core");
	return core.invoke<GitBranchEntry[]>("git_branches", { cwd });
}

// --- Provider management (Tauri only) ---

export interface ProviderInfo {
	id: string;
	/** Human-readable display name (from pi-ai built-ins); falls back to id. */
	name?: string;
	has_api_key: boolean;
	auth_type: string | null;
	is_custom?: boolean;
	protocol?: "openai" | "anthropic" | null;
	model_count?: number;
}

export interface CustomProviderInput {
	id: string;
	name?: string;
	protocol: "openai" | "anthropic";
	base_url: string;
	api_key: string;
	models: Array<{ id: string; name?: string }>;
}

export interface CustomProviderTestResult {
	ok: boolean;
	protocol: "openai" | "anthropic";
	model: string;
	message: string;
	response?: string | null;
	status?: number | null;
	duration_ms: number;
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

export async function saveCustomProvider(input: CustomProviderInput): Promise<void> {
	if (!isTauri()) {
		const resp = await fetch("/rpc/custom-provider", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!resp.ok) {
			const body = await resp.json().catch(() => ({}));
			throw new Error(body.error ?? "Failed to save custom provider");
		}
		return;
	}
	const core = await import("@tauri-apps/api/core");
	await core.invoke("save_custom_provider", { input });
}

export async function testCustomProvider(input: CustomProviderInput): Promise<CustomProviderTestResult> {
	if (!isTauri()) {
		const resp = await fetch("/rpc/custom-provider/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!resp.ok) {
			const body = await resp.json().catch(() => ({}));
			throw new Error(body.error ?? "Failed to test custom provider");
		}
		return resp.json();
	}
	const core = await import("@tauri-apps/api/core");
	return core.invoke<CustomProviderTestResult>("test_custom_provider", { input });
}

export async function removeCustomProvider(provider: string): Promise<void> {
	if (!isTauri()) {
		const resp = await fetch("/rpc/custom-provider", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider }),
		});
		if (!resp.ok) {
			const body = await resp.json().catch(() => ({}));
			throw new Error(body.error ?? "Failed to remove custom provider");
		}
		return;
	}
	const core = await import("@tauri-apps/api/core");
	await core.invoke("remove_custom_provider", { provider });
}

/**
 * Restart the sidecar for the given workspace so it picks up newly-configured
 * API keys. The facade caches its model registry on startup, so after writing
 * a new key to ~/.pizza/agent/auth.json the sidecar must be respawned for the
 * model list to refresh. No-op outside Tauri (web/preview builds don't have
 * a sidecar to restart).
 */
export async function restartSidecar(cwd: string): Promise<string> {
	if (!isTauri()) return "";
	// Tauri 2's `core.invoke` is generic; declaring `<string>` makes the
	// Rust command's `Result<String, String>` Ok variant flow through as
	// a real `string` instead of `void`. Without this the caller gets
	// `unknown` and `JSON.parse(undefined)` blows up.
	const core = await import("@tauri-apps/api/core");
	return await core.invoke<string>("restart_sidecar", { cwd });
}


// --- Scheduled tasks ----------------------------------------------------------

export async function listScheduledTasks(
	scope: "main" | "workspace",
	workspaceId?: string,
): Promise<import("./types.js").ScheduledTaskSummary[]> {
	const r = await sendCommandAwait<{ tasks: import("./types.js").ScheduledTaskSummary[] }>(
		{ type: "schedule_list", scope, workspaceId },
		10000,
	);
	return r.data?.tasks ?? [];
}

export async function createScheduledTask(
	task: import("./types.js").ScheduledTaskCreateInput,
): Promise<import("./types.js").ScheduledTaskSummary> {
	const r = await sendCommandAwait<{ task: import("./types.js").ScheduledTaskSummary }>(
		{ type: "schedule_create", task },
		10000,
	);
	if (!r.data?.task) throw new Error("schedule_create returned no task");
	return r.data.task;
}

export async function updateScheduledTask(
	taskId: string,
	patch: import("./types.js").ScheduledTaskPatch,
	scope: "main" | "workspace",
	workspaceId?: string,
): Promise<import("./types.js").ScheduledTaskSummary> {
	const r = await sendCommandAwait<{ task: import("./types.js").ScheduledTaskSummary }>(
		{ type: "schedule_update", taskId, patch, scope, workspaceId },
		10000,
	);
	if (!r.data?.task) throw new Error("schedule_update returned no task");
	return r.data.task;
}

export async function deleteScheduledTask(
	taskId: string,
	scope: "main" | "workspace",
	workspaceId?: string,
): Promise<void> {
	await sendCommandAwait(
		{ type: "schedule_delete", taskId, scope, workspaceId },
		5000,
	);
}

export async function runScheduledTaskNow(
	taskId: string,
	scope: "main" | "workspace",
	workspaceId?: string,
): Promise<void> {
	await sendCommandAwait(
		{ type: "schedule_run_now", taskId, scope, workspaceId },
		5000,
	);
}

export async function reloadScheduledTasks(): Promise<number> {
	const r = await sendCommandAwait<{ reloaded: number }>(
		{ type: "schedule_reload" },
		5000,
	);
	return r.data?.reloaded ?? 0;
}



// --- Scheduler policy (per-scope defaults) -----------------------------

export async function getSchedulerPolicy(): Promise<import("./types.js").SchedulerPolicy> {
	const r = await sendCommandAwait<{ policy: import("./types.js").SchedulerPolicy }>(
		{ type: "get_scheduler_policy" },
		5000,
	);
	return r.data?.policy ?? { concurrency: "skip", timeoutMinutes: 0, defaultSessionTarget: { kind: "pinned" } };
}

export async function setSchedulerPolicy(policy: import("./types.js").SchedulerPolicy): Promise<import("./types.js").SchedulerPolicy> {
	const r = await sendCommandAwait<{ policy: import("./types.js").SchedulerPolicy }>(
		{ type: "set_scheduler_policy", policy },
		5000,
	);
	return r.data?.policy ?? policy;
}
export async function getScheduledTaskHistory(
	taskId: string,
	scope: "main" | "workspace",
	workspaceId?: string,
	limit = 50,
): Promise<import("./types.js").ScheduledTaskRun[]> {
	const r = await sendCommandAwait<{ runs: import("./types.js").ScheduledTaskRun[] }>(
		{ type: "schedule_history", taskId, scope, workspaceId, limit },
		5000,
	);
	return r.data?.runs ?? [];
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
