/**
 * Mid-turn USER_MESSAGE must not start a concurrent reactor turn.
 *
 * Regression: a scheduler/cron prompt appended a raw USER_MESSAGE while a
 * long-running tool was executing (bypassing runtime.prompt(), which would
 * have rejected with "already processing"). The reactor's USER_MESSAGE
 * handler unconditionally started a second turn, interleaving two turns in
 * one thread: the first turn's TOOL_EXECUTION_END landed after other turns'
 * messages, permanently breaking tool_use → tool_result adjacency for strict
 * providers (Anthropic/Bedrock 400 "unexpected tool_use_id") and wedging the
 * session overnight.
 *
 * The contract now: USER_MESSAGE mid-turn is durably queued
 * (USER_FOLLOWUP_QUEUED referencing the raw message) and delivered as a turn
 * after the current turn completes — with no duplicate USER_MESSAGE in the
 * context.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock } from "../src/core/event-store/types.js";

describe("reactor mid-turn user message serialization", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-interleave-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	it("queues a raw USER_MESSAGE that lands mid-tool and answers it after the turn settles", async () => {
		const cwd = makeTempDir();
		// Tool that blocks until we release it, then reports how it finished.
		let release: (() => void) | undefined;
		const toolGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry: ToolRegistry = {
			get(name: string) {
				if (name !== "cli") return undefined;
				return {
					async execute() {
						await toolGate;
						return { content: [{ type: "text", text: "tool done" }], is_error: false };
					},
					getMetadata() {
						return { name: "cli", category: "shell_moderate", defaultRisk: "moderate" };
					},
				};
			},
			list() {
				return ["cli"];
			},
		};

		// Scripted LLM: call 1 → tool_use; call 2 (after tool result) → stop;
		// call 3 (the queued mid-turn message) → stop.
		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					const content: ContentBlock[] = [
						{ type: "tool_call", id: "call_slow", name: "cli", arguments: { command: "sleep" } } as ContentBlock,
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
					content: [{ type: "text", text: `reply-${calls}` } as ContentBlock],
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
			systemPrompt: "test",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		// Drive the first prompt; while the tool is blocked, append a raw
		// USER_MESSAGE straight to the store (the cron failure mode).
		const firstTurn = runtime.prompt("start slow tool");
		await new Promise((r) => setTimeout(r, 150)); // let the turn reach the tool
		const toolStarts = runtime.store.query({ types: ["TOOL_EXECUTION_START"] });
		expect(toolStarts).toHaveLength(1); // the tool is running
		runtime.store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "status update please" },
		});
		await new Promise((r) => setTimeout(r, 100));

		// No second turn may have started while the tool is still running.
		let turnRequests = runtime.store.query({ types: ["AGENT_TURN_REQUESTED"] });
		expect(turnRequests).toHaveLength(1); // only the initial one
		// The message was durably queued.
		const queued = runtime.store.query({ types: ["USER_FOLLOWUP_QUEUED"] });
		expect(queued).toHaveLength(1);
		expect((queued[0].payload as { user_message_event_id?: string }).user_message_event_id).toBeDefined();

		release!(); // finish the tool
		await firstTurn;

		// After the turn settles, the queued message is answered: a turn runs
		// for it WITHOUT appending a duplicate USER_MESSAGE.
		await new Promise((r) => setTimeout(r, 250));
		turnRequests = runtime.store.query({ types: ["AGENT_TURN_REQUESTED"] });
		expect(turnRequests.length).toBeGreaterThanOrEqual(2);
		const userMessages = runtime.store.query({ types: ["USER_MESSAGE"] });
		expect(userMessages).toHaveLength(2); // the prompt + the raw one — no delivery duplicate
		expect(calls).toBe(3); // initial + tool-result + queued message
		// And the context built from the log is well-formed (sanitizer aside,
		// nothing was interleaved in the first place).
		const projection = runtime.getProjection();
		const roles = projection.buildContext().messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant", "assistant"]);

		runtime.dispose();
	});
});