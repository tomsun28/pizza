/**
 * Agent Loop
 *
 * Low-level event-driven agent loop. Transforms AgentMessage[] → Message[] only
 * at the LLM call boundary.
 *
 * This module is pizza's own implementation, independent of pi-agent-core.
 * It uses pizza's own types from `../agent/types.ts`.
 */

import { EventStream, streamSimple, validateToolArguments } from "@mariozechner/pi-ai";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	AfterToolCallContext,
	AfterToolCallResult,
	StreamFn,
} from "./types.js";

// ============================================================================
// Public API
// ============================================================================

/**
 * Start an agent loop with new prompt messages.
 * Prompts are added to context and events are emitted.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();
	void runAgentLoop(prompts, context, config, async (event) => stream.push(event), signal, streamFn).then(
		(messages) => stream.end(messages),
	);
	return stream;
}

/**
 * Continue an agent loop from current context without adding new prompts.
 * Used for retries — context already has user message or tool results.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}
	const last = context.messages[context.messages.length - 1];
	if (last.role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}
	const stream = createAgentStream();
	void runAgentLoopContinue(context, config, async (event) => stream.push(event), signal, streamFn).then(
		(messages) => stream.end(messages),
	);
	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: (event: AgentEvent) => Promise<void> | void,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: (event: AgentEvent) => Promise<void> | void,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}
	const last = context.messages[context.messages.length - 1];
	if (last.role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

// ============================================================================
// Internal helpers
// ============================================================================

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop — shared by agentLoop and agentLoopContinue.
 * Handles tool execution, steering messages (mid-turn injection), and follow-up messages.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => Promise<void> | void,
	streamFn: StreamFn | undefined,
): Promise<void> {
	let firstTurn = true;
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

	while (true) {
		let hasMoreToolCalls = true;

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Inject pending steering messages before next assistant response
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c): c is AgentToolCall => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const results = await executeToolCalls(currentContext, message, config, signal, emit);
				for (const result of results) {
					currentContext.messages.push(result);
					newMessages.push(result);
					toolResults.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			pendingMessages = (await config.getSteeringMessages?.()) ?? [];
		}

		// Agent would stop here — check for follow-up messages
		const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => Promise<void> | void,
	streamFn: StreamFn | undefined,
): Promise<AssistantMessage> {
	// Apply context transform (AgentMessage[] → AgentMessage[])
	let messages: AgentMessage[] = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools as Parameters<typeof streamSimple>[1]["tools"],
	};

	const streamFunction = streamFn ?? streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey = config.getApiKey
		? await config.getApiKey(config.model.provider)
		: undefined;
	const resolvedKey = resolvedApiKey ?? (config as any).apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start": {
				partialMessage = event.partial as AssistantMessage;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;
			}
			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end": {
				if (partialMessage) {
					partialMessage = event.partial as AssistantMessage;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event as any,
						message: { ...partialMessage },
					});
				}
				break;
			}
			case "done":
			case "error": {
				const finalMessage = await (response as any).result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await (response as any).result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

// ============================================================================
// Tool Execution
// ============================================================================

async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => Promise<void> | void,
): Promise<ToolResultMessage[]> {
	const toolCalls = assistantMessage.content.filter((c): c is AgentToolCall => c.type === "toolCall");
	const hasSequential = toolCalls.some((tc) =>
		currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);

	if (config.toolExecution === "sequential" || hasSequential) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => Promise<void> | void,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);

		let finalized: FinalizedToolCall;
		if (preparation.kind === "immediate") {
			finalized = { toolCall, result: preparation.result, isError: preparation.isError };
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		results.push(toolResultMessage);
	}

	return results;
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => Promise<void> | void,
): Promise<ToolResultMessage[]> {
	// Phase 1: emit tool_execution_start and prepare all calls sequentially
	for (const toolCall of toolCalls) {
		await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
	}

	// Prepare all tool calls
	const preparations = await Promise.all(
		toolCalls.map((toolCall) => prepareToolCall(currentContext, assistantMessage, toolCall, config, signal)),
	);

	// Execute: immediate results emit end synchronously, prepared ones execute in parallel
	const finalizedOrThunk: Array<FinalizedToolCall | (() => Promise<FinalizedToolCall>)> = [];

	for (let i = 0; i < toolCalls.length; i++) {
		const preparation = preparations[i];
		if (preparation.kind === "immediate") {
			const finalized = { toolCall: toolCalls[i], result: preparation.result, isError: preparation.isError };
			await emitToolExecutionEnd(finalized, emit);
			finalizedOrThunk.push(finalized);
		} else {
			finalizedOrThunk.push(async () => {
				const executed = await executePreparedToolCall(preparation, signal, emit);
				const finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			});
		}
	}

	// Await all parallel executions
	const finalizedCalls = await Promise.all(
		finalizedOrThunk.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);

	// Emit tool result messages in assistant source order
	const results: ToolResultMessage[] = [];
	for (const finalized of finalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		results.push(toolResultMessage);
	}

	return results;
}

type FinalizedToolCall = {
	toolCall: AgentToolCall;
	result: AgentToolResult;
	isError: boolean;
};

function prepareToolCallArguments(tool: AgentTool, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) return toolCall;
	const prepared = tool.prepareArguments(toolCall.arguments);
	if (prepared === toolCall.arguments) return toolCall;
	return { ...toolCall, arguments: prepared as Record<string, unknown> };
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<
	| { kind: "immediate"; result: AgentToolResult; isError: boolean }
	| { kind: "prepared"; toolCall: AgentToolCall; tool: AgentTool; args: unknown }
> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall as any);

		if (config.beforeToolCall) {
			const ctx: BeforeToolCallContext = {
				assistantMessage,
				toolCall,
				args: validatedArgs,
				context: currentContext,
			};
			const beforeResult = await config.beforeToolCall(ctx, signal);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason ?? "Tool execution was blocked"),
					isError: true,
				};
			}
		}

		return { kind: "prepared", toolCall, tool, args: validatedArgs };
	} catch (err) {
		return {
			kind: "immediate",
			result: createErrorToolResult(err instanceof Error ? err.message : String(err)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: { toolCall: AgentToolCall; tool: AgentTool; args: unknown },
	signal: AbortSignal | undefined,
	emit: (event: AgentEvent) => Promise<void> | void,
): Promise<{ result: AgentToolResult; isError: boolean }> {
	const updatePromises: Promise<unknown>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as any,
			signal,
			(partial) => {
				updatePromises.push(
					emit({
						type: "tool_execution_update",
						toolCallId: prepared.toolCall.id,
						toolName: prepared.toolCall.name,
						args: prepared.toolCall.arguments,
						partialResult: partial,
					}) as unknown as Promise<unknown>,
				);
			},
		);
		await Promise.all(updatePromises);
		return { result, isError: false };
	} catch (err) {
		await Promise.all(updatePromises);
		return {
			result: createErrorToolResult(err instanceof Error ? err.message : String(err)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: { toolCall: AgentToolCall; tool: AgentTool; args: unknown },
	executed: { result: AgentToolResult; isError: boolean },
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCall> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const ctx: AfterToolCallContext = {
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			};
			const afterResult = await config.afterToolCall(ctx, signal);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (err) {
			result = createErrorToolResult(err instanceof Error ? err.message : String(err));
			isError = true;
		}
	}

	return { toolCall: prepared.toolCall, result, isError };
}

function createErrorToolResult(message: string): AgentToolResult {
	return { content: [{ type: "text", text: message }], details: {} };
}

async function emitToolExecutionEnd(
	finalized: FinalizedToolCall,
	emit: (event: AgentEvent) => Promise<void> | void,
): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCall): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content as (TextContent | ImageContent)[],
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(
	toolResultMessage: ToolResultMessage,
	emit: (event: AgentEvent) => Promise<void> | void,
): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage as unknown as AgentMessage });
	await emit({ type: "message_end", message: toolResultMessage as unknown as AgentMessage });
}
