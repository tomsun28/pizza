/**
 * LLM Client Types
 *
 * Shared types for the LLM client interface used by the reactor.
 */

import type { ContentBlock } from "../event-store/types.js";
import type { AgentMessage } from "../agent/types.js";

/** Model configuration */
export interface ModelConfig {
	provider: string;
	model_id: string;
	thinking_level?: string;
}

/** Tool definition for LLM */
export interface ToolDefinition {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
}

/**
 * Streaming chunk emitted by an LLM client during a call.
 *
 * Producers map provider-specific streaming events onto this minimal shape.
 * Consumers (the reactor) translate each chunk into AGENT_MESSAGE_CHUNK events
 * appended to the EventStore.
 */
export type LLMChunk =
	| { kind: "text_delta"; contentIndex: number; delta: string }
	| { kind: "thinking_delta"; contentIndex: number; delta: string }
	| { kind: "toolcall_start"; contentIndex: number; tool_call_id: string; tool_name: string }
	| { kind: "toolcall_delta"; contentIndex: number; delta: string };

/** LLM client interface */
export interface LLMClient {
	complete(request: {
		messages: AgentMessage[];
		systemPrompt?: string;
		model: ModelConfig;
		tools?: ToolDefinition[];
		/**
		 * Optional streaming callback. Fires once per LLM chunk while the call
		 * is in flight. Reactors use this to emit AGENT_MESSAGE_CHUNK events to
		 * the EventStore for live UI rendering.
		 *
		 * Clients that cannot stream may simply not call this.
		 */
		onChunk?: (chunk: LLMChunk) => void;
		/** Abort signal for in-flight requests. */
		signal?: AbortSignal;
	}): Promise<LLMResponse>;
}

/** LLM response */
export interface LLMResponse {
	content: ContentBlock[];
	provider: string;
	model: string;
	usage: {
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
		total: number;
		cost: number;
	};
	stopReason: "stop" | "tool_use" | "length" | "error" | "aborted";
	errorMessage?: string;
}
