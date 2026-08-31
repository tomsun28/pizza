/**
 * Regression tests for three concurrency/correctness fixes:
 *
 * 1. Idle /compact: COMPACTION_REQUESTED appended while no reactor is alive
 *    used to be recorded and silently never handled. runtime.compact() now
 *    runs the compaction inline (START → policy → END/ABORTED).
 * 2. _waitUntilSettled is scoped to the prompt's thread: another thread's
 *    USER_MESSAGE must not keep a completed prompt waiting forever.
 * 3. subscribe({ after }) matches by resolved sequence, not by event_id
 *    string ordering (which only worked for uuidv7 ids).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import type { CompactionPolicy } from "../src/core/runtime/policies.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { EventBase } from "../src/core/event-store/types.js";

const emptyRegistry: ToolRegistry = { get: () => undefined, list: () => [] };

const stopClient: LLMClient = {
	async complete(): Promise<LLMResponse> {
		return {
			content: [{ type: "text", text: "ok" }],
			usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
			stopReason: "stop",
		};
	},
};

describe("runtime concurrency fixes", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-rcfix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function makeStubPolicy(calls: string[], outcome?: Partial<{ fail: boolean }>): CompactionPolicy {
		return {
			estimateContextTokens: () => 0,
			contextWindow: () => 128000,
			threshold: () => 0.85,
			async compact(reason) {
				calls.push(reason);
				if (outcome?.fail) throw new Error("stub compaction failure");
				return { summary: "stub summary", first_kept_event_id: "", tokens_before: 100, tokens_after: 10 };
			},
			isOverflow: () => false,
		};
	}

	it("idle compact() runs the compaction inline and emits START/END", async () => {
		const cwd = makeTempDir();
		const calls: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: emptyRegistry, llmClient: stopClient,
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
			compactionPolicy: makeStubPolicy(calls),
		});

		// No reactor alive — this used to be a silent no-op.
		runtime.compact({ reason: "manual" });
		await runtime.waitForIdle();

		expect(calls).toEqual(["manual"]);
		expect(runtime.store.query({ types: ["COMPACTION_START"] })).toHaveLength(1);
		const ends = runtime.store.query({ types: ["COMPACTION_END"] });
		expect(ends).toHaveLength(1);
		expect((ends[0].payload as { summary: string }).summary).toBe("stub summary");
		runtime.dispose();
	});

	it("idle compact() failure emits COMPACTION_ABORTED(reason=error), never a fake END", async () => {
		const cwd = makeTempDir();
		const calls: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: emptyRegistry, llmClient: stopClient,
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
			compactionPolicy: makeStubPolicy(calls, { fail: true }),
		});

		runtime.compact({ reason: "manual" });
		await runtime.waitForIdle();

		expect(runtime.store.query({ types: ["COMPACTION_END"] })).toHaveLength(0);
		const aborted = runtime.store.query({ types: ["COMPACTION_ABORTED"] });
		expect(aborted).toHaveLength(1);
		expect((aborted[0].payload as { reason: string }).reason).toBe("error");
		runtime.dispose();
	});

	it("a second idle compact() while one is running does not start a duplicate", async () => {
		const cwd = makeTempDir();
		const calls: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: emptyRegistry, llmClient: stopClient,
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
			compactionPolicy: makeStubPolicy(calls),
		});

		runtime.compact({ reason: "manual" });
		runtime.compact({ reason: "manual" });
		await runtime.waitForIdle();

		expect(calls).toEqual(["manual"]);
		expect(runtime.store.query({ types: ["COMPACTION_START"] })).toHaveLength(1);
		runtime.dispose();
	});

	it("prompt settles even when another thread appends a later USER_MESSAGE", async () => {
		const cwd = makeTempDir();
		const store = new SqliteEventStore("rcfix-threads", ":memory:");
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, store, threadId: "thread_A",
			toolRegistry: emptyRegistry, llmClient: stopClient,
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});

		// Simulate another thread's traffic arriving mid-turn: a USER_MESSAGE
		// tagged thread_B with a HIGHER sequence than thread_A's completion.
		// Under the old global settled check this prompt would hang forever.
		const unsub = store.subscribe(
			() => {
				store.append({
					actor_id: "user",
					type: "USER_MESSAGE",
					payload: { content: "other thread noise" },
					thread_id: "thread_B",
				});
			},
			{ types: ["AGENT_TURN_END"] },
		);

		await expect(
			Promise.race([
				runtime.prompt("hello from thread A"),
				new Promise((_, reject) => setTimeout(() => reject(new Error("prompt hung: settled check not thread-scoped")), 3000)),
			]),
		).resolves.toBeUndefined();

		unsub();
		runtime.dispose();
	});

	it("subscribe({ after }) delivers by sequence even for non-uuidv7 event ids", () => {
		const store = new SqliteEventStore("rcfix-after", ":memory:");
		// Ids deliberately in REVERSE lexicographic order: zzz > aaa as strings,
		// so the old string comparison (event_id <= after) would wrongly drop
		// the second event.
		const first = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "1" }, event_id: "zzz-first" });
		const received: EventBase[] = [];
		store.subscribe((event) => received.push(event), { after: first.event_id });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "2" }, event_id: "aaa-second" });

		expect(received).toHaveLength(1);
		expect(received[0].event_id).toBe("aaa-second");
		store.close();
	});
});