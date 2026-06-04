/**
 * Event-Sourced Adapter for the Agent class.
 *
 * Translates EventStore events into the legacy AgentEvent stream so that
 * AgentSession (and other consumers) can keep using the old event shape
 * while the underlying execution runs through the EventSourcedRuntime
 * (reactor + EventStore + projection).
 *
 * This is the bridge that lets us flip Agent from "internal loop" to
 * "event-sourced" without touching the 3000-line AgentSession class.
 */

import type { AssistantMessage, AssistantMessageEvent, ImageContent, Model, TextContent, ToolCall } from "@mariozechner/pi-ai";
import { eventToMessage } from "../projection/event-to-message.js";
import type { EventBase } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import type { LLMChunk, LLMClient, ModelConfig } from "../runtime/llm-types.js";
import type { EventSourcedRuntime } from "../runtime/runtime.js";
import { createToolRegistry } from "../intent/tool-adapter.js";
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	AfterToolCallContext,
	AfterToolCallResult,
	StreamFn,
	ToolExecutionMode,
} from "./types.js";
import type { ToolExecutionRequest, RuntimeAdapter } from "../runtime/types.js";
import type { ToolExecutionResult } from "../intent/types.js";

function getStreamToolCall(event: AssistantMessageEvent): ToolCall | undefined {
	const direct = (event as any).toolCall;
	if (direct?.type === "toolCall") return direct as ToolCall;

	const contentIndex = (event as any).contentIndex;
	const partialContent = (event as any).partial?.content;
	const partialBlock = Array.isArray(partialContent) && typeof contentIndex === "number"
		? partialContent[contentIndex]
		: undefined;
	return partialBlock?.type === "toolCall" ? partialBlock as ToolCall : undefined;
}

// ============================================================================
// LLMClient adapter — wraps a pi-ai streamFn into the reactor's LLMClient interface
// ============================================================================

