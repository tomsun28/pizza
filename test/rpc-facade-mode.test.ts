import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import type { ContentBlock, EventBase } from "../src/core/event-store/types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SessionFacade } from "../src/core/session-facade.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { runRpcModeWithFacade } from "../packages/rpc/rpc-mode.js";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../packages/tui/theme/theme.js", () => ({ theme: {} }));

vi.mock("../packages/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const tempDirs: string[] = [];

const emptyRegistry: ToolRegistry = {
	get: () => undefined,
	list: () => [],
};

function makeTempDir(): string {
	const dir = join(tmpdir(), `pizza-rpc-facade-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function makeTextResponse(text: string): LLMResponse {
	return {
		content: [{ type: "text", text } as ContentBlock],
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
		stopReason: "stop",
	};
}

function createFacade(client?: LLMClient, modelRegistry?: ModelRegistry): SessionFacade {
	const cwd = makeTempDir();
	const store = new SqliteEventStore(`rpc-facade-${Date.now()}`, join(cwd, "events.sqlite"));
	const sessionManager = new SessionManager(store, store);
	sessionManager.createSession("user_explicit", "Initial");
	const runtime = new EventSourcedRuntime({
		cwd,
		agentDir: cwd,
		store,
		sessionManager,
		toolRegistry: emptyRegistry,
		llmClient: client ?? {
			async complete(): Promise<LLMResponse> {
				return makeTextResponse("rpc facade done");
			},
		},
		systemPrompt: "rpc facade test",
		model: { provider: "test", model_id: "test-model" },
		tools: [],
	});
	return new SessionFacade({
		runtime,
		settingsManager: SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test-model" }),
		modelRegistry,
		disposers: [() => store.close()],
	});
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runRpcModeWithFacade", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	it("emits command responses and typed events over JSONL", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(JSON.stringify({ id: "state-1", type: "get_state" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "state-1",
					type: "response",
					command: "get_state",
					success: true,
				}),
			);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(() => {
			const records = parseOutputLines();
			expect(records).toContainEqual(
				expect.objectContaining({
					id: "prompt-1",
					type: "response",
					command: "prompt",
					success: true,
				}),
			);
			const eventTypes = records
				.filter((record) => typeof record.event_id === "string")
				.map((record) => (record as unknown as EventBase).type);
			expect(eventTypes).toContain("USER_MESSAGE");
			expect(eventTypes).toContain("AGENT_MESSAGE_END");
			expect(eventTypes).toContain("AGENT_TURN_COMPLETED");
		});

		facade.dispose();
	});

	it("handles projection-backed session and settings commands", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		const user = facade.runtime.store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "fork me" },
		});
		facade.runtime.store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [
					{ type: "text", text: "done" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
				],
				model: { provider: "test", model_id: "test-model" },
				usage: { input: 10, output: 20, cache_read: 3, cache_write: 4, total: 37, cost: 0.5 },
				stop_reason: "stop",
			},
		});
		facade.runtime.store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "call-1",
				tool_name: "read",
				result: [{ type: "text", text: "file" }],
				is_error: false,
				duration_ms: 1,
			},
		});

		rpcIo.lineHandler!(JSON.stringify({ id: "stats-1", type: "get_session_stats" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "stats-1",
					type: "response",
					command: "get_session_stats",
					success: true,
					data: expect.objectContaining({
						userMessages: 1,
						assistantMessages: 1,
						toolCalls: 1,
						toolResults: 1,
						totalMessages: 3,
						tokens: expect.objectContaining({ input: 10, output: 20, cacheRead: 3, cacheWrite: 4, total: 37 }),
						cost: 0.5,
					}),
				}),
			);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "fork-messages-1", type: "get_fork_messages" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "fork-messages-1",
					type: "response",
					command: "get_fork_messages",
					success: true,
					data: { messages: [{ entryId: user.event_id, text: "fork me" }] },
				}),
			);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "autocompact-1", type: "set_auto_compaction", enabled: false }));
		rpcIo.lineHandler!(JSON.stringify({ id: "state-2", type: "get_state" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "state-2",
					type: "response",
					command: "get_state",
					success: true,
					data: expect.objectContaining({ autoCompactionEnabled: false }),
				}),
			);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "fork-1", type: "fork", entryId: user.event_id }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "fork-1",
					type: "response",
					command: "fork",
					success: true,
					data: { text: "fork me", cancelled: false },
				}),
			);
		});

		facade.dispose();
	});

	it("cycles models through the facade model registry", async () => {
		const models = [
			{ provider: "test", id: "test-model", name: "Test Model" },
			{ provider: "test", id: "next-model", name: "Next Model" },
		];
		const modelRegistry = {
			getAvailable: () => models,
			find: (provider: string, modelId: string) => models.find((model) => model.provider === provider && model.id === modelId),
		} as unknown as ModelRegistry;
		const facade = createFacade(undefined, modelRegistry);
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(JSON.stringify({ id: "cycle-1", type: "cycle_model" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "cycle-1",
					type: "response",
					command: "cycle_model",
					success: true,
					data: expect.objectContaining({
						model: models[1],
						thinkingLevel: "off",
						isScoped: false,
					}),
				}),
			);
		});
		expect(facade.model).toMatchObject({ provider: "test", model_id: "next-model" });

		facade.dispose();
	});
});
