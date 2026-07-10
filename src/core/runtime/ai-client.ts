import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	streamSimple,
	ToolCall,
} from "@earendil-works/pi-ai/compat";
import type { LLMChunk, LLMClient, ModelConfig } from "./llm-types.js";

export type AiStreamFn = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

function getStreamToolCall(event: AssistantMessageEvent): ToolCall | undefined {
	const direct = (event as any).toolCall;
	if (direct?.type === "toolCall") return direct as ToolCall;

	const contentIndex = (event as any).contentIndex;
	const partialContent = (event as any).partial?.content;
	const partialBlock =
		Array.isArray(partialContent) && typeof contentIndex === "number" ? partialContent[contentIndex] : undefined;
	return partialBlock?.type === "toolCall" ? (partialBlock as ToolCall) : undefined;
}

/** Build an EventSourcedRuntime LLMClient around the configured AI stream function. */
export function buildLlmClientFromStreamFn(
	model: Model<any>,
	streamFn: AiStreamFn,
	options?: {
		getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
		thinkingBudgets?: any;
		transport?: any;
		onPayload?: any;
		onResponse?: any;
	},
): LLMClient {
	return {
		async complete({ messages, systemPrompt, tools, onChunk, signal }) {
			const apiKey = options?.getApiKey ? await options.getApiKey(model.provider) : undefined;
			const streamTools = tools?.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.input_schema as any,
			})) as any;

			const stream = await streamFn(
				model,
				{
					systemPrompt: systemPrompt ?? "",
					messages: messages.filter(
						(message) =>
							message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					).map((message) => {
						if (message.role !== "toolResult") {
							return message;
						}
						const toolResult = message as any;
						return {
							role: "toolResult",
							toolCallId: toolResult.toolCallId,
							toolName: toolResult.toolName,
							content: toolResult.content,
							isError: toolResult.isError,
							timestamp: toolResult.timestamp,
						};
					}) as any,
					tools: streamTools,
				},
				{
					apiKey,
					signal,
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
					thinkingBudgets: options?.thinkingBudgets,
					transport: options?.transport,
				} as any,
			);

			let finalMessage: AssistantMessage | undefined;

			for await (const event of stream) {
				switch (event.type) {
					case "start":
						break;
					case "text_start":
						onChunk?.({ kind: "text_start", contentIndex: event.contentIndex } as LLMChunk);
						break;
					case "text_delta":
						onChunk?.({ kind: "text_delta", contentIndex: event.contentIndex, delta: event.delta } as LLMChunk);
						break;
					case "text_end":
						onChunk?.({
							kind: "text_end",
							contentIndex: event.contentIndex,
							content: event.content,
						} as LLMChunk);
						break;
					case "thinking_start":
						onChunk?.({ kind: "thinking_start", contentIndex: event.contentIndex } as LLMChunk);
						break;
					case "thinking_delta":
						onChunk?.({
							kind: "thinking_delta",
							contentIndex: event.contentIndex,
							delta: event.delta,
						} as LLMChunk);
						break;
					case "thinking_end":
						onChunk?.({
							kind: "thinking_end",
							contentIndex: event.contentIndex,
							content: event.content,
						} as LLMChunk);
						break;
					case "toolcall_start": {
						const toolCall = getStreamToolCall(event);
						onChunk?.({
							kind: "toolcall_start",
							contentIndex: event.contentIndex,
							tool_call_id: (event as any).id ?? toolCall?.id ?? "",
							tool_name: (event as any).toolName ?? toolCall?.name ?? "",
						} as LLMChunk);
						break;
					}
					case "toolcall_delta":
						onChunk?.({ kind: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta } as LLMChunk);
						break;
					case "toolcall_end": {
						const toolCall = getStreamToolCall(event);
						onChunk?.({
							kind: "toolcall_end",
							contentIndex: event.contentIndex,
							tool_call_id: (event as any).id ?? toolCall?.id ?? "",
							tool_name: (event as any).toolName ?? toolCall?.name ?? "",
							arguments: toolCall?.arguments ?? {},
						} as LLMChunk);
						break;
					}
					case "done":
					case "error":
						finalMessage = await (stream as any).result();
						break;
				}
			}

			finalMessage ??= await (stream as any).result();
			if (!finalMessage) {
				throw new Error("Stream ended without a terminal event");
			}

			const content = finalMessage.content.map((block) => {
				if (block.type === "toolCall") {
					return {
						type: "tool_call",
						id: block.id,
						name: block.name,
						arguments: block.arguments,
					} as any;
				}
				return block as any;
			});

			return {
				content,
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
				stopReason: content.some((block: any) => block.type === "tool_call")
					? "tool_use"
					: finalMessage.stopReason === "toolUse"
						? "tool_use"
						: (finalMessage.stopReason as any),
				errorMessage: finalMessage.errorMessage,
			};
		},
	};
}

export function toModelConfig(model: Model<any>, thinkingLevel: string | undefined): ModelConfig {
	return {
		provider: model.provider,
		model_id: model.id,
		thinking_level: thinkingLevel,
	};
}