/** Build an LLMClient that calls the given streamFn from pi-ai. */
export function buildLlmClientFromStreamFn(
	model: Model<any>,
	streamFn: StreamFn,
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
			// Resolve API key
			const apiKey = options?.getApiKey ? await options.getApiKey(model.provider) : undefined;

			// Convert ToolDefinition[] → pi-ai Tool[]
			const piTools = tools?.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				parameters: t.input_schema as any,
			})) as any;

			const stream = await streamFn(
				model,
				{
					systemPrompt: systemPrompt ?? "",
					messages: messages.filter(
						(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
					) as any,
					tools: piTools,
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

			// Drive the stream and translate events into LLMChunks
			for await (const event of stream) {
				switch (event.type) {
					case "start":
						// Stream started - wait for actual content events to emit chunks
						break;
					case "text_start":
						onChunk?.({ kind: "text_start", contentIndex: event.contentIndex } as LLMChunk);
						break;
					case "text_delta":
						onChunk?.({ kind: "text_delta", contentIndex: event.contentIndex, delta: event.delta } as LLMChunk);
						break;
					case "text_end":
						onChunk?.({ kind: "text_end", contentIndex: event.contentIndex, content: event.content } as LLMChunk);
						break;
					case "thinking_start":
						onChunk?.({ kind: "thinking_start", contentIndex: event.contentIndex } as LLMChunk);
						break;
					case "thinking_delta":
						onChunk?.({ kind: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta } as LLMChunk);
						break;
					case "thinking_end":
						onChunk?.({ kind: "thinking_end", contentIndex: event.contentIndex, content: event.content } as LLMChunk);
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
			if (!finalMessage) {
				finalMessage = await (stream as any).result();
			}

			if (!finalMessage) {
				throw new Error("Stream ended without a terminal event");
			}
			const msg: AssistantMessage = finalMessage;

			// Map AssistantMessage to LLMResponse shape
			const content = msg.content.map((block) => {
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
				provider: msg.provider,
				model: msg.model,
				usage: {
					input: msg.usage.input,
					output: msg.usage.output,
					cache_read: msg.usage.cacheRead,
					cache_write: msg.usage.cacheWrite,
					total: msg.usage.totalTokens,
					cost: msg.usage.cost.total,
				},
				// Force tool_use stop reason when content contains tool_call blocks,
				// since some providers return "stop" even with tool calls.
				stopReason: content.some((b: any) => b.type === "tool_call")
					? "tool_use"
					: msg.stopReason === "toolUse"
						? "tool_use"
						: (msg.stopReason as any),
				errorMessage: msg.errorMessage,
			};
		},
	};
}

// ============================================================================
// Event Translator — maps EventStore events into the legacy AgentEvent stream
// ============================================================================

/**
 * Translate a stream of EventStore events into AgentEvent sequence.
 *
 * Stateful: tracks turn boundaries, accumulates partial messages from chunks, etc.
 */
export class EventStoreToAgentEventTranslator {
	private _hasEmittedAgentStart = false;
	private _toolResultsPending: AgentMessage[] = [];
	private _lastMessageEvent: AgentMessage | undefined;

	// ─── Streaming state ──────────────────────────────────────────────────────

	/** Whether we have emitted message_start for the current assistant message */
	private _hasEmittedMessageStart = false;
	/** Partial text accumulated so far */
	private _partialText = "";
	/** Partial thinking text accumulated so far */
	private _partialThinking = "";
	/** Partial tool call fragments accumulated. Key is contentIndex. */
	private _partialToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
	/** Last content index we saw (for ordering) */
	private _lastContentIndex = 0;

	/**
	 * Translate one EventStore event → 0+ AgentEvents.
	 * Returns the events in order they should be emitted.
	 */
	translate(event: EventBase): AgentEvent[] {
		const out: AgentEvent[] = [];

		switch (event.type) {
			// ─── Streaming ────────────────────────────────────────────────────

			case "AGENT_MESSAGE_START": {
				this._hasEmittedMessageStart = false;
				this._partialText = "";
				this._partialThinking = "";
				this._partialToolCalls = new Map();
				this._lastContentIndex = 0;
				break;
			}

			case "AGENT_MESSAGE_CHUNK": {
				const chunk = (event.payload as { chunk: any }).chunk as {
					kind: string;
					contentIndex?: number;
					delta?: string;
					tool_call_id?: string;
					tool_name?: string;
					content?: string;
					arguments?: unknown;
				};

				const idx = chunk.contentIndex ?? this._lastContentIndex;
				if (chunk.contentIndex !== undefined) this._lastContentIndex = chunk.contentIndex;

				const ensureStart = () => {
					if (!this._hasEmittedMessageStart) {
						this._hasEmittedMessageStart = true;
						const msg = this._buildStreamingMessage();
						out.push({ type: "message_start", message: msg });
					}
				};

				switch (chunk.kind) {
					case "text_start": {
						ensureStart();
						const msg = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg,
							assistantMessageEvent: { type: "text_start", contentIndex: idx, partial: msg } as AssistantMessageEvent,
						});
						break;
					}
					case "text_delta": {
						this._partialText += chunk.delta ?? "";
						ensureStart();
						const msg1 = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg1,
							assistantMessageEvent: { type: "text_delta", contentIndex: idx, delta: chunk.delta ?? "", partial: msg1 } as AssistantMessageEvent,
						});
						break;
					}
					case "text_end": {
						ensureStart();
						const msg = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg,
							assistantMessageEvent: { type: "text_end", contentIndex: idx, content: chunk.content ?? this._partialText, partial: msg } as AssistantMessageEvent,
						});
						break;
					}
					case "thinking_start": {
						ensureStart();
						const msg = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg,
							assistantMessageEvent: { type: "thinking_start", contentIndex: idx, partial: msg } as AssistantMessageEvent,
						});
						break;
					}
					case "thinking_delta": {
						this._partialThinking += chunk.delta ?? "";
						ensureStart();
						const msg2 = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg2,
							assistantMessageEvent: { type: "thinking_delta", contentIndex: idx, delta: chunk.delta ?? "", partial: msg2 } as AssistantMessageEvent,
						});
						break;
					}
					case "thinking_end": {
						ensureStart();
						const msg = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg,
							assistantMessageEvent: { type: "thinking_end", contentIndex: idx, content: chunk.content ?? this._partialThinking, partial: msg } as AssistantMessageEvent,
						});
						break;
					}
					case "toolcall_start": {
						this._partialToolCalls.set(idx, { id: chunk.tool_call_id ?? "", name: chunk.tool_name ?? "", args: "" });
						ensureStart();
						const msg3 = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg3,
							assistantMessageEvent: { type: "toolcall_start", contentIndex: idx, partial: msg3 } as AssistantMessageEvent,
						});
						break;
					}
					case "toolcall_delta": {
						const tc = this._partialToolCalls.get(idx);
						if (tc) tc.args += chunk.delta ?? "";
						ensureStart();
						const msg4 = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg4,
							assistantMessageEvent: { type: "toolcall_delta", contentIndex: idx, delta: chunk.delta ?? "", partial: msg4 } as AssistantMessageEvent,
						});
						break;
					}
					case "toolcall_end": {
						const previous = this._partialToolCalls.get(idx);
						const args =
							chunk.arguments === undefined
								? (previous?.args ?? "")
								: typeof chunk.arguments === "string"
									? chunk.arguments
									: (JSON.stringify(chunk.arguments) ?? previous?.args ?? "");
						const updated = {
							id: chunk.tool_call_id || previous?.id || "",
							name: chunk.tool_name || previous?.name || "",
							args,
						};
						this._partialToolCalls.set(idx, updated);
						ensureStart();
						const msg5 = this._buildStreamingMessage();
						out.push({
							type: "message_update",
							message: msg5,
							assistantMessageEvent: { type: "toolcall_end", contentIndex: idx, toolCall: { type: "toolCall", id: updated.id, name: updated.name, arguments: chunk.arguments ?? {} } as ToolCall, partial: msg5 } as AssistantMessageEvent,
						});
						break;
					}
				}
				break;
			}

			// ─── Turn lifecycle ───────────────────────────────────────────────

			case "USER_MESSAGE": {
				if (!this._hasEmittedAgentStart) {
					out.push({ type: "agent_start" });
					out.push({ type: "turn_start" });
					this._hasEmittedAgentStart = true;
				}
				const msg = eventToMessage(event);
				if (msg) {
					out.push({ type: "message_start", message: msg });
					out.push({ type: "message_end", message: msg });
				}
				break;
			}

			case "AGENT_MESSAGE_END": {
				const hadEmittedMessageStart = this._hasEmittedMessageStart;
				this._hasEmittedMessageStart = false;
				this._partialText = "";
				this._partialThinking = "";
				this._partialToolCalls = new Map();
				this._lastContentIndex = 0;
				const msg = eventToMessage(event);
				if (msg) {
					this._lastMessageEvent = msg;
					// Only emit message_start if it wasn't already emitted during streaming
					if (!hadEmittedMessageStart) {
						out.push({ type: "message_start", message: msg });
					}
					out.push({ type: "message_end", message: msg });
				}
				break;
			}

			case "AGENT_TURN_END": {
				const message = this._lastMessageEvent;
				if (message) {
					out.push({ type: "turn_end", message, toolResults: this._toolResultsPending as any });
					this._toolResultsPending = [];
				}
				break;
			}

			case "AGENT_TURN_REQUESTED": {
				const payload = event.payload as { reason?: string };
				if (payload.reason === "tool_results" || payload.reason === "follow_up") {
					out.push({ type: "turn_start" });
				}
				break;
			}

			case "TOOL_EXECUTION_START": {
				const p = event.payload as { tool_call_id: string; tool_name: string; arguments: any };
				out.push({ type: "tool_execution_start", toolCallId: p.tool_call_id, toolName: p.tool_name, args: p.arguments });
				break;
			}

			case "TOOL_EXECUTION_END": {
				const p = event.payload as { tool_call_id: string; tool_name: string; result: any; is_error: boolean };
				out.push({ type: "tool_execution_end", toolCallId: p.tool_call_id, toolName: p.tool_name, result: { content: p.result, details: {} }, isError: p.is_error });
				const msg = eventToMessage(event);
				if (msg) {
					this._toolResultsPending.push(msg);
					out.push({ type: "message_start", message: msg });
					out.push({ type: "message_end", message: msg });
				}
				break;
			}

			case "AGENT_TURN_COMPLETED": {
				out.push({ type: "agent_end", messages: [] });
				this._hasEmittedAgentStart = false;
				break;
			}

			// Other event types are intentionally ignored for the legacy AgentEvent stream
		}

		return out;
	}

	/**
	 * Build a partial streaming assistant message from current state.
	 * Used for both message_start and message_update events.
	 */
	private _buildStreamingMessage(): AssistantMessage {
		const content: any[] = [];

		if (this._partialThinking) {
			content.push({ type: "thinking", thinking: this._partialThinking });
		}

		if (this._partialText) {
			content.push({ type: "text", text: this._partialText } as TextContent);
		}

		const sortedTcKeys = Array.from(this._partialToolCalls.keys()).sort((a, b) => a - b);
		for (const k of sortedTcKeys) {
			const tc = this._partialToolCalls.get(k)!;
			let parsedArgs: unknown = tc.args;
			try { parsedArgs = JSON.parse(tc.args); } catch { /* keep raw string */ }
			content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: parsedArgs } as ToolCall);
		}

		return { role: "assistant", content: content as any, timestamp: Date.now() } as AssistantMessage;
	}
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert an Agent's tools array into the reactor's ToolRegistry. */
export function buildToolRegistry(tools: AgentTool<any>[]) {
	return createToolRegistry(tools);
}

