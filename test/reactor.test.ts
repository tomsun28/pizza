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
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { IntentClassifier } from "../src/core/intent/classifier.js";
import { Reactor } from "../src/core/runtime/reactor.js";
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

	function makeBashRegistry(): ToolRegistry {
		return {
			get(name: string): ToolExecutor | undefined {
				if (name !== "bash") return undefined;
				return {
					async execute(args) {
						return { content: [{ type: "text", text: String(args.command ?? "") }], is_error: false };
					},
					getMetadata() {
						return { name: "bash", category: "shell_moderate", defaultRisk: "moderate" };
					},
				};
			},
			list() {
				return ["bash"];
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

	it("passes tool execution context through the runtime and emits updates", async () => {
		const cwd = makeTempDir();
		let receivedToolCallId: string | undefined;
		let receivedSignal: AbortSignal | undefined;
		const registry: ToolRegistry = {
			get(name: string): ToolExecutor | undefined {
				if (name !== "echo") return undefined;
				return {
					async execute(args, options) {
						receivedToolCallId = options?.tool_call_id;
						receivedSignal = options?.signal;
						options?.onUpdate?.({
							content: [{ type: "text", text: `partial ${String(args.text ?? "")}` }],
						});
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

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "call_update", name: "echo", arguments: { text: "hello" } } as ContentBlock,
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
			classifierConfig: { require_approval_unknown: false },
			systemPrompt: "test system",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("please echo hello");

		const updates = runtime.store.query({ types: ["TOOL_EXECUTION_UPDATE"] });
		expect(receivedToolCallId).toBe("call_update");
		expect(receivedSignal).toBeInstanceOf(AbortSignal);
		expect(updates).toHaveLength(1);
		expect((updates[0].payload as { tool_call_id: string; update: string }).tool_call_id).toBe("call_update");
		expect((updates[0].payload as { tool_call_id: string; update: string }).update).toBe("partial hello");

		runtime.dispose();
	});

	it("executes legacy camelCase toolCall blocks returned by a provider", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();
		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "toolCall", id: "call_legacy", name: "echo", arguments: { text: "hello" } } as any,
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
			systemPrompt: "test system",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("please echo hello");

		expect(calls).toBe(2);
		expect(runtime.store.query({ types: ["INTENT_TOOL_CALL"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);

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

	it("executes dev-null redirected shell lookups in a parallel tool batch", async () => {
		const cwd = makeTempDir();
		const registry = makeBashRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "c1", name: "bash", arguments: { command: "ls -la .claude/" } } as ContentBlock,
							{ type: "tool_call", id: "c2", name: "bash", arguments: { command: "ls -la .crush/" } } as ContentBlock,
							{
								type: "tool_call",
								id: "c3",
								name: "bash",
								arguments: {
									command: "which zai-cli 2>/dev/null; type zai-cli 2>/dev/null; npm list -g 2>/dev/null | grep -i zai",
								},
							} as ContentBlock,
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

		await runtime.prompt("run three shell lookups");

		const intents = runtime.store.query({ types: ["INTENT_TOOL_CALL"] });
		expect(intents).toHaveLength(3);
		expect((intents[2].payload as { requires_approval: boolean }).requires_approval).toBe(false);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_START"] })).toHaveLength(3);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(3);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);
		expect(calls).toBe(2);

		runtime.dispose();
	});

	it("does not hang when approval is required without an approval handler", async () => {
		const cwd = makeTempDir();
		const registry = makeBashRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "danger", name: "bash", arguments: { command: "sudo whoami" } } as ContentBlock,
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

		await runtime.prompt("run dangerous command");

		const starts = runtime.store.query({ types: ["TOOL_EXECUTION_START"] });
		const ends = runtime.store.query({ types: ["TOOL_EXECUTION_END"] });
		expect(starts).toHaveLength(0);
		expect(ends).toHaveLength(1);
		expect((ends[0].payload as { is_error: boolean }).is_error).toBe(true);
		expect(JSON.stringify((ends[0].payload as { result: unknown }).result)).toContain("no approval handler");
		expect(runtime.store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);
		expect(calls).toBe(2);

		runtime.dispose();
	});

	it("aggregates completed tools by tool_call_id when causal chain is unavailable", async () => {
		const cwd = makeTempDir();
		const store = new SqliteEventStore("reactor-causality-fallback", ":memory:");
		const registry = makeRegistry();
		const reactor = new Reactor({
			store,
			projection: {} as any,
			llmClient: { async complete() { throw new Error("not used"); } },
			classifier: new IntentClassifier({ approve_writes: false, approve_edits: false, approve_shell_moderate: false, approve_unknown: false }),
			toolRegistry: registry,
			runtimeAdapter: {
				runtime_id: "test_runtime",
				workspace_id: store.workspace_id,
				kind: "local",
				async executeTool() {
					return { content: [{ type: "text", text: "not used" }], is_error: false };
				},
				async createCheckpoint() {
					return { id: "checkpoint", label: "checkpoint", runtime_id: "test_runtime", created_at: Date.now(), metadata: {} };
				},
				async restoreCheckpoint() {},
				async getStatus() {
					return { runtime_id: "test_runtime", workspace_id: store.workspace_id, kind: "local", cwd, status: "idle" };
				},
			},
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			contextBudget: 128000,
			tools: [],
		});

		const assistantEnd = store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [
					{ type: "tool_call", id: "missing_chain_1", name: "echo", arguments: { text: "a" } },
					{ type: "tool_call", id: "missing_chain_2", name: "echo", arguments: { text: "b" } },
				],
				model: { provider: "test", model_id: "test" },
				usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
				stop_reason: "tool_use",
			},
		});

		await (reactor as any)._onAgentMessageEnd(assistantEnd);

		const firstResult = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "missing_chain_1",
				tool_name: "echo",
				result: [{ type: "text", text: "a" }],
				is_error: false,
			},
		});
		const secondResult = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "missing_chain_2",
				tool_name: "echo",
				result: [{ type: "text", text: "b" }],
				is_error: false,
			},
		});

		await (reactor as any)._onToolExecutionEnd(firstResult);
		await (reactor as any)._onToolExecutionEnd(secondResult);

		expect(store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })).toHaveLength(1);
		const aggregated = store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })[0];
		expect((aggregated.payload as { tool_call_count: number }).tool_call_count).toBe(2);

		store.close();
	});
});
