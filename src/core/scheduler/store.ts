/**
 * Scheduler storage.
 *
 * Two files per scope:
 *   - tasks.json   — single source of truth, atomic write (tmp + rename)
 *   - runs.jsonl   — append-only fire history
 *
 * Scopes:
 *   - "main"      → ~/.pizza/main/scheduler/{tasks.json,runs.jsonl}
 *   - "workspace" → ~/.pizza/workspaces/<workspaceId>/scheduler/{tasks.json,runs.jsonl}
 *
 * The store exposes a thin async API: `readTasks`, `writeTasks`, `appendRun`,
 * `readRuns`. Higher layers (engine.ts) wrap these with in-memory caches.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

import { join } from "node:path";
import type { ScheduledTask, ScheduledTaskRun } from "@pizza/protocol";

const SCHEMA_VERSION = 1;

interface TasksFile {
	schemaVersion: number;
	tasks: ScheduledTask[];
}

function getSchedulerDir(scope: "main" | "workspace", workspaceId?: string): string {
	if (scope === "main") {
		// Resolved lazily so the import doesn't require a home dir.
		const home = process.env.PIZZA_HOME ?? join(
			process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
			".pizza",
		);
		return join(home, "main", "scheduler");
	}
	if (!workspaceId) throw new Error("workspaceId is required for workspace scope");
	const home = process.env.PIZZA_HOME ?? join(
		process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
		".pizza",
	);
	return join(home, "workspaces", workspaceId, "scheduler");
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function readJsonSafe<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		const raw = readFileSync(path, "utf-8");
		if (!raw.trim()) return fallback;
		return JSON.parse(raw) as T;
	} catch (e) {
		console.warn(`[scheduler] failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
		return fallback;
	}
}

function atomicWriteJson(path: string, data: unknown): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	const json = JSON.stringify(data, null, 2);
	writeFileSync(tmp, json, "utf-8");
	// Best-effort cross-platform atomic replace: POSIX rename(2) replaces the
	// target atomically, but historical Node versions on Windows would throw
	// EEXIST when the target already exists. Unlink the stale target first
	// when we know it exists so the rename below is a true replace on every
	// supported platform. If the unlink fails we still attempt the rename so
	// we don't introduce new failure modes on POSIX.
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {
			// Stale target may be locked or otherwise unremovable; renameSync
			// below will surface the real error if the rename cannot proceed.
		}
	}
	renameSync(tmp, path);
}

/** Read all tasks for the given scope. Returns [] on missing / corrupt file. */
export function readTasks(scope: "main" | "workspace", workspaceId?: string): ScheduledTask[] {
	const dir = getSchedulerDir(scope, workspaceId);
	const file = join(dir, "tasks.json");
	const parsed = readJsonSafe<TasksFile | ScheduledTask[]>(file, { schemaVersion: SCHEMA_VERSION, tasks: [] });
	if (Array.isArray(parsed)) {
		// Legacy / foreign shape — wrap it.
		return parsed as ScheduledTask[];
	}
	const ver = (parsed as TasksFile).schemaVersion;
	if (ver !== SCHEMA_VERSION) {
		console.warn(`[scheduler] unknown tasks.json schemaVersion=${ver}; returning empty list`);
		return [];
	}
	return (parsed as TasksFile).tasks ?? [];
}

/**
 * Atomically replace all tasks for the given scope.
 * Callers are expected to merge changes in memory first, then write back.
 */
export function writeTasks(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	tasks: ScheduledTask[],
): void {
	const dir = getSchedulerDir(scope, workspaceId);
	ensureDir(dir);
	atomicWriteJson(join(dir, "tasks.json"), { schemaVersion: SCHEMA_VERSION, tasks });
}

/** Append a run record to runs.jsonl. Best-effort — failures are logged, never thrown. */
export function appendRun(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	run: ScheduledTaskRun,
): void {
	const dir = getSchedulerDir(scope, workspaceId);
	try {
		ensureDir(dir);
		const file = join(dir, "runs.jsonl");
		writeFileSync(file, `${JSON.stringify(run)}\n`, { flag: "a", encoding: "utf-8" });
	} catch (e) {
		console.warn(
			`[scheduler] failed to append run for ${scope}:${run.taskId}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * Read recent runs for a specific task. Returns runs in reverse-chronological
 * order (newest first), capped at `limit`. Skips malformed lines.
 */
export function readRuns(
	scope: "main" | "workspace",
	workspaceId: string | undefined,
	taskId: string,
	limit = 50,
): ScheduledTaskRun[] {
	const dir = getSchedulerDir(scope, workspaceId);
	const file = join(dir, "runs.jsonl");
	if (!existsSync(file)) return [];
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch (e) {
		console.warn(`[scheduler] failed to read runs.jsonl: ${e instanceof Error ? e.message : String(e)}`);
		return [];
	}
	const out: ScheduledTaskRun[] = [];
	const lines = raw.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as ScheduledTaskRun;
			if (parsed.taskId === taskId) out.push(parsed);
			if (out.length >= limit) break;
		} catch {
			// Skip malformed lines.
		}
	}
	return out;
}

/** Test-only: get the directory path for a scope without creating it. */
export function getSchedulerDirForTest(scope: "main" | "workspace", workspaceId?: string): string {
	return getSchedulerDir(scope, workspaceId);
}