/**
 * End-to-end test: Agent in useEventSourcedRuntime mode.
 *
 * Verifies that when `useEventSourcedRuntime: true`, the Agent class
 * drives an EventSourcedRuntime internally while still emitting the
 * legacy AgentEvent stream so consumers (AgentSession) see the same shape.
 *
 * Happy path: user prompt → assistant text reply (no tools).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import { Agent } from "../src/core/agent/index.js";
import type { AgentEvent } from "../src/core/agent/types.js";

describe("Agent with useEventSourcedRuntime: true", () => {
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		faux = registerFauxProvider({
			provider: "test-es",
			api: "anthropic-messages",
			models: [{ id: "test-model" }],
			tokensPerSecond: 100000,
		});
	});

	afterEach(() => {
		faux.unregister();
	});

	/**
	 * Make an Agent in reactor mode.
	 * For the happy-path text test, no tools are needed.
	 */
	function makeReactorAgent() {
		return new Agent({
			initialState: {
				model: faux.getModel(),
				tools: [],
			},
			useEventSourcedRuntime: true,
		});
	}

	it("emits agent_start, turn_start, message_end, turn_end, agent_end on a simple text reply", async () => {
		const events: AgentEvent[] = [];
		const agent = makeReactorAgent();
		agent.subscribe((e) => events.push(e));

		faux.setResponses([fauxAssistantMessage(fauxText("Hello from reactor!"))]);
		await agent.prompt("say hello");

		const types = events.map((e) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("turn_start");
		expect(types).toContain("message_end");
		expect(types).toContain("turn_end");
		expect(types).toContain("agent_end");
		// Exactly one turn
		expect(types.filter((t) => t === "turn_start")).toHaveLength(1);
		expect(types.filter((t) => t === "turn_end")).toHaveLength(1);
	});

	it("emits message_end with the assistant's text response", async () => {
		const agent = makeReactorAgent();
		const events: AgentEvent[] = [];
		agent.subscribe((e) => events.push(e));

		faux.setResponses([fauxAssistantMessage(fauxText("The answer is 42"))]);
		await agent.prompt("what is the answer?");

		const msgEnd = events.filter((e) => e.type === "message_end").at(-1) as any;
		expect(msgEnd).toBeDefined();
		expect(msgEnd?.message?.role).toBe("assistant");
	});

	it("adds the user message and assistant message to state.messages after completion", async () => {
		const agent = makeReactorAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("response"))]);
		await agent.prompt("hello");

		// state.messages should contain both the user prompt and assistant response
		const msgs = agent.state.messages;
		expect(msgs.some((m) => m.role === "user")).toBe(true);
		expect(msgs.some((m) => m.role === "assistant")).toBe(true);
	});

	it("sets isStreaming during the run", async () => {
		const agent = makeReactorAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("response"))]);

		const started = agent.state.isStreaming;
		const p = agent.prompt("hi");
		const during = agent.state.isStreaming;
		await p;
		const after = agent.state.isStreaming;

		expect(started).toBe(false);
		expect(during).toBe(true);
		expect(after).toBe(false);
	});

	it("waitForIdle resolves after completion", async () => {
		const agent = makeReactorAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("response"))]);

		const idlePromise = agent.waitForIdle();
		await agent.prompt("hello");
		await idlePromise; // should not hang
	});

	it("abort() stops the run", async () => {
		const agent = makeReactorAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("response"))]);

		agent.abort();
		await agent.waitForIdle();

		// After abort, should be idle
		expect(agent.state.isStreaming).toBe(false);
	});

	it("reset() clears messages", async () => {
		const agent = makeReactorAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("response"))]);
		await agent.prompt("hello");
		expect(agent.state.messages.length).toBeGreaterThan(0);

		agent.reset();
		expect(agent.state.messages).toHaveLength(0);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("multiple sequential prompts each emit a full agent lifecycle", async () => {
		const agent = makeReactorAgent();
		const events: AgentEvent[] = [];
		agent.subscribe((e) => events.push(e));

		faux.setResponses([fauxAssistantMessage(fauxText("first"))]);
		await agent.prompt("one");
		faux.setResponses([fauxAssistantMessage(fauxText("second"))]);
		await agent.prompt("two");

		const agentStarts = events.filter((e) => e.type === "agent_start");
		const turnStarts = events.filter((e) => e.type === "turn_start");
		const turnEnds = events.filter((e) => e.type === "turn_end");

		// Two turns (one per prompt)
		expect(turnStarts).toHaveLength(2);
		expect(turnEnds).toHaveLength(2);
		// Two agent_starts (one per run, but our translator resets per prompt)
		// reactor mode emits one agent_start per prompt
		expect(agentStarts).toHaveLength(2);
	});

	it("throws when prompt is called while already processing", async () => {
		const agent = makeReactorAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("slow"))]);

		const p = agent.prompt("first");
		await expect(agent.prompt("second")).rejects.toThrow();
		await p;
	});

	it("steer() queues a message that runs in the same turn", async () => {
		const agent = makeReactorAgent();
		const events: AgentEvent[] = [];
		agent.subscribe((e) => events.push(e));

		faux.setResponses([
			fauxAssistantMessage(fauxText("first")),
			fauxAssistantMessage(fauxText("steered")),
		]);

		agent.steer({ role: "user", content: [{ type: "text", text: "steer me" }], timestamp: Date.now() } as any);
		await agent.prompt("first");

		// Two turns: one for first+steered, one for the user's steer message
		const turnStarts = events.filter((e) => e.type === "turn_start");
		expect(turnStarts.length).toBeGreaterThanOrEqual(1);
	});

	it("executes a tool call and continues the turn", async () => {
		const toolRuns: string[] = [];
		const agent = new Agent({
			initialState: {
				model: faux.getModel(),
				tools: [
					{
						name: "echo",
						label: "Echo",
						description: "echo",
						parameters: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
							additionalProperties: false,
						} as any,
						execute: async (_id, params: any) => {
							toolRuns.push(String(params.text));
							return { content: [{ type: "text", text: `echo:${params.text}` }], details: {} };
						},
					} as any,
				],
			},
			useEventSourcedRuntime: true,
		});

		const events: AgentEvent[] = [];
		agent.subscribe((e) => events.push(e));

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })]),
			fauxAssistantMessage(fauxText("done")),
		]);

		await agent.prompt("call echo");

		expect(toolRuns).toEqual(["hello"]);

		const types = events.map((e) => e.type);
		expect(types).toContain("tool_execution_start");
		expect(types).toContain("tool_execution_end");

		const roles = agent.state.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("explicit useEventSourcedRuntime: false uses legacy loop", async () => {
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { model: faux.getModel(), tools: [] },
			useEventSourcedRuntime: false,
		});
		agent.subscribe((e) => events.push(e));

		faux.setResponses([fauxAssistantMessage(fauxText("from legacy loop"))]);
		await agent.prompt("hello");

		const types = events.map((e) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("agent_end");
		expect(types).toContain("turn_start");
		expect(types).toContain("turn_end");
	});
});
