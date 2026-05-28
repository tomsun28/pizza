/**
 * StreamLlmClient — adapts pi-ai's `streamSimple` to the reactor's `LLMClient` interface.
 *
 * The reactor speaks in terms of the abstract `LLMClient` (in `runtime/llm-types.ts`).
 * This client:
 *   1. Receives `AgentMessage[]` (pizza's own message union)
 *   2. Filters/converts them to pi-ai `Message[]` via `toLlmMessages`
 *   3. Calls pi-ai's `streamSimple`
 *   4. Consumes the event stream, emitting per-chunk `onChunk` callbacks if provided
 *   5. Returns a `LLMResponse` shaped for the reactor (with our own ContentBlock format)
 *
 * Streaming chunk events are surfaced via the optional onChunk callback (for now the
 * reactor doesn't subscribe to them; in a later stage the reactor will append
 * AGENT_MESSAGE_CHUNK events to the EventStore for live UI rendering).
 */

import { streamSimple } from "@mariozechner/pi-ai";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ContentBlock } from "../event-store/types.js";
import type { LLMClient, LLMResponse, ModelConfig, ToolDefinition } from "../runtime/llm-types.js";
import type { AgentMessage } from "./types.js";
import { toLlmMessages } from "./types.js";

// ============================================================================
// Configuration
// ============================================================================

export interface StreamLlmClientOptions {
	/**
	 * Resolve the pi-ai `Model<any>` instance for the given ModelConfig.
	 * Required because the reactor only knows {provider, model_id, thinking_level}
	 * and api-key resolution is owned by the caller.
	 */
	resolveModel: (model: ModelConfig) => Promise<Model<any>>;

	/**
	 * Resolve the api key + headers for a given model.
	 * Returns undefined if the provider does not require an api key (e.g. OAuth).
	 */
	resolveAuth?: (model: Model<any>) => Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined>;

	/**
	 * Optional callback fired for every streaming event from pi-ai.
	 * Used by the reactor (in later stages) to emit AGENT_MESSAGE_CHUNK events.
	 */
	onChunk?: (event: AssistantMessageEvent) => void;

	/** Abort signal for in-flight requests. */
	signal?: AbortSignal;
}

// ============================================================================
// Implementation
// ============================================================================

export class StreamLlmClient implements LLMClient {
	constructor(private opts: StreamLlmClientOptions) {}

	async complete(request: {
		messages: AgentMessage[];
		systemPrompt?: string;
		model: ModelConfig;
		tools?: ToolDefinition[];
	}): Promise<LLMResponse> {
		const piModel = await this.opts.resolveModel(request.model);

		// Auth resolution
		let apiKey: string | undefined;
		let headers: Record<string, string> | undefined;
		if (this.opts.resolveAuth) {
			const auth = await this.opts.resolveAuth(piModel);
			apiKey = auth?.apiKey;
			headers = auth?.headers;
		}

		// Convert our AgentMessage[] → pi-ai Message[]
		const piMessages = toLlmMessages(request.messages);

		// Convert ToolDefinition → pi-ai Tool (parameters use TypeBox schema; we
		// reuse the JSON Schema directly — pi-ai treats parameters as opaque schema).
		const piTools = request.tools?.map((t) => ({
			name: t.name,
			description: t.description ?? "",
			parameters: t.input_schema as unknown as Parameters<typeof streamSimple>[1]["tools"] extends (infer T)[] | undefined ? T : never,
		})) as Parameters<typeof streamSimple>[1]["tools"];

		// Map our ThinkingLevel onto pi-ai's `reasoning` field of SimpleStreamOptions.
		const reasoning = this._resolveReasoning(request.model.thinking_level);

		const options: SimpleStreamOptions = {
			signal: this.opts.signal,
			apiKey,
			headers,
			reasoning,
		};

		// Drive the stream to completion
		const stream = streamSimple(piModel, {
			systemPrompt: request.systemPrompt,
			messages: piMessages,
			tools: piTools,
		}, options);

		let finalMessage: AssistantMessage | undefined;
		let stopReason: LLMResponse["stopReason"] = "stop";
		let errorMessage: string | undefined;

		for await (const event of stream) {
			this.opts.onChunk?.(event);

			if (event.type === "done") {
				finalMessage = event.message;
				stopReason = event.reason === "toolUse" ? "tool_use" : (event.reason as LLMResponse["stopReason"]);
			} else if (event.type === "error") {
				finalMessage = event.error;
				stopReason = event.error.stopReason === "aborted" ? "aborted" : "error";
				errorMessage = event.error.errorMessage;
			}
		}

		if (!finalMessage) {
			return {
				content: [],
				provider: request.model.provider,
				model: request.model.model_id,
				usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
				stopReason: "error",
				errorMessage: "Stream ended without a terminal event",
			};
		}

		return {
			content: this._convertContent(finalMessage.content),
			provider: finalMessage.provider,
			model: finalMessage.model,
			usage: {
				input: finalMessage.usage.input,
				output: finalMessage.usage.output,
				cache_read: finalMessage.usage.cacheRead,
				cache_write: finalMessage.usage.cacheWrite,
				total: finalMessage.usage.totalTokens,
				cost: finalMessage.usage.cost.total,
			},
			stopReason,
			errorMessage,
		};
	}

	/** Convert pi-ai AssistantMessage content blocks → our ContentBlock format. */
	private _convertContent(content: AssistantMessage["content"]): ContentBlock[] {
		return content.map((block) => {
			if (block.type === "toolCall") {
				return {
					type: "tool_call",
					id: block.id,
					name: block.name,
					arguments: block.arguments,
				} as ContentBlock;
			}
			// text & thinking pass through (they already use compatible shape)
			return block as unknown as ContentBlock;
		});
	}

	/** Map our ThinkingLevel ("off" | minimal | low | ...) → pi-ai SimpleStreamOptions.reasoning. */
	private _resolveReasoning(level: string | undefined): SimpleStreamOptions["reasoning"] {
		if (!level || level === "off") return undefined;
		if (level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh") {
			return level;
		}
		return undefined;
	}
}
