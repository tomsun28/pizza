import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { deriveWorkspaceId, getSessionIndexPath } from "../src/core/event-store/workspace.js";
import type { EventBase } from "../src/core/event-store/types.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";
import { main } from "../src/main.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			this.push({ type: "start", partial: { ...message, content: [] } });
			this.push({ type: "done", reason: "stop", message });
		});
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "facade-test",
		model: "facade-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("main print facade route", () => {
	const tempDirs: string[] = [];
	const originalCwd = process.cwd();
	const originalEnvAgentDir = process.env[ENV_AGENT_DIR];
	const originalOffline = process.env.PI_OFFLINE;
	const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalEnvAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalEnvAgentDir;
		}
		if (originalOffline === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = originalOffline;
		}
		if (stdinIsTtyDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		}
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-main-print-facade-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function captureStdout(): string[] {
		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk, encodingOrCallback, callback) => {
			chunks.push(String(chunk));
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}) as typeof process.stdout.write);
		return chunks;
	}

	function createProject(): { agentDir: string; projectDir: string } {
		const tempDir = makeTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PI_OFFLINE = "1";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		process.chdir(projectDir);
		return { agentDir, projectDir: process.cwd() };
	}

	function createFacadeProviderExtension(
		responses: string[],
		seenContexts?: Context[],
	): (pi: ExtensionAPI) => void {
		return (pi: ExtensionAPI) => {
			pi.registerProvider("facade-test", {
				baseUrl: "https://example.invalid",
				apiKey: "test-key",
				api: "anthropic-messages",
				streamSimple: (_model, context) => {
					seenContexts?.push(context);
					return new MockAssistantStream(createAssistantMessage(responses.shift() ?? "facade fallback"));
				},
				models: [
					{
						id: "facade-model",
						name: "Facade Model",
						api: "anthropic-messages",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 64000,
						maxTokens: 1024,
					},
				],
			});
		};
	}

	function readSessionIndex(agentDir: string, cwd = process.cwd()): Array<{
		session_id: string;
		created_by?: string;
		parent_session_id?: string;
	}> {
		const workspaceId = deriveWorkspaceId(cwd);
		const index = JSON.parse(readFileSync(getSessionIndexPath(workspaceId, agentDir), "utf8")) as {
			sessions: Array<{ session_id: string; created_by?: string; parent_session_id?: string }>;
		};
		return index.sessions;
	}

	function readOnlySessionId(agentDir: string, cwd = process.cwd()): string {
		const sessions = readSessionIndex(agentDir, cwd);
		expect(sessions).toHaveLength(1);
		return sessions[0]!.session_id;
	}

	it("routes simple --mode json --no-session runs through SessionFacade typed events", async () => {
		createProject();
		const stdout = captureStdout();

		await main(["--mode", "json", "--no-session", "--model", "facade-test/facade-model", "hello"], {
			extensionFactories: [createFacadeProviderExtension(["facade route ok"])],
		});

		const events = stdout.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventBase);
		expect(events.every((event) => typeof event.event_id === "string" && typeof event.sequence === "number")).toBe(true);
		expect(events.map((event) => event.type)).toContain("USER_MESSAGE");
		expect(events.map((event) => event.type)).toContain("AGENT_MESSAGE_END");
		expect(events.find((event) => event.type === "AGENT_MESSAGE_END")?.payload).toMatchObject({
			stop_reason: "stop",
		});
		expect(events.some((event) => event.type === "session")).toBe(false);
	});

	it("opens an explicit projection session in print/json facade mode", async () => {
		const { agentDir } = createProject();
		const stdout = captureStdout();
		const seenContexts: Context[] = [];

		await main(["--mode", "json", "--model", "facade-test/facade-model", "first"], {
			extensionFactories: [createFacadeProviderExtension(["first response"], seenContexts)],
		});

		const sessionId = readOnlySessionId(agentDir);
		stdout.length = 0;

		await main(["--mode", "json", "--session", sessionId, "--model", "facade-test/facade-model", "second"], {
			extensionFactories: [createFacadeProviderExtension(["second response"], seenContexts)],
		});

		expect(seenContexts).toHaveLength(2);
		expect(seenContexts[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(seenContexts[1]!.messages[0]).toMatchObject({ role: "user", content: "first" });
		expect(seenContexts[1]!.messages[1]).toMatchObject({ role: "assistant" });
		expect(seenContexts[1]!.messages[2]).toMatchObject({ role: "user", content: "second" });

		const events = stdout.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventBase);
		expect(events.map((event) => event.type)).toContain("AGENT_MESSAGE_END");
		expect(events.some((event) => event.type === "session")).toBe(false);
	});

	it("continues the active projection session in print/json facade mode", async () => {
		createProject();
		const stdout = captureStdout();
		const seenContexts: Context[] = [];

		await main(["--mode", "json", "--model", "facade-test/facade-model", "first"], {
			extensionFactories: [createFacadeProviderExtension(["first response"], seenContexts)],
		});

		stdout.length = 0;

		await main(["--mode", "json", "--continue", "--model", "facade-test/facade-model", "second"], {
			extensionFactories: [createFacadeProviderExtension(["second response"], seenContexts)],
		});

		expect(seenContexts).toHaveLength(2);
		expect(seenContexts[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(seenContexts[1]!.messages[0]).toMatchObject({ role: "user", content: "first" });
		expect(seenContexts[1]!.messages[2]).toMatchObject({ role: "user", content: "second" });
	});

	it("forks a local projection session in print/json facade mode", async () => {
		const { agentDir } = createProject();
		const stdout = captureStdout();
		const seenContexts: Context[] = [];

		await main(["--mode", "json", "--model", "facade-test/facade-model", "first"], {
			extensionFactories: [createFacadeProviderExtension(["first response"], seenContexts)],
		});

		const sessionId = readOnlySessionId(agentDir);
		stdout.length = 0;

		await main(["--mode", "json", "--fork", sessionId, "--model", "facade-test/facade-model", "fork prompt"], {
			extensionFactories: [createFacadeProviderExtension(["fork response"], seenContexts)],
		});

		expect(seenContexts).toHaveLength(2);
		expect(seenContexts[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(seenContexts[1]!.messages[0]).toMatchObject({ role: "user", content: "first" });
		expect(seenContexts[1]!.messages[2]).toMatchObject({ role: "user", content: "fork prompt" });

		const sessions = readSessionIndex(agentDir);
		expect(sessions).toHaveLength(2);
		expect(sessions.find((session) => session.created_by === "fork")).toMatchObject({
			parent_session_id: sessionId,
		});
	});

	it("forks a projection session from another project into the current project", async () => {
		const { agentDir, projectDir } = createProject();
		const stdout = captureStdout();
		const seenContexts: Context[] = [];

		await main(["--mode", "json", "--model", "facade-test/facade-model", "first"], {
			extensionFactories: [createFacadeProviderExtension(["first response"], seenContexts)],
		});

		const sourceSessionId = readOnlySessionId(agentDir, projectDir);
		const targetProjectDir = join(makeTempDir(), "target-project");
		mkdirSync(targetProjectDir, { recursive: true });
		process.chdir(targetProjectDir);
		const targetProjectCwd = process.cwd();
		stdout.length = 0;

		await main(["--mode", "json", "--fork", sourceSessionId, "--model", "facade-test/facade-model", "fork prompt"], {
			extensionFactories: [createFacadeProviderExtension(["fork response"], seenContexts)],
		});

		expect(seenContexts).toHaveLength(2);
		expect(seenContexts[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(seenContexts[1]!.messages[0]).toMatchObject({ role: "user", content: "first" });
		expect(seenContexts[1]!.messages[2]).toMatchObject({ role: "user", content: "fork prompt" });

		const targetSessions = readSessionIndex(agentDir, targetProjectCwd);
		expect(targetSessions).toHaveLength(1);
		expect(targetSessions[0]).toMatchObject({
			created_by: "fork",
			parent_session_id: sourceSessionId,
		});
	});

	it("stores print/json facade sessions under --session-dir", async () => {
		createProject();
		const customAgentDir = join(makeTempDir(), "custom-agent");
		const customSessionDir = join(customAgentDir, "sessions");
		captureStdout();

		await main([
			"--mode",
			"json",
			"--session-dir",
			customSessionDir,
			"--model",
			"facade-test/facade-model",
			"custom storage",
		], {
			extensionFactories: [createFacadeProviderExtension(["stored in custom dir"])],
		});

		expect(readOnlySessionId(customAgentDir)).toMatch(/^sess_/);
	});
});