/** Convert an Agent's tools array into LLM-visible ToolDefinitions for the reactor. */
export function buildToolDefinitions(tools: AgentTool<any>[]) {
	return tools.map((t) => ({
		name: t.name,
		description: t.description ?? "",
		input_schema: t.parameters as any,
	}));
}

/** Convert pi-ai Model + thinkingLevel → reactor ModelConfig. */
export function toModelConfig(model: Model<any>, thinkingLevel: string | undefined): ModelConfig {
	return {
		provider: model.provider,
		model_id: model.id,
		thinking_level: thinkingLevel,
	};
}

// ============================================================================
// HookingRuntimeAdapter — wraps a RuntimeAdapter with beforeToolCall/afterToolCall hooks
// ============================================================================

export interface ToolCallHooks {
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Wraps a RuntimeAdapter to intercept tool execution with beforeToolCall/afterToolCall hooks.
 * If beforeToolCall returns { block: true }, the tool is not executed and a rejection result is returned.
 * If afterToolCall returns a result, it overrides the tool's actual result.
 */
export function createHookingRuntimeAdapter(
	inner: RuntimeAdapter,
	hooks: ToolCallHooks,
	getState: () => { messages: AgentMessage[]; systemPrompt: string; tools?: AgentTool<any>[] },
): RuntimeAdapter {
	return {
		get runtime_id() { return inner.runtime_id; },
		get workspace_id() { return inner.workspace_id; },
		get kind() { return inner.kind; },

		async executeTool(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
			const state = getState();

			// Build a synthetic AgentToolCall for the hook context
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: request.tool_call_id,
				name: request.tool_name,
				arguments: request.arguments,
			} as any;

			// Build a synthetic AssistantMessage (last assistant message in state)
			const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
			const assistantMessage = (lastAssistant?.content ?? []) as any;

			const context: BeforeToolCallContext = {
				assistantMessage: assistantMessage,
				toolCall,
				args: request.arguments,
				context: {
					systemPrompt: state.systemPrompt,
					messages: state.messages,
					tools: state.tools,
				},
			};

			// beforeToolCall hook
			if (hooks.beforeToolCall) {
				const result = await hooks.beforeToolCall(context);
				if (result?.block) {
					return {
						content: [{ type: "text", text: result.reason ?? "Tool execution blocked by beforeToolCall hook." }],
						is_error: true,
						error_message: result.reason ?? "Blocked by beforeToolCall",
					};
				}
			}

			// Execute the tool
			const toolResult = await inner.executeTool(request);

			// afterToolCall hook
			if (hooks.afterToolCall) {
				const agentResult: AgentToolResult<any> = {
					content: toolResult.content as any[],
					details: (toolResult as any).details ?? {},
				};
				const afterContext: AfterToolCallContext = {
					assistantMessage: assistantMessage,
					toolCall,
					args: request.arguments,
					result: agentResult,
					isError: toolResult.is_error ?? false,
					context: {
						systemPrompt: state.systemPrompt,
						messages: state.messages,
						tools: state.tools,
					},
				};
				const override = await hooks.afterToolCall(afterContext);
				if (override) {
					return {
						content: override.content as any[],
						is_error: false,
					};
				}
			}

			return toolResult;
		},

		createCheckpoint(request) { return inner.createCheckpoint(request); },
		restoreCheckpoint(ref) { return inner.restoreCheckpoint(ref); },
		getStatus() { return inner.getStatus(); },
	};
}
