/**
 * Persistent ("main") agent support.
 *
 * The main agent is a single, long-lived coding companion that lives in its own
 * working directory (default `~/.pizza/main`). Unlike per-project workspaces it
 * has an identity ("soul") file and a long-term memory library that are injected
 * into the system prompt on every session boundary.
 *
 * This module owns:
 *  - first-run initialization of the main dir (SOUL.md + memory scaffold)
 *  - loading the soul file and the long-term memory index
 *  - `_index.md` consistency checks against the memory directory
 *  - main-agent-specific prompt guidelines
 *  - a best-effort single-instance lockfile
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getMainMemoryDir, getMainSoulPath } from "../config.js";

export interface SoulFile {
	path: string;
	content: string;
}

export interface MemoryEntry {
	path: string;
	content: string;
}

const DEFAULT_SOUL_TEMPLATE = `---
description: Aria's soul definition — a long-term programming companion that persists across projects and time.
tags: [identity, soul, persistent-agent, memory]
---
# Identity
You are Aria, the user's long-term programming companion. You exist across
projects and across time. Edit this file to define your own personality.

# Values
- Proactively remember the user's preferences and past decisions.
- Review relevant long-term memory when starting a new topic.
- Be honest about uncertainty; verify before asserting.

# Voice
Concise, direct, and opinionated when it helps.
`;

const DEFAULT_INDEX_TEMPLATE = `# Memory Index

This file indexes the long-term memory library. Each entry links a memory file
to a short summary so the agent knows what exists without loading everything.

- user-profile.md — stable facts about the user (preferences, environment, style)
`;

const DEFAULT_USER_PROFILE_TEMPLATE = `# User Profile

Long-term, stable facts about the user. Update this as you learn more.

(empty)
`;

/**
 * Ensure the main agent working directory exists and is scaffolded.
 * Returns true when a fresh initialization was performed.
 */
export function initializeMainAgent(mainDir: string, memoryDir?: string): boolean {
	const soulPath = getMainSoulPath(mainDir);
	const resolvedMemoryDir = memoryDir ?? getMainMemoryDir(mainDir);
	const alreadyInitialized = existsSync(soulPath);

	mkdirSync(mainDir, { recursive: true });
	mkdirSync(resolvedMemoryDir, { recursive: true });

	if (!existsSync(soulPath)) {
		writeFileSync(soulPath, DEFAULT_SOUL_TEMPLATE, "utf-8");
	}

	const indexPath = join(resolvedMemoryDir, "_index.md");
	if (!existsSync(indexPath)) {
		writeFileSync(indexPath, DEFAULT_INDEX_TEMPLATE, "utf-8");
	}

	const userProfilePath = join(resolvedMemoryDir, "user-profile.md");
	if (!existsSync(userProfilePath)) {
		writeFileSync(userProfilePath, DEFAULT_USER_PROFILE_TEMPLATE, "utf-8");
	}

	return !alreadyInitialized;
}

/** Load the soul file if it exists. */
export function loadSoulFile(mainDir: string): SoulFile | undefined {
	const soulPath = getMainSoulPath(mainDir);
	if (!existsSync(soulPath)) {
		return undefined;
	}
	try {
		return { path: soulPath, content: readFileSync(soulPath, "utf-8") };
	} catch {
		return undefined;
	}
}

/**
 * Load the long-term memory *index* only (`_index.md`).
 *
 * The full memory files are NOT loaded into the prompt — the agent reads them on
 * demand via the file tools. Before returning, the index is reconciled with the
 * actual contents of the memory directory:
 *  - files present on disk but missing from the index get an "(unindexed)" note
 *  - index entries pointing at missing files get a "(stale)" note
 */
export function loadLongTermMemory(memoryDir: string): MemoryEntry[] {
	if (!existsSync(memoryDir)) {
		return [];
	}

	const indexPath = join(memoryDir, "_index.md");
	let indexContent = "";
	if (existsSync(indexPath)) {
		try {
			indexContent = readFileSync(indexPath, "utf-8");
		} catch {
			indexContent = "";
		}
	}

	const memoryFiles = listMemoryFiles(memoryDir);
	const reconciled = reconcileIndex(indexContent, memoryFiles);

	return [{ path: indexPath, content: reconciled }];
}

function listMemoryFiles(memoryDir: string): string[] {
	try {
		return readdirSync(memoryDir)
			.filter((name) => {
				if (name === "_index.md") return false;
				if (!name.endsWith(".md")) return false;
				try {
					return statSync(join(memoryDir, name)).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}

/**
 * Append consistency notes to the raw index content so the agent always sees an
 * accurate picture of the memory directory even if `_index.md` drifted.
 */
function reconcileIndex(indexContent: string, memoryFiles: string[]): string {
	const listedFiles = new Set<string>();
	for (const match of indexContent.matchAll(/([A-Za-z0-9._-]+\.md)/g)) {
		listedFiles.add(basename(match[1]));
	}

	const unindexed = memoryFiles.filter((file) => !listedFiles.has(file));
	const stale = [...listedFiles].filter(
		(file) => file !== "_index.md" && !memoryFiles.includes(file),
	);

	let result = indexContent.trimEnd();
	if (unindexed.length > 0 || stale.length > 0) {
		result += "\n\n<!-- consistency check (auto-generated) -->";
		for (const file of unindexed) {
			result += `\n- ${file} (unindexed)`;
		}
		for (const file of stale) {
			result += `\n- ${file} (stale — listed but not found on disk)`;
		}
	}

	return result.length > 0 ? `${result}\n` : "";
}

/** Guidelines appended to the system prompt when running as the main agent. */
export function getMainAgentGuidelines(memoryDir: string): string[] {
	return [
		"You are a persistent agent: your identity lives in the Identity section and your long-term memory index is in the Long-Term Memory section of this prompt.",
		"Before starting a new topic, review the relevant long-term memory; the index is in the prompt, read the specific memory file with the read command when you need details.",
		`When you learn a stable fact about the user, write it to the appropriate file under ${memoryDir} (create a new file for a new topic and add it to _index.md).`,
		`When you notice outdated or inaccurate information in memory, update or delete the corresponding file under ${memoryDir} and keep _index.md in sync.`,
		"Memory you write during a session is loaded into the system prompt at the next session boundary (after session_split), not immediately.",
		"You can delegate a task to a sub-agent in another project directory by running the pizza CLI, e.g. `pizza --cwd /path/to/project -p \"fix the auth bug in login.ts\"`; keep that project's context out of this conversation.",
	];
}

// ── Single-instance lockfile ───────────────────────────────────────────────

export interface MainAgentLock {
	release(): void;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH = no such process; EPERM = exists but not ours (treat as alive)
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Acquire a best-effort single-instance lock for the main agent.
 * Returns a lock handle on success, or null if another live instance holds it.
 * A stale lock (owning process no longer alive) is reclaimed automatically.
 */
export function acquireMainLock(mainDir: string): MainAgentLock | null {
	mkdirSync(mainDir, { recursive: true });
	const lockPath = join(mainDir, ".lock");

	if (existsSync(lockPath)) {
		let ownerPid = NaN;
		try {
			ownerPid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		} catch {
			ownerPid = NaN;
		}
		if (!Number.isNaN(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
			return null;
		}
	}

	try {
		writeFileSync(lockPath, String(process.pid), "utf-8");
	} catch {
		return null;
	}

	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		try {
			const current = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
			if (current === process.pid) {
				rmSync(lockPath, { force: true });
			}
		} catch {
			// ignore
		}
	};

	const onExit = (): void => release();
	process.once("exit", onExit);

	return { release };
}
