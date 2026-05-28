/**
 * StreamLlmClient test — verifies the pi-ai adapter without network calls.
 *
 * Uses pi-ai's `faux` provider to script LLM responses.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import { StreamLlmClient } from "../src/core/agent/stream-llm-client.js";

describe("StreamLlmClient (pi-ai adapter)", () => {
	let faux: FauxProviderRegistration | undefined;

	afterEach(() => {
		faux?.unregister();
		faux = undefined;
	});

	function registerFaux() {
		faux = registerFauxProvider({
			provider: "faux-test",
			api: "openai-completions",
			models: [{ id: "faux-model" }],
			tokensPerSecond: 10000, // fast
		});
		return faux;
	}

	it("converts a faux text response to LLMResponse with stop reason", async () => {
		const f = registerFaux();
		f.setResponses([fauxAssistantMessage("hello world", { stopReason: "stop" })]);

		const client = new StreamLlmClient({
			resolveModel: async () => f.getModel(),
		});

		const result = await client.complete({
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			systemPrompt: "test",
			model: { provider: "faux-test", model_id: "faux-model" },
			tools: [],
		});

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello world" });
		expect(result.provider).toBe("faux-test");
		expect(result.model).toBe("faux-model");
	});

	it("converts tool calls to our ContentBlock format with stopReason=tool_use", async () => {
		const f = registerFaux();
		f.setResponses([
			fauxAssistantMessage(
				[fauxText("calling tool"), fauxToolCall("read", { path: "x.txt" }, { id: "call_1" })],
				{ stopReason: "toolUse" },
			),
		]);

		const client = new StreamLlmClient({
			resolveModel: async () => f.getModel(),
		});

		const result = await client.complete({
			messages: [{ role: "user", content: "read x.txt", timestamp: Date.now() }],
			model: { provider: "faux-test", model_id: "faux-model" },
			tools: [{ name: "read", description: "read", input_schema: { type: "object" } }],
		});

		expect(result.stopReason).toBe("tool_use");
		// Should contain the text block + tool_call block (in our format)
		const toolCall = result.content.find((c) => c.type === "tool_call");
		expect(toolCall).toBeDefined();
		expect(toolCall).toMatchObject({ type: "tool_call", id: "call_1", name: "read" });
		expect((toolCall as { arguments: { path: string } }).arguments).toEqual({ path: "x.txt" });
	});

	it("invokes onChunk for streaming events", async () => {
		const f = registerFaux();
		f.setResponses([fauxAssistantMessage("streaming text", { stopReason: "stop" })]);

		const chunks: string[] = [];
		const client = new StreamLlmClient({
			resolveModel: async () => f.getModel(),
			onChunk: (event) => chunks.push(event.type),
		});

		await client.complete({
			messages: [{ role: "user", content: "go", timestamp: Date.now() }],
			model: { provider: "faux-test", model_id: "faux-model" },
		});

		// faux emits start → text_start → text_delta(s) → text_end → done
		expect(chunks).toContain("start");
		expect(chunks).toContain("done");
	});

	it("filters pizza-custom messages out before sending to LLM (compaction summary becomes user msg)", async () => {
		const f = registerFaux();
		// Capture what pi-ai actually receives
		let receivedMessages: unknown[] | undefined;
		f.setResponses([
			(ctx) => {
				receivedMessages = ctx.messages;
				return fauxAssistantMessage("ok", { stopReason: "stop" });
			},
		]);

		const client = new StreamLlmClient({
			resolveModel: async () => f.getModel(),
		});

		await client.complete({
			messages: [
				{ role: "compactionSummary", summary: "previous turn", tokensBefore: 100, timestamp: 1 },
				{ role: "user", content: "continue", timestamp: 2 },
			],
			model: { provider: "faux-test", model_id: "faux-model" },
		});

		expect(receivedMessages).toBeDefined();
		expect(receivedMessages).toHaveLength(2);
		// First message should be the summary converted to user msg
		expect((receivedMessages![0] as { role: string }).role).toBe("user");
		expect((receivedMessages![0] as { content: string }).content).toContain("previous turn");
	});
});
