/**
 * EventStore Bridge
 *
 * Bridges the existing AgentSession event system to the new EventStore.
 * This keeps the legacy SessionManager path running while the event-sourced
 * runtime becomes the durable source of truth.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { EventBase } from "./event-store/types.js";
import type { EventAppendInput, EventStore } from "./event-store/store.js";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";

// ============================================================================
// EventStore Bridge
// ============================================================================

export class EventStoreBridge {
	private unsubscribe?: () => void;
	private _active = false;
	private currentCorrelationId: string | undefined;
	private currentRootEventId: string | undefined;
	private currentTurnEventId: string | undefined;
	private currentMessageStartEventId: string | undefined;
	private lastAgentMessageEventId: string | undefined;
	private lastEventId: string | undefined;
	private toolStartEvents: Map<string, string> = new Map();

	constructor(
		private session: AgentSession,
		private store: EventStore,
	) {}

	/**
	 * Start bridging events from AgentSession to EventStore.
	 */
	start(): void {
		if (this._active) return;
		this._active = true;

		this.unsubscribe = this.session.subscribe((event) => {
			this._handleEvent(event);
		});
	}

	/**
	 * Stop bridging events.
	 */
	stop(): void {
		this._active = false;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	/**
	 * Check if bridge is active.
	 */
	get active(): boolean {
		return this._active;
	}

	// =========================================================================
	// Event Handlers
	// =========================================================================

	private _handleEvent(event: AgentSessionEvent): void {
		try {
			switch (event.type) {
				case "agent_start":
					this._onAgentStart();
					break;
				case "agent_end":
					this._onAgentEnd();
					break;
				case "turn_start":
					this._onTurnStart();
					break;
				case "turn_end":
					this._onTurnEnd(event);
					break;
				case "message_start":
					this._onMessageStart(event);
					break;
				case "message_end":
					this._onMessageEnd(event);
					break;
				case "message_update":
					break;
				case "tool_execution_start":
					this._onToolStart(event);
					break;
				case "tool_execution_update":
					this._onToolUpdate(event);
					break;
				case "tool_execution_end":
					this._onToolEnd(event);
					break;
				case "compaction_start":
					this._append({
						actor_id: "compactor",
						type: "COMPACTION_START",
						payload: { reason: event.reason },
						caused_by: this.lastEventId ?? this.currentRootEventId,
					});
					break;
				case "compaction_end":
					this._append({
						actor_id: "compactor",
						type: "COMPACTION_END",
						payload: {
							reason: event.reason,
							aborted: event.aborted,
							willRetry: event.willRetry,
							error_message: event.errorMessage,
							summary: event.result?.summary ?? "",
							first_kept_entry_id: event.result?.firstKeptEntryId,
							tokens_before: event.result?.tokensBefore ?? 0,
						},
						caused_by: this.lastEventId ?? this.currentRootEventId,
					});
					break;
			}
		} catch {
			// Never let bridge errors affect the main session.
		}
	}

	private _onAgentStart(): void {
		this._append({
			actor_id: "coder_agent",
			type: "AGENT_THINKING_START",
			payload: {},
			caused_by: this.currentRootEventId,
		});
	}

	private _onAgentEnd(): void {
		this._append({
			actor_id: "coder_agent",
			type: "AGENT_THINKING_END",
			payload: {},
			caused_by: this.lastEventId ?? this.currentTurnEventId ?? this.currentRootEventId,
		});
	}

	private _onTurnStart(): void {
		const appended = this._append({
			actor_id: "coder_agent",
			type: "AGENT_TURN_START",
			payload: { message_count: 0 },
			caused_by: this.currentRootEventId,
		});
		this.currentTurnEventId = appended.event_id;
	}

	private _onTurnEnd(event: { type: "turn_end"; message: any; toolResults: unknown[] }): void {
		this._append({
			actor_id: "coder_agent",
			type: "AGENT_TURN_END",
			payload: { tool_calls_count: event.toolResults?.length ?? 0 },
			caused_by: this.lastEventId ?? this.currentTurnEventId ?? this.currentRootEventId,
		});
		this.currentTurnEventId = undefined;
	}

	private _onMessageStart(event: { type: "message_start"; message: any }): void {
		const msg = event.message;

		if (msg.role === "user") {
			const content = typeof msg.content === "string" ? msg.content : msg.content;
			const appended = this._append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: {
					content,
					session_file: this.session.sessionFile,
				},
			});
			this.currentCorrelationId = appended.event_id;
			this.currentRootEventId = appended.event_id;
			this.lastAgentMessageEventId = undefined;
			this.toolStartEvents.clear();
			return;
		}

		if (msg.role === "assistant") {
			const assistant = msg as AssistantMessage;
			const appended = this._append({
				actor_id: "coder_agent",
				type: "AGENT_MESSAGE_START",
				payload: {
					model: {
						provider: assistant.provider ?? "unknown",
						model_id: assistant.model ?? "unknown",
					},
				},
				caused_by: this.currentTurnEventId ?? this.currentRootEventId,
			});
			this.currentMessageStartEventId = appended.event_id;
		}
	}

	private _onMessageEnd(event: { type: "message_end"; message: any }): void {
		const msg = event.message;

		if (msg.role !== "assistant") return;

		const assistant = msg as AssistantMessage;
		const appended = this._append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: this._normalizeAssistantContent(assistant.content ?? []),
				model: {
					provider: assistant.provider ?? "unknown",
					model_id: assistant.model ?? "unknown",
				},
				usage: {
					input: assistant.usage?.input ?? 0,
					output: assistant.usage?.output ?? 0,
					cache_read: assistant.usage?.cacheRead ?? 0,
					cache_write: assistant.usage?.cacheWrite ?? 0,
					total: assistant.usage?.totalTokens ?? 0,
					cost: assistant.usage?.cost?.total ?? 0,
				},
				stop_reason: this._mapStopReason(assistant.stopReason),
				error_message: assistant.errorMessage,
			},
			caused_by: this.currentMessageStartEventId ?? this.currentTurnEventId ?? this.currentRootEventId,
		});
		this.lastAgentMessageEventId = appended.event_id;
		this.currentMessageStartEventId = undefined;
	}

	private _onToolStart(event: {
		type: "tool_execution_start";
		toolName: string;
		toolCallId: string;
		args: unknown;
	}): void {
		const appended = this._append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: {
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				arguments: event.args as Record<string, unknown>,
			},
			caused_by: this.lastAgentMessageEventId ?? this.currentTurnEventId ?? this.currentRootEventId,
		});
		this.toolStartEvents.set(event.toolCallId, appended.event_id);
	}

	private _onToolUpdate(event: {
		type: "tool_execution_update";
		toolCallId: string;
		toolName: string;
		args: unknown;
		partialResult: unknown;
	}): void {
		this._append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_UPDATE",
			payload: {
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				update: typeof event.partialResult === "string"
					? event.partialResult
					: JSON.stringify(event.partialResult),
			},
			caused_by: this.toolStartEvents.get(event.toolCallId) ?? this.lastEventId ?? this.currentRootEventId,
		});
	}

	private _onToolEnd(event: {
		type: "tool_execution_end";
		toolName: string;
		toolCallId: string;
		result: unknown;
		isError: boolean;
	}): void {
		const content = this._extractContent(event.result);
		this._append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				result: content,
				is_error: event.isError,
				duration_ms: 0,
			},
			caused_by: this.toolStartEvents.get(event.toolCallId) ?? this.lastEventId ?? this.currentRootEventId,
		});
		this.toolStartEvents.delete(event.toolCallId);
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private _append(event: EventAppendInput): EventBase {
		const appended = this.store.append({
			...event,
			correlation_id: event.correlation_id ?? this.currentCorrelationId,
			session_hint: event.session_hint ?? this.session.sessionManager.getSessionId(),
		});
		this.lastEventId = appended.event_id;
		return appended;
	}

	private _extractContent(result: unknown): Array<{ type: string; [key: string]: unknown }> {
		if (!result) return [];
		if (typeof result === "string") {
			return [{ type: "text", text: result }];
		}
		if (Array.isArray(result)) {
			return result as Array<{ type: string; [key: string]: unknown }>;
		}
		if (typeof result === "object") {
			return [result as { type: string; [key: string]: unknown }];
		}
		return [{ type: "text", text: String(result) }];
	}

	private _normalizeAssistantContent(content: unknown[]): Array<{ type: string; [key: string]: unknown }> {
		return content.map((block) => {
			const b = block as {
				type?: string;
				id?: string;
				tool_call_id?: string;
				name?: string;
				tool_name?: string;
				arguments?: unknown;
				[key: string]: unknown;
			};
			if (b.type !== "toolCall") {
				return { ...b, type: typeof b.type === "string" ? b.type : "text" };
			}
			return {
				type: "tool_call",
				id: b.id ?? b.tool_call_id,
				name: b.name ?? b.tool_name,
				arguments: b.arguments ?? {},
			};
		});
	}

	private _mapStopReason(reason: string | undefined): string {
		switch (reason) {
			case "toolUse":
				return "tool_use";
			case "stop":
			case "length":
			case "error":
			case "aborted":
				return reason;
			default:
				return "stop";
		}
	}
}
