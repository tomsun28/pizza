/**
 * Agent Loop
 *
 * The LLM call loop that processes user messages through the event-sourced architecture.
 * LLM emits intents → IntentExecutor processes them.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { EventBase, ContentBlock } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import type { SessionProjection } from "../projection/session-projection.js";
import type { IntentExecutor } from "../intent/executor.js";
import type { ToolRegistry } from "../intent/types.js";
import { extractToolCalls } from "../projection/event-to-message.js";

// ============================================================================
// Configuration
// ============================================================================

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

/** Agent loop configuration */
export interface AgentLoopConfig {
	projection: SessionProjection;
	systemPrompt: string;
	model: ModelConfig;
	tools: ToolDefinition[];
	contextBudget: number;
	llmClient: LLMClient;
	intentExecutor: IntentExecutor;
	toolRegistry: ToolRegistry;
}

// ============================================================================
// Agent Loop
// ============================================================================

/**
 * AgentLoop - single agent's LLM call loop.
 *
 * Responsibilities:
 * 1. Build context from SessionProjection
 * 2. Call LLM
 * 3. LLM outputs tool_call → IntentExecutor processes
 * 4. All intermediate states logged to EventStore
 * 5. Loop until LLM stop (no tool_call)
 */
export class AgentLoop {
	private _isRunning = false;
	private _shouldInterrupt = false;

	constructor(
		private store: EventStore,
		private config: AgentLoopConfig,
	) {}

	/**
	 * Run a complete agent interaction (may contain multiple LLM turns).
	 *
	 * Entry: USER_MESSAGE event has been appended to store.
	 * Exit: LLM stop_reason = "stop" (no tool_call)
	 */
	async run(triggerEventId: string): Promise<void> {
		this._isRunning = true;
		this._shouldInterrupt = false;

		let currentCausedBy = triggerEventId;

		try {
			// Subscribe to user interrupt events
			const unsubscribe = this.store.subscribe(
				(event) => {
					if (event.type === "USER_INTERRUPT") {
						this._shouldInterrupt = true;
					}
				},
				{ types: ["USER_INTERRUPT"] },
			);

			try {
				// Emit thinking start
				this.store.append({
					actor_id: "coder_agent",
					type: "AGENT_THINKING_START",
					payload: { model: this.config.model.model_id },
					caused_by: currentCausedBy,
				});

				while (!this._shouldInterrupt) {
					// 1. Build context from projection
					const context = this.config.projection.buildContext({
						max_tokens: this.config.contextBudget,
					});

					// 2. Emit turn start
					const turnStart = this.store.append({
						actor_id: "coder_agent",
						type: "AGENT_TURN_START",
						payload: { message_count: context.messages.length },
						caused_by: currentCausedBy,
					});

					// 3. Call LLM
					const response = await this.config.llmClient.complete({
						messages: context.messages,
						systemPrompt: this.config.systemPrompt,
						model: this.config.model,
						tools: this.config.tools,
					});

					// 4. Emit message end
					const msgEnd = this.store.append({
						actor_id: "coder_agent",
						type: "AGENT_MESSAGE_END",
						payload: {
							content: response.content,
							model: { provider: response.provider, model_id: response.model },
							usage: response.usage,
							stop_reason: response.stopReason,
							error_message: response.errorMessage,
						},
						caused_by: turnStart.event_id,
					});

					currentCausedBy = msgEnd.event_id;

					// 5. If no tool calls, we're done
					const toolCalls = extractToolCalls(response.content);
					if (toolCalls.length === 0 || response.stopReason !== "tool_use") {
						break;
					}

					// 6. Execute tool calls through IntentExecutor
					for (const toolCall of toolCalls) {
						if (this._shouldInterrupt) break;

						await this.config.intentExecutor.execute({
							tool_call_id: toolCall.id,
							tool_name: toolCall.name,
							arguments: toolCall.arguments,
						});
						// Tool result is recorded in EventStore by IntentExecutor
						// Next loop iteration picks it up via buildContext()
					}

					// 7. Emit turn end
					this.store.append({
						actor_id: "coder_agent",
						type: "AGENT_TURN_END",
						payload: { tool_calls_count: toolCalls.length },
						caused_by: currentCausedBy,
					});
				}
			} finally {
				unsubscribe();
			}

			// Emit thinking end
			this.store.append({
				actor_id: "coder_agent",
				type: "AGENT_THINKING_END",
				payload: {},
				caused_by: currentCausedBy,
			});
		} finally {
			this._isRunning = false;
		}
	}

	/**
	 * Check if the loop is currently running.
	 */
	get isRunning(): boolean {
		return this._isRunning;
	}

	/**
	 * Interrupt the current loop.
	 */
	interrupt(): void {
		this._shouldInterrupt = true;
	}
}
