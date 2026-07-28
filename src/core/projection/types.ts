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
	thread_id: string;
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
	created_by: "user_explicit" | "fork" | "schedule";
	/** Boundary inference reason */
	boundary_reason?: "intent_shift" | "file_drift" | "user_explicit";
	/** Parent session (fork source) */
	parent_session_id?: string;
	/** Creation timestamp */
	created_at: number;
}

// ============================================================================
// Thread Descriptor
// ============================================================================

/**
 * A conversation thread — the isolation unit.
 *
 * One thread = one `thread_id` on events. Threads are fixed once created;
 * session splitting happens at session level (within a thread), never at thread level.
 * A thread contains a tree of sessions (branches from rewind/fork).
 */
export interface ThreadDescriptor {
	thread_id: string;
	workspace_id: string;
	/** User-defined name (e.g. "Q3 marketing") */
	name?: string;
	/** Creation timestamp */
	created_at: number;
	/** Lifecycle status. active = ongoing; closed = user-ended. */
	status: "active" | "closed";
}

/** Session index storage (threads + their session branches) */
export interface SessionIndex {
	threads: ThreadDescriptor[];
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

