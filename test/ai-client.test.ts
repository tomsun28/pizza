import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildLlmClientFromStreamFn, type AiStreamFn } from "../src/core/runtime/ai-client.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			this.push({ type: "start", partial: { ...message, content: [] } });
			this.push({ type: "done", reason: "stop", message });
		});
	}
}

function createAssistantMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createModel(): Model<any> {
	return {
		id: "qwen3.8-max",
		name: "qwen3.8-max",
		api: "anthropic-messages",
		provider: "custom-provider",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

describe("buildLlmClientFromStreamFn", () => {
	it("does not pass provider reasoning when thinking level is off", async () => {
		const model = createModel();
		let capturedOptions: SimpleStreamOptions | undefined;
		const streamFn: AiStreamFn = (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
			capturedOptions = options;
			return new MockAssistantStream(createAssistantMessage(model));
		};
		const client = buildLlmClientFromStreamFn(() => model, streamFn, {
			getThinkingLevel: () => "off",
		});

		await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

		expect(capturedOptions).toBeDefined();
		expect(capturedOptions).not.toHaveProperty("reasoning");
	});

	it("passes provider reasoning when thinking level is enabled", async () => {
		const model = { ...createModel(), reasoning: true };
		let capturedOptions: SimpleStreamOptions | undefined;
		const streamFn: AiStreamFn = (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
			capturedOptions = options;
			return new MockAssistantStream(createAssistantMessage(model));
		};
		const client = buildLlmClientFromStreamFn(() => model, streamFn, {
			getThinkingLevel: () => "high",
		});

		await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

		expect(capturedOptions?.reasoning).toBe("high");
	});
});
