/**
 * Reactor end-to-end test.
 *
 * Verifies that a USER_MESSAGE drives the reactor through the full event chain:
 *   USER_MESSAGE → AGENT_TURN_REQUESTED → LLM_CALL_REQUESTED → AGENT_MESSAGE_END
 *     → INTENT_TOOL_CALL → TOOL_EXECUTION_END → TOOL_RESULTS_AGGREGATED
 *     → AGENT_TURN_REQUESTED → LLM_CALL_REQUESTED → AGENT_MESSAGE_END (stop)
 *     → AGENT_TURN_COMPLETED
 *
 * No while-loop is involved — the chain is driven entirely by EventStore subscriptions.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { ToolExecutor, ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock } from "../src/core/event-store/types.js";

describe("Reactor (event-driven core)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-reactor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function makeRegistry(): ToolRegistry {
		return {
			get(name: string): ToolExecutor | undefined {
				if (name !== "echo") return undefined;
				return {
					async execute(args) {
						return { content: [{ type: "text", text: String(args.text ?? "") }], is_error: false };
					},
					getMetadata() {
						return { name: "echo", category: "file_read", defaultRisk: "safe" };
					},
				};
			},
			list() {
				return ["echo"];
			},
		};
	}

	/** Scripted LLM client: first call returns a tool_use, second call returns a stop. */
	function makeScriptedClient(): { client: LLMClient; callCount: () => number } {
		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					const content: ContentBlock[] = [
						{ type: "tool_call", id: "call_1", name: "echo", arguments: { text: "hello" } } as ContentBlock,
					];
					return {
						content,
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};
		return { client, callCount: () => calls };
	}

	it("drives a complete turn purely through events (no while-loop)", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();
		const { client, callCount } = makeScriptedClient();

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "test system",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("please echo hello");

		// LLM should have been called twice: once with tool_use, once with stop
		expect(callCount()).toBe(2);

		expect(runtime.store.query({ types: ["USER_MESSAGE"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_REQUESTED"] })).toHaveLength(2); // initial + after tool results
		expect(runtime.store.query({ types: ["LLM_CALL_REQUESTED"] })).toHaveLength(2);
		expect(runtime.store.query({ types: ["INTENT_TOOL_CALL"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })[0];
		expect((completed.payload as { reason: string }).reason).toBe("stop");

		runtime.dispose();
	});

	it("emits AGENT_TURN_COMPLETED immediately when LLM returns stop on first call", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				return {
					content: [{ type: "text", text: "hi" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("hi");

		expect(runtime.store.query({ types: ["INTENT_TOOL_CALL"] })).toHaveLength(0);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);
		runtime.dispose();
	});

	it("classifies LLM failures and emits LLM_CALL_FAILED → eventually completes with error", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();

		// Always fail with a non-retryable error
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				throw new Error("permanent auth failure");
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("hello");

		const failed = runtime.store.query({ types: ["LLM_CALL_FAILED"] });
		expect(failed).toHaveLength(1);
		expect((failed[0].payload as { retryable: boolean }).retryable).toBe(false);

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		expect((completed[0].payload as { reason: string }).reason).toBe("error");

		runtime.dispose();
	});

	it("aggregates parallel tool calls before requesting the next turn", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "c1", name: "echo", arguments: { text: "a" } } as ContentBlock,
							{ type: "tool_call", id: "c2", name: "echo", arguments: { text: "b" } } as ContentBlock,
							{ type: "tool_call", id: "c3", name: "echo", arguments: { text: "c" } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("run three");

		expect(runtime.store.query({ types: ["INTENT_TOOL_CALL"] })).toHaveLength(3);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(3);
		expect(runtime.store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })).toHaveLength(1);

		const aggregated = runtime.store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })[0];
		expect((aggregated.payload as { tool_call_count: number }).tool_call_count).toBe(3);
		expect((aggregated.payload as { any_error: boolean }).any_error).toBe(false);

		runtime.dispose();
	});
});
