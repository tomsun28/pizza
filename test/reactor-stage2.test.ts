/**
 * Reactor stage-2 tests — retry policy + compaction + follow-up queue.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { CompactionOutcome, CompactionPolicy, RetryPolicy } from "../src/core/runtime/policies.js";
import type { ToolExecutor, ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock, EventBase } from "../src/core/event-store/types.js";

describe("Reactor stage-2: policies + queues", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-reactor2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	const emptyRegistry: ToolRegistry = {
		get: () => undefined,
		list: () => [],
	};

	// ────────────────────────────────────────────────────────────────────────
	// Retry policy
	// ────────────────────────────────────────────────────────────────────────

	it("retries retryable errors per policy and eventually succeeds", async () => {
		const cwd = makeTempDir();
		let calls = 0;

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls < 3) throw new Error("overloaded_error: please retry");
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		// Custom retry policy: 5 attempts, 1ms delay
		const retryPolicy: RetryPolicy = {
			maxAttempts: 5,
			isRetryable: (e) => /overloaded/i.test(e.message),
			nextDelayMs: () => 1,
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			retryPolicy,
		});

		await runtime.prompt("hi");

		expect(calls).toBe(3);
		const failed = runtime.store.query({ types: ["LLM_CALL_FAILED"] });
		expect(failed).toHaveLength(2); // 2 failures before the 3rd success
		const scheduled = runtime.store.query({ types: ["RETRY_SCHEDULED"] });
		expect(scheduled).toHaveLength(2);
		expect((scheduled[0].payload as { attempt: number }).attempt).toBe(1);
		expect((scheduled[1].payload as { attempt: number }).attempt).toBe(2);

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		expect((completed[0].payload as { reason: string }).reason).toBe("stop");

		runtime.dispose();
	});

	it("gives up after maxAttempts and completes with error", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				throw new Error("overloaded_error");
			},
		};

		const retryPolicy: RetryPolicy = {
			maxAttempts: 2,
			isRetryable: () => true,
			nextDelayMs: () => 1,
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			retryPolicy,
		});

		await runtime.prompt("hi");

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		const payload = completed[0].payload as { reason: string; error_message?: string };
		expect(payload.reason).toBe("error");
		expect(payload.error_message).toMatch(/Max retries \(2\) exceeded/);

		runtime.dispose();
	});

	// ────────────────────────────────────────────────────────────────────────
	// Follow-up queue
	// ────────────────────────────────────────────────────────────────────────

	it("processes follow-up messages after the current turn completes", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];

		const client: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				const last = req.messages[req.messages.length - 1];
				if (last.role === "user") {
					const c = typeof last.content === "string" ? last.content : "?";
					seen.push(c);
				}
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
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
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		// Queue follow-up BEFORE the prompt — both should run in sequence
		// Note: the followUp event needs to be emitted via store.append since the
		// runtime API doesn't expose followUp() yet (that's reactor-level).
		runtime.store.append({
			actor_id: "user",
			type: "USER_FOLLOWUP_QUEUED",
			payload: { content: "second message" },
		});

		await runtime.prompt("first message");

		// Both turns should have completed
		expect(seen).toEqual(["first message", "second message"]);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(2);

		runtime.dispose();
	});

	// ────────────────────────────────────────────────────────────────────────
	// Compaction policy
	// ────────────────────────────────────────────────────────────────────────

	it("emits COMPACTION_REQUESTED when threshold exceeded after a turn", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 5000, output: 1000, cache_read: 0, cache_write: 0, total: 6000, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		let compactCalled = false;
		const compactionPolicy: CompactionPolicy = {
			estimateContextTokens: () => 9000, // above threshold
			contextWindow: () => 10000,
			threshold: () => 0.8,
			isOverflow: () => false,
			async compact(): Promise<CompactionOutcome> {
				compactCalled = true;
				return { first_kept_event_id: "evt_summary", summary: "compacted", tokens_before: 9000, tokens_after: 500 };
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			compactionPolicy,
		});

		await runtime.prompt("hi");
		// Compaction is async; wait a tick
		await new Promise((r) => setTimeout(r, 50));

		const requested = runtime.store.query({ types: ["COMPACTION_REQUESTED"] });
		expect(requested).toHaveLength(1);
		expect((requested[0].payload as { reason: string }).reason).toBe("threshold");

		const ended = runtime.store.query({ types: ["COMPACTION_END"] });
		expect(ended).toHaveLength(1);
		expect((ended[0].payload as { summary: string }).summary).toBe("compacted");
		expect(compactCalled).toBe(true);

		runtime.dispose();
	});

	it("emits COMPACTION_REQUESTED with reason=overflow when policy.isOverflow returns true", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				return {
					content: [],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "error",
					errorMessage: "context_length_exceeded",
				};
			},
		};

		const compactionPolicy: CompactionPolicy = {
			estimateContextTokens: () => 50000,
			contextWindow: () => 10000,
			threshold: () => 0.85,
			isOverflow: (evt: EventBase | undefined) => {
				const p = evt?.payload as { error_message?: string } | undefined;
				return !!p?.error_message?.includes("context_length_exceeded");
			},
			async compact(): Promise<CompactionOutcome> {
				return { first_kept_event_id: "x", summary: "ok", tokens_before: 50000, tokens_after: 100 };
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			compactionPolicy,
		});

		await runtime.prompt("hi");
		await new Promise((r) => setTimeout(r, 50));

		const requested = runtime.store.query({ types: ["COMPACTION_REQUESTED"] });
		expect(requested).toHaveLength(1);
		expect((requested[0].payload as { reason: string }).reason).toBe("overflow");

		runtime.dispose();
	});
});
