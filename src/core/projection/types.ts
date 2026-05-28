/**
 * Session Projection Types
 *
 * Session is a query view over the EventStore, not a data holder.
 */

import type { EventBase } from "../event-store/types.js";

// ============================================================================
// Session Descriptor
// ============================================================================

/** Session definition - pure reference structure */
export interface SessionDescriptor {
	session_id: string;
	workspace_id: string;
	/** Event range covered by this session [start, end] (inclusive) */
	event_range: {
		start_event_id: string;
		end_event_id: string; // "HEAD" = tracking latest
	};
	/** Summary reference (compaction event_id) */
	summary_event_id?: string;
	/** User-defined name */
	name?: string;
	/** Creation method */
	created_by: "user_explicit" | "auto_inferred" | "fork";
	/** Boundary inference reason */
	boundary_reason?: "intent_shift" | "file_drift" | "time_gap" | "user_explicit";
	/** Parent session (fork source) */
	parent_session_id?: string;
	/** Creation timestamp */
	created_at: number;
}

/** Session list storage */
export interface SessionIndex {
	sessions: SessionDescriptor[];
}

// ============================================================================
// Build Context
// ============================================================================

/** Options for building LLM context */
export interface BuildContextOptions {
	/** Token budget */
	max_tokens?: number;
	/** Include tool execution details */
	include_tool_details?: boolean;
	/** Include file mutations */
	include_file_mutations?: boolean;
}

/** Built context result */
export interface BuiltContext {
	/** Messages for LLM consumption */
	messages: import("../agent/types.js").AgentMessage[];
	/** Raw events used to build context */
	events: EventBase[];
	/** Session descriptor */
	descriptor: SessionDescriptor;
}

