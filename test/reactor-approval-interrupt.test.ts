/**
 * Regression test: interrupting while a tool call awaits approval.
 *
 * The reactor parks an unresolved promise in `_pendingApprovals` while safe mode
 * waits for the user to approve a risky tool call. That map used to be drained
 * only by USER_APPROVAL / USER_REJECTION, so a USER_INTERRUPT arriving first
 * left the promise pending forever: `_onIntentToolCall` never returned, its turn
 * tracker never completed, and the turn hung with no way to recover.
 *
 * The reactor must now reject any in-flight approval on interrupt (and on stop),
 * so the turn always settles.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { LLMClient } from "../src/core/runtime/llm-types.js";
import type { ToolExecutor, ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock, EventBase } from "../src/core/event-store/types.js";

describe("Reactor — approval pending across interrupt", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-approval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	/** A tool that must never run — approval is never granted in these tests. */
	function makeRegistry(onExecute: () => void): ToolRegistry {
		return {
			get(name: string): ToolExecutor | undefined {
				if (name !== "write") return undefined;
				return {
					async execute() {
						onExecute();
						return { content: [{ type: "text", text: "written" }], is_error: false };
					},
					getMetadata() {
						return { name: "write", category: "file_write", defaultRisk: "moderate" };
					},
				};
			},
			list() {
				return ["write"];
			},
		};
	}

	/** Emits one risky tool call, then a plain stop on any later turn. */
	function makeClient(): LLMClient {
		let calls = 0;
		return {
			async complete() {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{
								type: "toolCall",
								id: "call_write",
								name: "write",
								arguments: { path: "notes.txt", content: "hi" },
							} as unknown as ContentBlock,
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
	}

	function makeRuntime(cwd: string, registry: ToolRegistry): EventSourcedRuntime {
		return new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: makeClient(),
			// safe_mode: true → the file_write call blocks awaiting approval.
			classifierConfig: { safe_mode: true },
			// A handler that never answers — this is what parks the promise in
			// _pendingApprovals. Without a handler the reactor rejects immediately
			// and the hang being tested here could never occur.
			approvalHandler: { requestApproval: () => {}, cancelApproval: () => {} },
			systemPrompt: "test system",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});
	}

	it("settles the turn when the user interrupts instead of approving", async () => {
		const cwd = makeTempDir();
		let executed = false;
		const runtime = makeRuntime(cwd, makeRegistry(() => { executed = true; }));

		// Interrupt as soon as the approval gate is reached. Fire once, and stop
		// listening immediately so a queued callback cannot outlive dispose().
		let unsubscribed = false;
		const unsubscribe = runtime.store.subscribe((event: EventBase) => {
			if (event.type !== "INTENT_TOOL_CALL" || unsubscribed) return;
			unsubscribed = true;
			unsubscribe();
			setImmediate(() => runtime.abort());
		});

		// Must not hang. Before the fix this promise never resolved.
		await expect(
			Promise.race([
				runtime.prompt("write a file"),
				new Promise((_, rejectRace) =>
					setTimeout(() => rejectRace(new Error("turn hung waiting for approval")), 5000),
				),
			]),
		).resolves.not.toThrow();

		// The gated tool must never have run.
		expect(executed).toBe(false);

		// The interrupted call is reported as rejected, so the log stays consistent
		// (a START/END pair) rather than leaving a dangling INTENT_TOOL_CALL.
		const ends = runtime.store.query({ types: ["TOOL_EXECUTION_END"] });
		expect(ends).toHaveLength(1);
		expect((ends[0].payload as { is_error: boolean }).is_error).toBe(true);

		runtime.dispose();
	});

	it("does not execute a tool whose approval was still pending at stop()", async () => {
		const cwd = makeTempDir();
		let executed = false;
		const runtime = makeRuntime(cwd, makeRegistry(() => { executed = true; }));

		let unsubscribed = false;
		const unsubscribe = runtime.store.subscribe((event: EventBase) => {
			if (event.type !== "INTENT_TOOL_CALL" || unsubscribed) return;
			unsubscribed = true;
			unsubscribe();
			setImmediate(() => runtime.dispose());
		});

		await Promise.race([
			runtime.prompt("write a file").catch(() => undefined),
			new Promise((resolveRace) => setTimeout(resolveRace, 3000)),
		]);

		expect(executed).toBe(false);
	});
});