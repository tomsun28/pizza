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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
