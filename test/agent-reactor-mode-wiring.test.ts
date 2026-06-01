/**
 * Integration test: Agent in reactor mode correctly wires steer/followUp/abort
 * to the EventSourcedRuntime.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fauxAssistantMessage,
	fauxText,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import { Agent } from "../src/core/agent/index.js";
import type { AgentEvent } from "../src/core/agent/types.js";

describe("Agent reactor mode — steer/followUp/abort wiring", () => {
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		faux = registerFauxProvider({
			provider: "test-wiring",
			api: "anthropic-messages",
			models: [{ id: "test-model" }],
			tokensPerSecond: 100000,
		});
	});

	afterEach(() => {
		faux.unregister();
	});

	function makeAgent() {
		return new Agent({
			initialState: {
				model: faux.getModel(),
				tools: [],
			},
			useEventSourcedRuntime: true,
		});
	}

	it("steer() queues locally without throwing when no runtime is active", () => {
		const agent = makeAgent();

		// steer() called when no runtime is active — should NOT throw
		expect(() => {
			agent.steer({ role: "user", content: [{ type: "text", text: "redirect" }], timestamp: Date.now() } as any);
		}).not.toThrow();

		// The message should be in the local queue
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("followUp() queues locally without throwing when no runtime is active", () => {
		const agent = makeAgent();

		expect(() => {
			agent.followUp({ role: "user", content: [{ type: "text", text: "later" }], timestamp: Date.now() } as any);
		}).not.toThrow();

		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("waitForIdle resolves after the run completes", async () => {
		faux.setResponses([fauxAssistantMessage(fauxText("hello"))]);

		const agent = makeAgent();

		const idlePromise = agent.waitForIdle();
		if (!idlePromise) throw new Error("waitForIdle returned null — no activeRun");

		await agent.prompt("hi");
		await idlePromise; // should resolve without hanging

		// After completion, should be idle
		expect(agent.state.isStreaming).toBe(false);
	});

	it("reset() clears queued messages in reactor mode", () => {
		const agent = makeAgent();

		agent.steer({ role: "user", content: [{ type: "text", text: "s1" }], timestamp: Date.now() } as any);
		agent.followUp({ role: "user", content: [{ type: "text", text: "f1" }], timestamp: Date.now() } as any);

		expect(agent.hasQueuedMessages()).toBe(true);

		agent.reset();

		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("abort() during a streaming response propagates the abort signal to the LLM call", async () => {
		let abortObserved = false;
		faux.setResponses([
			async (_ctx, opts) => {
				if (opts?.signal) {
					opts.signal.addEventListener("abort", () => { abortObserved = true; });
				}
				await new Promise((r) => setTimeout(r, 50));
				return fauxAssistantMessage(fauxText("done"));
			},
		]);

		const agent = makeAgent();

		const promptPromise = agent.prompt("hello");
		await new Promise((r) => setTimeout(r, 10));
		agent.abort();
		await promptPromise.catch(() => {});

		expect(abortObserved).toBe(true);
	});
});
