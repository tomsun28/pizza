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

/** LLM client interface */
export interface LLMClient {
	complete(request: {
		messages: AgentMessage[];
		systemPrompt?: string;
		model: ModelConfig;
		tools?: ToolDefinition[];
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
