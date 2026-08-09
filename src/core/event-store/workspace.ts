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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
	writeFileSync(path, JSON.stringify(meta, null, 2));
	return meta;
}
