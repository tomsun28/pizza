/**
 * Unit tests for the pizza-owned Agent class (src/core/agent/).
 *
 * Tests core behaviors: lifecycle events, subscription, queueing,
 * tool execution, abort, and reset.
 *
 * Uses pi-ai's faux provider for deterministic LLM responses.
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
import type { AgentEvent, AgentMessage, AgentTool } from "../src/core/agent/types.js";

describe("Agent", () => {
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		faux = registerFauxProvider({
			provider: "test-agent",
			api: "anthropic-messages",
			models: [{ id: "test-model" }],
			tokensPerSecond: 100000,
		});
		faux.setResponses([]);
	});

	afterEach(() => {
		faux.unregister();
	});

	const userMsg = (text: string): AgentMessage =>
		({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as AgentMessage;

	const makeAgent = (extra?: { tools?: AgentTool[] }) =>
		new Agent({
			initialState: {
				model: faux.getModel(),
				tools: (extra?.tools as any) ?? [],
			},
		});

	// ─── Lifecycle Events ─────────────────────────────────────────────────────

	it("emits agent_start, turn_start, message_end, turn_end, agent_end on a simple prompt", async () => {
		const events: AgentEvent[] = [];
		const agent = makeAgent();
		agent.subscribe((e) => events.push(e));

		faux.setResponses([fauxAssistantMessage(fauxText("Hello, world!"))]);
		await agent.prompt("hi");

		const types = events.map((e) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("turn_start");
		expect(types).toContain("message_end");
		expect(types).toContain("turn_end");
		expect(types).toContain("agent_end");
		// Exactly one turn for a simple response
		expect(types.filter((t) => t === "turn_start").length).toBe(1);
		expect(types.filter((t) => t === "turn_end").length).toBe(1);
	});

	it("emits tool_execution_start/end when assistant produces tool calls", async () => {
		const events: AgentEvent[] = [];
		const agent = makeAgent({
			tools: [
				{
					name: "bash",
					description: "Run a bash command",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
						additionalProperties: false,
					} as any,
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				} as any,
			],
		});
		agent.subscribe((e) => events.push(e));

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })]),
			fauxAssistantMessage(fauxText("ok")),
		]);

		await agent.prompt("run a command");

		const types = events.map((e) => e.type);
		expect(types).toContain("tool_execution_start");
		expect(types).toContain("tool_execution_end");
	});

	it("sets isStreaming=true while processing, false after completion", async () => {
		const agent = makeAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("response"))]);

		expect(agent.state.isStreaming).toBe(false);
		const prompt = agent.prompt("hi");
		expect(agent.state.isStreaming).toBe(true);
		await prompt;
		expect(agent.state.isStreaming).toBe(false);
	});

	// ─── Subscription ──────────────────────────────────────────────────────────

	it("subscribe returns an unsubscribe function", async () => {
		const agent = makeAgent();
		const events: AgentEvent[] = [];

		faux.setResponses([fauxAssistantMessage(fauxText("a")), fauxAssistantMessage(fauxText("b"))]);
		const unsub = agent.subscribe((e) => events.push(e));
		await agent.prompt("hi");
		const countBefore = events.length;
		expect(countBefore).toBeGreaterThan(0);

		unsub();
		await agent.prompt("hi again");
		expect(events.length).toBe(countBefore);
	});

	it("subscribes multiple listeners and calls all", async () => {
		const agent = makeAgent();
		const eventsA: AgentEvent[] = [];
		const eventsB: AgentEvent[] = [];

		faux.setResponses([fauxAssistantMessage(fauxText("reply"))]);

		agent.subscribe((e) => eventsA.push(e));
		agent.subscribe((e) => eventsB.push(e));
		await agent.prompt("hi");

		expect(eventsA.length).toBe(eventsB.length);
		expect(eventsA.length).toBeGreaterThan(0);
		expect(eventsA.map((e) => e.type)).toEqual(eventsB.map((e) => e.type));
	});

	// ─── Queueing ───────────────────────────────────────────────────────────

	it("hasQueuedMessages() reflects queue state", async () => {
		const agent = makeAgent();
		expect(agent.hasQueuedMessages()).toBe(false);
		agent.steer(userMsg("x"));
		expect(agent.hasQueuedMessages()).toBe(true);
		agent.clearAllQueues();
		expect(agent.hasQueuedMessages()).toBe(false);
		agent.followUp(userMsg("x"));
		expect(agent.hasQueuedMessages()).toBe(true);
		agent.clearAllQueues();
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("followUp() messages are processed in same run when agent would otherwise stop", async () => {
		const events: AgentEvent[] = [];
		const agent = makeAgent();
		agent.subscribe((e) => events.push(e));

		// Two responses queued; second is for the followup
		faux.setResponses([
			fauxAssistantMessage(fauxText("first")),
			fauxAssistantMessage(fauxText("second")),
		]);

		// Queue followup BEFORE prompting so the loop picks it up after first turn
		agent.followUp(userMsg("followup"));
		await agent.prompt("first");

		// Should have two turn_end events
		const turnEnds = events.filter((e) => e.type === "turn_end");
		expect(turnEnds.length).toBe(2);
	});

	// ─── Abort ───────────────────────────────────────────────────────────────

	it("abort() stops the active run and clears isStreaming", async () => {
		const agent = makeAgent();
		// Slow faux so we have time to abort
		faux.setResponses([fauxAssistantMessage(fauxText("slow response"))]);

		const promptPromise = agent.prompt("hi");
		expect(agent.state.isStreaming).toBe(true);
		agent.abort();
		await promptPromise;
		await agent.waitForIdle();

		expect(agent.state.isStreaming).toBe(false);
	});

	// ─── Reset ───────────────────────────────────────────────────────────────

	it("reset() clears messages, queues, and runtime state", async () => {
		const agent = makeAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("response"))]);

		await agent.prompt("hi");
		expect(agent.state.messages.length).toBeGreaterThan(0);

		agent.steer(userMsg("queued"));
		expect(agent.hasQueuedMessages()).toBe(true);

		agent.reset();
		expect(agent.state.messages).toEqual([]);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	// ─── State Mutation ───────────────────────────────────────────────────────

	it("state.tools assignment copies the array", () => {
		const agent = makeAgent();
		const tool: AgentTool = {
			name: "test-tool",
			description: "test",
			parameters: { type: "object", properties: {}, additionalProperties: false } as any,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};

		const input = [tool] as any[];
		agent.state.tools = input;
		expect(agent.state.tools).toHaveLength(1);
		expect(agent.state.tools).not.toBe(input); // copied
	});

	it("state.model is set from initialState", () => {
		const agent = makeAgent();
		expect((agent.state.model as any)?.id).toBe("test-model");
	});

	// ─── Prompt Input Normalization ───────────────────────────────────────────

	it("prompt() accepts string input and converts to user message", async () => {
		const events: AgentEvent[] = [];
		const agent = makeAgent();
		agent.subscribe((e) => events.push(e));

		faux.setResponses([fauxAssistantMessage(fauxText("reply"))]);
		await agent.prompt("hello");

		const userMsgs = events.filter(
			(e) => e.type === "message_end" && (e as any).message.role === "user",
		);
		expect(userMsgs.length).toBeGreaterThan(0);
	});

	it("prompt() accepts AgentMessage array input", async () => {
		const agent = makeAgent();
		faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		await agent.prompt([userMsg("array input")]);
		expect(agent.state.messages.length).toBeGreaterThan(0);
	});

	// ─── Tool execute is called with validated args ───────────────────────────

	it("tool.execute receives the validated args from the LLM tool call", async () => {
		let receivedArgs: unknown;
		const agent = makeAgent({
			tools: [
				{
					name: "echo",
					description: "echo",
					parameters: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
						additionalProperties: false,
					} as any,
					execute: async (_id, args) => {
						receivedArgs = args;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				} as any,
			],
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { value: "hello" })]),
			fauxAssistantMessage(fauxText("done")),
		]);

		await agent.prompt("call echo");
		expect(receivedArgs).toEqual({ value: "hello" });
	});

	// ─── beforeToolCall / afterToolCall hooks ─────────────────────────────────

	it("beforeToolCall can block tool execution", async () => {
		let executeCalled = false;
		const agent = new Agent({
			initialState: {
				model: faux.getModel(),
				tools: [
					{
						name: "blocked",
						description: "x",
						parameters: { type: "object", properties: {}, additionalProperties: false } as any,
						execute: async () => {
							executeCalled = true;
							return { content: [{ type: "text", text: "ran" }], details: {} };
						},
					} as any,
				],
			},
			beforeToolCall: async () => ({ block: true, reason: "policy: blocked" }),
		});

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("blocked", {})]),
			fauxAssistantMessage(fauxText("ok")),
		]);

		await agent.prompt("try");
		expect(executeCalled).toBe(false);
	});

	it("afterToolCall can override the tool result", async () => {
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: {
				model: faux.getModel(),
				tools: [
					{
						name: "t",
						description: "x",
						parameters: { type: "object", properties: {}, additionalProperties: false } as any,
						execute: async () => ({ content: [{ type: "text", text: "original" }], details: {} }),
					} as any,
				],
			},
			afterToolCall: async () => ({
				content: [{ type: "text", text: "overridden" }],
				details: { overridden: true },
			}),
		});
		agent.subscribe((e) => events.push(e));

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("t", {})]),
			fauxAssistantMessage(fauxText("done")),
		]);

		await agent.prompt("call t");

		const end = events.find((e) => e.type === "tool_execution_end") as any;
		expect(end).toBeDefined();
		expect(end.result.content[0].text).toBe("overridden");
	});
});
