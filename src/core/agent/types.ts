/**
 * Agent Types — pizza's own message / tool / state model.
 *
 * Built on top of pi-ai's primitives (`UserMessage`, `AssistantMessage`,
 * `ToolResultMessage`, `Tool`, `Model`) but free of any dependency on
 * `@mariozechner/pi-agent-core`.
 *
 * This module is the new canonical home for agent shape definitions.
 * Callers should import from here, not from pi-agent-core.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingLevel as PiThinkingLevel,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

// ============================================================================
// Re-exports of pi-ai primitives so downstream code has one canonical import
// ============================================================================

export type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	TextContent,
	Tool,
	ToolResultMessage,
	UserMessage,
};

// ============================================================================
// Tool execution mode
// ============================================================================

/** Controls whether a tool runs sequentially or in parallel with other tool calls. */
export type ToolExecutionMode = "sequential" | "parallel";

// ============================================================================
// Thinking levels (pizza's extension; includes "off" which pi-ai doesn't have)
// ============================================================================

export type ThinkingLevel = "off" | PiThinkingLevel;

// ============================================================================
// Custom message types — pizza-specific roles that flow alongside LLM messages
// ============================================================================

/** A bash execution message (recorded by the runtime, not produced by the LLM). */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	/** Combined stdout+stderr output. */
	output: string;
	exitCode: number | undefined;
	/** Whether the command was cancelled/aborted. */
	cancelled: boolean;
	/** Whether the output was truncated. */
	truncated: boolean;
	timestamp: number;
	/** Path to full output file when truncated. */
	fullOutputPath?: string;
	/** Whether to exclude from LLM context. */
	excludeFromContext?: boolean;
	/** Separated stdout (when available). */
	stdout?: string;
	/** Separated stderr (when available). */
	stderr?: string;
}

/** A summary inserted by compaction. */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

/** A branch summary inserted when switching branches. */
export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	/** Source branch/entry id. */
	fromId?: string;
	timestamp: number;
}

/** A custom extension-provided message. Generic over the structured payload type. */
export interface CustomMessage<T = unknown> {
	role: "custom";
	/** Discriminator for the extension to identify its own custom messages. */
	customType: string;
	/** Content visible to the LLM when this message is included in context. */
	content: string | (TextContent | ImageContent)[];
	/** Optional UI-only display text or boolean flag. */
	display?: string | boolean;
	/** Arbitrary structured payload for tooling / persistence. */
	details?: T;
	timestamp: number;
}

// ============================================================================
// AgentMessage — the union of everything that can appear in a session timeline
// ============================================================================

export type AgentMessage =
	| Message
	| BashExecutionMessage
	| CompactionSummaryMessage
	| BranchSummaryMessage
	| CustomMessage;

// ============================================================================
// Agent tools — wraps pi-ai's `Tool` with an execute callback
// ============================================================================

/** Tool execution result returned to the LLM. */
export interface AgentToolResult<T = unknown> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Optional structured payload for logs/UI. */
	details?: T;
}

/** Optional streaming-update callback. */
export type AgentToolUpdateCallback<T = unknown> = (partial: AgentToolResult<T>) => void;

/** Pizza's tool definition. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown>
	extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label?: string;
	/** Controls whether a tool runs sequentially or in parallel with other tool calls. */
	executionMode?: ToolExecutionMode;
	/** Optional shim for raw tool-call arguments before schema validation. */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** Execute the tool call. Throw on failure. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

// ============================================================================
// Agent state — read-only snapshot the runtime exposes to UI / extensions
// ============================================================================

export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any> | undefined;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. */
	tools: AgentTool<any>[];
	/** Conversation transcript. */
	messages: AgentMessage[];
	/** True while the agent is processing a prompt. */
	isStreaming: boolean;
	/** Tool call ids currently executing. */
	pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed turn. */
	errorMessage?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Type guard: is this a pi-ai LLM message (user / assistant / toolResult)? */
export function isLlmMessage(msg: AgentMessage): msg is Message {
	return msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult";
}

/** Filter pizza-specific messages, keep only those the LLM can consume. */
export function toLlmMessages(messages: AgentMessage[]): Message[] {
	const out: Message[] = [];
	for (const m of messages) {
		if (isLlmMessage(m)) {
			out.push(m);
		} else if (m.role === "compactionSummary" || m.role === "branchSummary") {
			// Inject summaries as a user message so the LLM sees them.
			out.push({
				role: "user",
				content: `[Previous context summary]\n${m.summary}`,
				timestamp: m.timestamp,
			});
		} else if (m.role === "bashExecution") {
			out.push({
				role: "user",
				content:
					`[Bash command executed]\n$ ${m.command}\n` +
					(m.output ? `output:\n${m.output}\n` : "") +
					`exit code: ${m.exitCode}`,
				timestamp: m.timestamp,
			});
		} else if (m.role === "custom") {
			out.push({
				role: "user",
				content: m.content,
				timestamp: m.timestamp,
			});
		}
	}
	return out;
}

// ============================================================================
// AgentEvent — the event union emitted by the agent runtime during execution
// ============================================================================

/** Events emitted during agent execution (mirrors pi-agent-core's AgentEvent). */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
