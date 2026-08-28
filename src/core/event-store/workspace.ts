/**
 * Workspace Identification and Storage Layout
 *
 * Provides deterministic workspace_id derivation from cwd and the
 * standard storage path structure.
 *
 * Storage layout:
 *   <agentDir>/workspaces/<workspace_id>/
 *     events.sqlite             # Primary event log + session index
 *     meta.json
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir as getDefaultAgentDir } from "../../config.js";

/**
 * workspace_id = deterministic hash of canonical cwd
 * Same directory always yields the same workspace_id.
 */
export function deriveWorkspaceId(cwd: string): string {
	const canonical = resolve(cwd).replace(/\\/g, "/");
	return `ws_${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

/**
 * Returns the workspace directory:
 *   <agentDir>/workspaces/<workspace_id>/
 */
export function getWorkspaceDir(workspaceId: string, agentDir: string = getDefaultAgentDir()): string {
	const dir = join(agentDir, "workspaces", workspaceId);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/** Returns the primary SQLite event database path for a workspace. */
export function getEventDatabasePath(workspaceId: string, agentDir?: string): string {
	return join(getWorkspaceDir(workspaceId, agentDir), "events.sqlite");
}

/** Returns the meta.json path for a workspace. */
export function getWorkspaceMetaPath(workspaceId: string, agentDir?: string): string {
	return join(getWorkspaceDir(workspaceId, agentDir), "meta.json");
}

/**
 * Write JSON to `path` atomically (temp file + rename).
 *
 * meta.json is updated by every Pizza process that touches the workspace, so a
 * plain writeFileSync leaves a window where a concurrent reader observes a
 * truncated file and treats the workspace as corrupt. rename(2) is atomic, so
 * readers only ever see the old or the new file — never a partial one.
 */
export function atomicWriteJson(path: string, data: unknown): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
		// POSIX rename replaces atomically. Older Node on Windows could throw
		// EEXIST, so drop a known-existing target first (mirrors scheduler/store).
		if (process.platform === "win32" && existsSync(path)) {
			try {
				unlinkSync(path);
			} catch {
				// Locked target — let the rename below surface the real error.
			}
		}
		renameSync(tmp, path);
	} catch (error) {
		// Never leave the temp file behind on failure.
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {
			// Nothing more we can do.
		}
		throw error;
	}
}

/** Workspace metadata. */
export interface WorkspaceMeta {
	workspace_id: string;
	cwd: string;
	created_at: number;
	last_accessed_at: number;
}

/**
 * A discoverable workspace agent known to the local agent directory.
 *
 * Returned by {@link listKnownWorkspaces} so the main agent can enumerate the
 * project directories it has previously worked in (e.g. for the built-in
 * `_tell list` cli command).
 */
export interface KnownWorkspace {
	workspace_id: string;
	cwd: string;
	created_at: number;
	last_accessed_at: number;
	/** Whether the workspace's event database file exists on disk. */
	has_event_db: boolean;
}

/**
 * Enumerate all workspace agents known to `agentDir` by scanning each
 * `workspaces/<id>/meta.json` file under the agent directory.
 *
 * Workspaces whose `meta.json` is unreadable or malformed are skipped. The
 * result is sorted by `last_accessed_at` descending (most recent first) so the
 * most relevant projects appear first. The delegating agent's own working
 * directory (matched by cwd) is excluded — an agent delegates to other
 * projects, never itself.
 */
export function listKnownWorkspaces(agentDir: string = getDefaultAgentDir(), excludeCwd?: string): KnownWorkspace[] {
	const workspacesRoot = join(agentDir, "workspaces");
	if (!existsSync(workspacesRoot)) {
		return [];
	}

	let entries: string[];
	try {
		entries = readdirSync(workspacesRoot);
	} catch {
		return [];
	}

	const known: KnownWorkspace[] = [];
	for (const entry of entries) {
		const metaPath = join(workspacesRoot, entry, "meta.json");
		if (!existsSync(metaPath)) continue;
		try {
			const meta = JSON.parse(readFileSync(metaPath, "utf8")) as WorkspaceMeta;
			if (!meta.workspace_id || !meta.cwd) continue;
			known.push({
				workspace_id: meta.workspace_id,
				cwd: meta.cwd,
				created_at: meta.created_at ?? 0,
				last_accessed_at: meta.last_accessed_at ?? 0,
				has_event_db: existsSync(join(workspacesRoot, entry, "events.sqlite")),
			});
		} catch {
			// skip unreadable / malformed meta
		}
	}

	// Exclude the main agent's own working directory if provided.
	const exclude = excludeCwd ? resolve(excludeCwd).replace(/\\/g, "/") : undefined;
	const filtered = exclude ? known.filter((ws) => resolve(ws.cwd).replace(/\\/g, "/") !== exclude) : known;

	filtered.sort((a, b) => b.last_accessed_at - a.last_accessed_at);
	return filtered;
}

/** Read workspace metadata, creating it if absent. */
export function ensureWorkspaceMeta(workspaceId: string, cwd: string, agentDir?: string): WorkspaceMeta {
	const path = getWorkspaceMetaPath(workspaceId, agentDir);
	if (existsSync(path)) {
		try {
			const raw = readFileSync(path, "utf8");
			return JSON.parse(raw) as WorkspaceMeta;
		} catch {
			// fall through to create
		}
	}
	const meta: WorkspaceMeta = {
		workspace_id: workspaceId,
		cwd,
		created_at: Date.now(),
		last_accessed_at: Date.now(),
	};
	atomicWriteJson(path, meta);
	return meta;
}
