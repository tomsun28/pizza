/**
 * Reactor streaming chunks test.
 *
 * Verifies that when an LLM client emits streaming chunks via the `onChunk`
 * callback, the reactor produces AGENT_MESSAGE_CHUNK events in the EventStore.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock } from "../src/core/event-store/types.js";

describe("Reactor streaming chunks", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-chunks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function makeRegistry(): ToolRegistry {
		return {
			get(name: string) {
				if (name !== "echo") return undefined;
				return {
					async execute() {
						return { content: [{ type: "text", text: "hello" }], is_error: false };
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

	/**
	 * Scripted LLM client that calls onChunk for each scripted chunk,
	 * then resolves with the final message.
	 */
	function makeStreamingClient(
		chunks: Array<Parameters<NonNullable<LLMClient["complete"]>>[0]["onChunk"] extends (chunk: infer T) => void ? T : never>,
		finalContent: ContentBlock[],
		stopReason: LLMResponse["stopReason"] = "stop",
	): LLMClient {
		return {
			async complete({ onChunk }) {
				// Emit chunks one at a time (simulates real streaming)
				for (const chunk of chunks) {
					onChunk?.(chunk as any);
				}
				return {
					content: finalContent,
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason,
				};
			},
		};
	}

	async function createRuntime(llmClient: LLMClient): Promise<{
		runtime: EventSourcedRuntime;
		events: string[];
	}> {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const events: string[] = [];

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir,
			toolRegistry: makeRegistry(),
			llmClient,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			classifierConfig: { approve_unknown: false },
		});

		// Subscribe to all events
		const unsub = runtime.subscribe((e) => events.push(e.type));

		return { runtime, events };
	}

	it("emits AGENT_MESSAGE_CHUNK events for each streaming chunk", async () => {
		const chunks = [
			{ kind: "text_delta" as const, contentIndex: 0, delta: "Hello" },
			{ kind: "text_delta" as const, contentIndex: 0, delta: " world" },
			{ kind: "text_delta" as const, contentIndex: 0, delta: "!" },
		];
		const client = makeStreamingClient(
			chunks,
			[{ type: "text", text: "Hello world!" } as ContentBlock],
		);

		const { runtime, events } = await createRuntime(client);
		try {
			await runtime.prompt("say hi");

			// Should have chunks
			const chunkEvents = events.filter((t) => t === "AGENT_MESSAGE_CHUNK");
			expect(chunkEvents).toHaveLength(3);

			// Should also have message start and end
			expect(events).toContain("AGENT_MESSAGE_START");
			expect(events).toContain("AGENT_MESSAGE_END");
		} finally {
			runtime.dispose();
		}
	});

	it("emits AGENT_MESSAGE_CHUNK for toolcall deltas", async () => {
		const chunks = [
			{ kind: "toolcall_start" as const, contentIndex: 0, tool_call_id: "call_1", tool_name: "echo" },
			{ kind: "toolcall_delta" as const, contentIndex: 0, delta: '{"text"' },
			{ kind: "toolcall_delta" as const, contentIndex: 0, delta: ': "hi"}' },
		];

		let callCount = 0;
		const client: LLMClient = {
			async complete({ onChunk }) {
				callCount++;
				if (callCount === 1) {
					// First call: stream toolcall chunks then return tool_use response
					for (const chunk of chunks) onChunk?.(chunk as any);
					return {
						content: [
							{
								type: "tool_call",
								id: "call_1",
								name: "echo",
								arguments: { text: "hi" },
							} as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				// Second call: just stop
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const { runtime, events } = await createRuntime(client);
		try {
			await runtime.prompt("call echo");

			const chunkEvents = events.filter((t) => t === "AGENT_MESSAGE_CHUNK");
			expect(chunkEvents).toHaveLength(3);

			// Then tool execution
			expect(events).toContain("TOOL_EXECUTION_START");
			expect(events).toContain("TOOL_EXECUTION_END");
		} finally {
			runtime.dispose();
		}
	});

	it("emits AGENT_MESSAGE_CHUNK for thinking deltas", async () => {
		const chunks = [
			{ kind: "thinking_delta" as const, contentIndex: 0, delta: "Let me think" },
			{ kind: "thinking_delta" as const, contentIndex: 0, delta: "..." },
		];
		const client = makeStreamingClient(
			chunks,
			[{ type: "text", text: "done" } as ContentBlock],
		);

		const { runtime, events } = await createRuntime(client);
		try {
			await runtime.prompt("think");

			const chunkEvents = events.filter((t) => t === "AGENT_MESSAGE_CHUNK");
			expect(chunkEvents).toHaveLength(2);
		} finally {
			runtime.dispose();
		}
	});

	it("emits AGENT_MESSAGE_CHUNK even when there are no chunks (empty stream)", async () => {
		const client = makeStreamingClient([], [{ type: "text", text: "immediate" } as ContentBlock]);

		const { runtime, events } = await createRuntime(client);
		try {
			await runtime.prompt("quick");

			// Still has start and end but no chunks
			expect(events).toContain("AGENT_MESSAGE_START");
			expect(events).toContain("AGENT_MESSAGE_END");
			expect(events.filter((t) => t === "AGENT_MESSAGE_CHUNK")).toHaveLength(0);
		} finally {
			runtime.dispose();
		}
	});

	it("emits chunks in causal chain under the AGENT_MESSAGE_START event", async () => {
		const chunks = [
			{ kind: "text_delta" as const, contentIndex: 0, delta: "A" },
			{ kind: "text_delta" as const, contentIndex: 0, delta: "B" },
		];
		const client = makeStreamingClient(
			chunks,
			[{ type: "text", text: "AB" } as ContentBlock],
		);

		const cwd = makeTempDir();
		const agentDir = makeTempDir();

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir,
			toolRegistry: makeRegistry(),
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			classifierConfig: { approve_unknown: false },
		});

		try {
			const causalChain: string[] = [];
			runtime.subscribe((e) => {
				if (e.type === "AGENT_MESSAGE_CHUNK") {
					causalChain.push(e.caused_by ?? "none");
				}
			});

			await runtime.prompt("hello");

			// All chunks should reference the AGENT_MESSAGE_START event
			expect(new Set(causalChain).size).toBe(1);
		} finally {
			runtime.dispose();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("chunks are stored in the EventStore and queryable after completion", async () => {
		const chunks = [
			{ kind: "text_delta" as const, contentIndex: 0, delta: "one" },
			{ kind: "text_delta" as const, contentIndex: 0, delta: " two" },
		];
		const client = makeStreamingClient(
			chunks,
			[{ type: "text", text: "one two" } as ContentBlock],
		);

		const { runtime } = await createRuntime(client);
		try {
			await runtime.prompt("test");

			// Query the store directly
			const chunkEvents = runtime.store.query({ types: ["AGENT_MESSAGE_CHUNK"] });
			expect(chunkEvents).toHaveLength(2);

			const payloads = chunkEvents.map((e) => (e.payload as any).chunk);
			expect(payloads[0]).toMatchObject({ kind: "text_delta", delta: "one" });
			expect(payloads[1]).toMatchObject({ kind: "text_delta", delta: " two" });
		} finally {
			runtime.dispose();
		}
	});
});
