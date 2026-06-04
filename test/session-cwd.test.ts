import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "../src/core/session-cwd.js";
import { SessionManager } from "../src/core/session-manager.js";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("session cwd handling", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("detects missing session cwd from persisted sessions", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-fallback");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const agentDir = createTempDir("pi-session-cwd-agent-dir");
		cleanupPaths.push(fallbackCwd, agentDir);

		const created = SessionManager.create(missingCwd, agentDir);
		const sessionManager = SessionManager.open(created.getSessionFile()!, agentDir);
		const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
		expect(issue).toEqual({
			sessionFile: sessionManager.getSessionFile(),
			sessionCwd: missingCwd,
			fallbackCwd,
		});
	});

	it("supports overriding the effective cwd when opening a session", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-override");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const agentDir = createTempDir("pi-session-cwd-override-agent-dir");
		cleanupPaths.push(fallbackCwd, agentDir);

		const created = SessionManager.create(missingCwd, agentDir);
		const sessionManager = SessionManager.open(created.getSessionFile()!, agentDir, fallbackCwd);
		expect(sessionManager.getCwd()).toBe(fallbackCwd);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toBeUndefined();
	});

	it("throws a controlled error before runtime creation when the stored cwd is missing", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-runtime");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const agentDir = createTempDir("pi-session-cwd-runtime-agent-dir");
		cleanupPaths.push(fallbackCwd, agentDir);

		const created = SessionManager.create(missingCwd, agentDir);
		const sessionManager = SessionManager.open(created.getSessionFile()!, agentDir);
		let createRuntimeCalled = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			createRuntimeCalled = true;
			throw new Error("should not be called");
		};

		await expect(
			createAgentSessionRuntime(createRuntime, {
				cwd: fallbackCwd,
				agentDir: fallbackCwd,
				sessionManager,
			}),
		).rejects.toBeInstanceOf(MissingSessionCwdError);
		expect(createRuntimeCalled).toBe(false);
	});
});
