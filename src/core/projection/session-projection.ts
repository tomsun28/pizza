/**
 * Session Projection
 *
 * Session is a query view over EventStore, not a data holder.
 * Builds LLM context from event queries.
 */

import type { AgentMessage } from "../agent/types.js";
import type { EventBase, EventType } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import type { SessionDescriptor, BuildContextOptions, BuiltContext } from "./types.js";
import type { TimelineEntry, TimelineEntryKind } from "./timeline-projection.js";
import { eventsToMessages } from "./event-to-message.js";

// ============================================================================
// Constants
// ============================================================================

/** Event types that participate in LLM context */
const CONTEXT_RELEVANT_EVENT_TYPES: EventType[] = [
	"USER_MESSAGE",
	"AGENT_MESSAGE_END",
	"TOOL_EXECUTION_END",
	"COMPACTION_END",
	"FILE_MUTATION_APPLIED",
];

// ============================================================================
// Session Projection
// ============================================================================

/**
 * SessionProjection builds LLM context from EventStore queries.
 *
 * Session is a projection/view over events, not a data holder.
 * Multiple sessions can coexist - same events can belong to multiple session views.
 */
export class SessionProjection {
	constructor(
		private store: EventStore,
		private descriptor: SessionDescriptor,
	) {}

	/**
	 * Build LLM-usable context message list.
	 *
	 * Logic:
	 * 1. Query all context-relevant events from event_range
	 * 2. If summary_event_id exists, inject compaction summary first
	 * 3. Convert events to AgentMessage[] format
	 * 4. Apply token budget truncation if needed
	 */
	buildContext(options?: BuildContextOptions): BuiltContext {
		const { start, end } = this._getEventRange();

		const events = this.store.query({
			after: start,
			before: end,
			types: CONTEXT_RELEVANT_EVENT_TYPES,
		});

		let messages = eventsToMessages(events);

		// Inject compaction summary if present
		if (this.descriptor.summary_event_id) {
			const summaryEvent = this.store.get(this.descriptor.summary_event_id);
			if (summaryEvent && summaryEvent.type === "COMPACTION_END") {
				const summaryPayload = summaryEvent.payload as {
					summary: string;
					tokens_before: number;
				};
				// Use compactionSummary message type
				messages.unshift({
					role: "compactionSummary",
					summary: summaryPayload.summary,
					tokensBefore: summaryPayload.tokens_before,
					timestamp: summaryEvent.timestamp,
				} as AgentMessage);
			}
		}

		// Apply token budget if specified
		if (options?.max_tokens) {
			messages = this._truncateByTokens(messages, options.max_tokens);
		}

		return { messages, events, descriptor: this.descriptor };
	}

	/**
	 * Get timeline view for UI display.
	 *
	 * Returns all events in the session's event range, ordered by time.
	 */
	getTimeline(): TimelineEntry[] {
		const { start, end } = this._getEventRange();

		const events = this.store.query({
			after: start,
			before: end,
			reverse: false,
		});

		return events.map((e) => ({
			event_id: e.event_id,
			kind: this._eventTypeToKind(e.type),
			actor_id: e.actor_id,
			timestamp: e.timestamp,
			summary: this._summarizeEvent(e),
			caused_by: e.caused_by,
		}));
	}

	/**
	 * Get the session descriptor.
	 */
	getDescriptor(): SessionDescriptor {
		return this.descriptor;
	}

	/**
	 * Update the session descriptor.
	 */
	updateDescriptor(updates: Partial<SessionDescriptor>): void {
		Object.assign(this.descriptor, updates);
	}

	/**
	 * Fork: create new session descriptor from a specific event.
	 */
	fork(at_event_id: string): SessionDescriptor {
		return {
			session_id: this._generateSessionId(),
			workspace_id: this.store.workspace_id,
			event_range: {
				start_event_id: at_event_id,
				end_event_id: "HEAD",
			},
			created_by: "fork",
			parent_session_id: this.descriptor.session_id,
			created_at: Date.now(),
		};
	}

