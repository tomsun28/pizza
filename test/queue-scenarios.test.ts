/**
 * Queued-prompt scenarios (steer / followUp / abort semantics):
 *  A. followUp queued mid-turn (tool round running) is delivered only after the whole turn completes
 *  B. two queued follow-ups are delivered sequentially, one turn each
 *  C. abort drops a follow-up queued during an in-flight turn (USER_FOLLOWUP_DROPPED recorded)
 *  D. followUp queued in the idle window right after turn completion is delivered immediately (no hang)
 *  E. steer in the idle window starts a fresh turn immediately (no stranded queue)
 *  F. steer mid-flight interrupts the turn and is delivered right after the abort settles
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { ToolExecutor, ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock, EventBase, EventType } from "../src/core/event-store/types.js";

describe("Queued prompt scenarios", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function makeEchoRegistry(): ToolRegistry {
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
			list() { return ["echo"]; },
		};
	}

	function waitForEvent(runtime: EventSourcedRuntime, type: EventType, timeoutMs = 2000): Promise<EventBase> {
		const existing = runtime.store.query({ types: [type], reverse: true, limit: 1 })[0];
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
			const unsubscribe = runtime.subscribe((event) => {
				if (event.type !== type) return;
				clearTimeout(timeout);
				unsubscribe();
				resolve(event);
			}, { types: [type] });
		});
	}

	/** Round 1 of "first message" calls echo; every other round returns text. */
	function makeClient(seen: string[], opts?: { hangRound2UntilAbort?: boolean }): LLMClient {
		return {
			async complete(req): Promise<LLMResponse> {
				// Identify the turn by the LAST user message in the context.
				let lastUserText = "";
				for (let i = req.messages.length - 1; i >= 0; i--) {
					const m = req.messages[i] as { role: string; content?: unknown };
					if (m.role === "user") { lastUserText = String(m.content ?? ""); break; }
				}
				const hasToolResult = req.messages.some((m) => (m as { role?: string }).role === "tool" || (m as { role?: string }).role === "toolResult");
				// Only the first LLM call of the "first message" turn is identified by the
				// pending tool-less context; push it once we see it.
				const isFirstTurnFirstCall = lastUserText.includes("first") && !hasToolResult;
				if (isFirstTurnFirstCall && !seen.includes("first message")) seen.push("first message");
				else if (!isFirstTurnFirstCall && lastUserText && !seen.includes(lastUserText)) seen.push(lastUserText);
				if (isFirstTurnFirstCall) {
					return {
						content: [{ type: "tool_call", id: "t1", name: "echo", arguments: { text: "tool-result" } } as unknown as ContentBlock],
						provider: "test", model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				// The tool-results round of the "first message" turn can hang until abort.
				if (opts?.hangRound2UntilAbort && lastUserText.includes("first") && hasToolResult) {
					await new Promise<void>((resolve) => {
						if (req.signal?.aborted) return resolve();
						req.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					throw new Error("aborted");
				}
				return {
					content: [{ type: "text", text: `done:${lastUserText.slice(0, 10)}` } as ContentBlock],
					provider: "test", model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};
	}

	it("A: followUp queued mid-turn is delivered only after the whole turn completes", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: makeEchoRegistry(), llmClient: makeClient(seen),
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});

		const p = runtime.prompt("first message");
		await waitForEvent(runtime, "TOOL_EXECUTION_END");
		runtime.followUp("queued message");
		await p;

		expect(seen).toEqual(["first message", "queued message"]);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(2);
		runtime.dispose();
	});

	it("B: two queued follow-ups are delivered sequentially, one turn each", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: makeEchoRegistry(), llmClient: makeClient(seen),
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});

		const p = runtime.prompt("first message");
		await waitForEvent(runtime, "TOOL_EXECUTION_END");
		runtime.followUp("queued 1");
		await waitForEvent(runtime, "LLM_CALL_REQUESTED");
		runtime.followUp("queued 2");
		await p;

		expect(seen).toEqual(["first message", "queued 1", "queued 2"]);
		runtime.dispose();
	});

	it("C: abort drops a follow-up queued during an in-flight turn", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: makeEchoRegistry(),
			llmClient: makeClient(seen, { hangRound2UntilAbort: true }),
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});

		const p = runtime.prompt("first message");
		await waitForEvent(runtime, "LLM_CALL_REQUESTED"); // round 2 is hanging on the abort signal
		runtime.followUp("queued then dropped");
		expect(runtime.pendingFollowUps).toHaveLength(1);
		runtime.abort();
		await p;

		const dropped = runtime.store.query({ types: ["USER_FOLLOWUP_DROPPED"] });
		expect(dropped).toHaveLength(1);
		const ids = (dropped[0].payload as { dropped_event_ids: string[] }).dropped_event_ids;
		const queued = runtime.store.query({ types: ["USER_FOLLOWUP_QUEUED"] })[0];
		expect(ids).toContain(queued.event_id);
		expect(seen).toEqual(["first message"]); // queued never delivered
		runtime.dispose();
	});

	it("D: followUp queued in the idle window after turn completion is delivered immediately (no hang)", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: makeEchoRegistry(), llmClient: makeClient(seen),
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});

		const p = runtime.prompt("first message");
		// Resolve on the *microtask* boundary right after TOOL_EXECUTION_END so the followUp
		// can land in the window between turn completion and the settled check (used to deadlock).
		await new Promise<void>((resolve) => {
			const un = runtime.subscribe((e) => {
				if (e.type === "TOOL_EXECUTION_END") { un(); resolve(); }
			});
		});
		runtime.followUp("queued message");

		const settled = await Promise.race([
			p.then(() => "resolved"),
			new Promise((r) => setTimeout(() => r("HUNG"), 3000)),
		]);
		expect(settled).toBe("resolved");
		expect(seen).toEqual(["first message", "queued message"]);
		runtime.dispose();
	});

	it("E: steer in the idle window starts a fresh turn immediately (no stranded queue)", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: makeEchoRegistry(), llmClient: makeClient(seen),
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});

		const p = runtime.prompt("first message");
		await new Promise<void>((resolve) => {
			const un = runtime.subscribe((e) => {
				if (e.type === "TOOL_EXECUTION_END") { un(); resolve(); }
			});
		});
		runtime.steer("steered message");

		const settled = await Promise.race([
			p.then(() => "resolved"),
			new Promise((r) => setTimeout(() => r("HUNG"), 3000)),
		]);
		expect(settled).toBe("resolved");
		// The steer content must run as its own turn (delivered, not stranded).
		expect(seen).toEqual(["first message", "steered message"]);
		runtime.dispose();
	});

	it("F: steer mid-flight interrupts the turn and is delivered right after the abort settles", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: makeEchoRegistry(),
			llmClient: makeClient(seen, { hangRound2UntilAbort: true }),
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});

		const p = runtime.prompt("first message");
		await waitForEvent(runtime, "LLM_CALL_REQUESTED"); // round 2 hanging
		runtime.steer("steer mid-flight");
		await p;

		// Round 2 was aborted; the steer content ran as its own turn afterwards.
		expect(seen).toEqual(["first message", "steer mid-flight"]);
		const completions = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completions).toHaveLength(2);
		expect(completions[0].payload).toMatchObject({ reason: "aborted" });
		expect(completions[1].payload).toMatchObject({ reason: "stop" });
		runtime.dispose();
	});
});