	/**
	 * Get effective start event_id (ORIGIN if not set).
	 */
	getEffectiveStart(): string {
		return this.descriptor.event_range.start_event_id;
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private _getEventRange(): { start: string | undefined; end: string | undefined } {
		const start = this.descriptor.event_range.start_event_id === "ORIGIN" ? undefined : this.descriptor.event_range.start_event_id;
		const end = this.descriptor.event_range.end_event_id === "HEAD" ? undefined : this.descriptor.event_range.end_event_id;
		return { start, end };
	}

	private _summarizeEvent(event: EventBase): string {
		switch (event.type) {
			case "USER_MESSAGE": {
				const payload = event.payload as { content: string | unknown[] };
				const content = typeof payload.content === "string" ? payload.content : "[Content]";
				return `User: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`;
			}

			case "AGENT_MESSAGE_END": {
				const payload = event.payload as { stop_reason: string };
				return `Agent (stop: ${payload.stop_reason})`;
			}

			case "TOOL_EXECUTION_END": {
				const payload = event.payload as { tool_name: string; is_error: boolean };
				return `${payload.is_error ? "❌" : "✓"} ${payload.tool_name}`;
			}

			case "COMPACTION_END":
				return "📋 Compaction summary applied";

			case "SESSION_CREATED": {
				const payload = event.payload as { name?: string; created_by: string };
				return `Session created: ${payload.name ?? payload.created_by}`;
			}

			case "SESSION_FORKED": {
				const payload = event.payload as { new_session_id: string };
				return `Forked to new session`;
			}

			default:
				return event.type;
		}
	}

	private _truncateByTokens(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
		// Simple truncation: keep recent messages up to token limit
		// In production, use proper token counting
		const estimatedTokensPerMessage = 100; // rough estimate
		const maxMessages = Math.floor(maxTokens / estimatedTokensPerMessage);

		if (messages.length <= maxMessages) {
			return messages;
		}

		// Keep system-equivalent messages + most recent messages
		const systemMessages = messages.filter(
			(m) => m.role === "compactionSummary" || m.role === "branchSummary",
		);
		const otherMessages = messages.filter(
			(m) => m.role !== "compactionSummary" && m.role !== "branchSummary",
		);

		const recentMessages = otherMessages.slice(-maxMessages);
		return [...systemMessages, ...recentMessages];
	}

	private _eventTypeToKind(type: EventType): TimelineEntryKind {
		switch (type) {
			case "USER_MESSAGE":
				return "user_message";
			case "AGENT_MESSAGE_START":
			case "AGENT_MESSAGE_CHUNK":
			case "AGENT_MESSAGE_END":
				return "agent_message";
			case "TOOL_EXECUTION_START":
			case "TOOL_EXECUTION_UPDATE":
			case "TOOL_EXECUTION_END":
				return "tool_execution";
			case "FILE_MUTATION_APPLIED":
				return "file_mutation";
			case "GOAL_CREATED":
			case "GOAL_CLASSIFIED":
			case "GOAL_PLANNED":
			case "GOAL_PAUSED":
			case "GOAL_RESUMED":
			case "GOAL_COMPLETED":
			case "GOAL_CANCELLED":
				return "goal_event";
			case "TASK_CREATED":
			case "TASK_ASSIGNED":
			case "TASK_STARTED":
			case "TASK_PROGRESS":
			case "TASK_COMPLETED":
			case "TASK_FAILED":
			case "TASK_REWORK_REQUESTED":
			case "TASK_ACCEPTED":
			case "TASK_CANCELLED":
				return "task_event";
			case "SESSION_CREATED":
			case "SESSION_BOUNDARY_INFERRED":
			case "SESSION_FORKED":
				return "session_boundary";
			case "COMPACTION_REQUESTED":
			case "COMPACTION_START":
			case "COMPACTION_END":
				return "compaction";
			case "RUNTIME_ERROR":
				return "error";
			case "CHECKPOINT_CREATED":
			case "CHECKPOINT_RESTORED":
			case "CHECKPOINT_FAILED":
				return "checkpoint";
			default:
				return "agent_message";
		}
	}

	private _generateSessionId(): string {
		// Use UUIDv7-like format
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `sess_${timestamp}_${random}`;
	}
}
