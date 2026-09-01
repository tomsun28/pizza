/**
 * Session index reducer — the session tree as a pure projection of the log.
 *
 * Applies SESSION_* / THREAD_* events to a mutable index state (threads +
 * sessions maps). The SAME reducer is used by:
 *   - SessionManager for live updates (append event → applyIndexEvent), and
 *   - rebuildSessionIndex / loadSessionIndex for replay from the log,
 * which guarantees a replay converges to the same state as the live path.
 *
 * The SQLite snapshot (threads/sessions tables) is a CACHE with a sequence
 * watermark: loading = snapshot + replay of events after the watermark. A
 * crash between event append and snapshot persist is therefore self-healing —
 * the un-persisted boundary mutations are recovered from the log on next load.
 *
 * Legacy tolerance: events written before the payloads carried full
 * descriptor fields (start_event_id etc.) fall back to the event envelope
 * (event_id / thread_id / timestamp). Sessions created by those events may
 * have an approximate start boundary; the snapshot row (which was written by
 * the live path with exact values) wins when present because replay starts
 * from the watermark, not from ORIGIN.
 */

import type { EventBase } from "../event-store/types.js";
import type {
	SessionCreatedEvent,
	SessionForkedEvent,
	SessionJumpedEvent,
	SessionRenamedEvent,
	ThreadStatusChangedEvent,
} from "../event-store/events.js";
import type { SessionDescriptor, ThreadDescriptor } from "./types.js";

export interface SessionIndexState {
	threads: Map<string, ThreadDescriptor>;
	sessions: Map<string, SessionDescriptor>;
}

/** Event types that mutate the session index. Used for replay queries. */
export const SESSION_INDEX_EVENT_TYPES = [
	"SESSION_CREATED",
	"SESSION_FORKED",
	"SESSION_JUMPED",
	"SESSION_RENAMED",
	"THREAD_STATUS_CHANGED",
] as const;

function closeSession(state: SessionIndexState, sessionId: string | undefined, endEventId: string): void {
	if (!sessionId) return;
	const session = state.sessions.get(sessionId);
	if (session && session.event_range.end_event_id === "HEAD") {
		session.event_range.end_event_id = endEventId;
	}
}

function applySessionCreated(state: SessionIndexState, event: SessionCreatedEvent): void {
	const p = event.payload;
	if (p.thread && !state.threads.has(p.thread.thread_id)) {
		state.threads.set(p.thread.thread_id, {
			thread_id: p.thread.thread_id,
			workspace_id: event.workspace_id,
			name: p.thread.name,
			created_at: p.thread.created_at,
			status: p.thread.status,
		});
	}
	if (!state.sessions.has(p.session_id)) {
		state.sessions.set(p.session_id, {
			session_id: p.session_id,
			thread_id: event.thread_id ?? p.thread?.thread_id ?? "",
			workspace_id: event.workspace_id,
			event_range: {
				// Legacy events lack start_event_id: approximate with the
				// creation event itself (the session starts at its creation).
				start_event_id: p.start_event_id ?? event.event_id,
				end_event_id: "HEAD",
			},
			summary_event_id: p.summary_event_id,
			name: p.name,
			created_by: p.created_by,
			parent_session_id: p.parent_session_id,
			context_parent_session_id: p.context_parent_session_id,
			source_ref: p.source_ref,
			created_at: p.created_at ?? event.timestamp,
		});
	}
	closeSession(state, p.closes_session_id, event.event_id);
}

function applySessionForked(state: SessionIndexState, event: SessionForkedEvent): void {
	const p = event.payload;
	// forkAt() emits SESSION_FORKED without a prior SESSION_CREATED; create
	// the descriptor from the fork payload when it is not already indexed.
	// (forkFromSession() goes through createSession first, so the descriptor
	// already exists and this is a no-op for it.)
	if (!state.sessions.has(p.new_session_id)) {
		state.sessions.set(p.new_session_id, {
			session_id: p.new_session_id,
			thread_id: event.thread_id ?? "",
			workspace_id: event.workspace_id,
			event_range: {
				start_event_id: p.start_event_id ?? p.fork_at_event_id,
				end_event_id: "HEAD",
			},
			summary_event_id: p.summary_event_id,
			name: p.name,
			created_by: "fork",
			parent_session_id: p.parent_session_id,
			context_parent_session_id: p.context_parent_session_id,
			source_ref: p.source_ref,
			created_at: p.created_at ?? event.timestamp,
		});
	}
	closeSession(state, p.closes_session_id, event.event_id);
}

function applySessionJumped(state: SessionIndexState, event: SessionJumpedEvent): void {
	closeSession(state, event.payload.closes_session_id, event.event_id);
}

function applySessionRenamed(state: SessionIndexState, event: SessionRenamedEvent): void {
	const session = state.sessions.get(event.payload.session_id);
	if (session) {
		session.name = event.payload.name;
	}
}

function applyThreadStatusChanged(state: SessionIndexState, event: ThreadStatusChangedEvent): void {
	const thread = state.threads.get(event.payload.thread_id);
	if (thread) {
		thread.status = event.payload.status;
	}
}

/**
 * Apply a single event to the index state. Unknown/unrelated event types are
 * ignored so callers can feed a raw event stream.
 */
export function applyIndexEvent(state: SessionIndexState, event: EventBase): void {
	switch (event.type) {
		case "SESSION_CREATED":
			applySessionCreated(state, event as SessionCreatedEvent);
			break;
		case "SESSION_FORKED":
			applySessionForked(state, event as SessionForkedEvent);
			break;
		case "SESSION_JUMPED":
			applySessionJumped(state, event as SessionJumpedEvent);
			break;
		case "SESSION_RENAMED":
			applySessionRenamed(state, event as SessionRenamedEvent);
			break;
		case "THREAD_STATUS_CHANGED":
			applyThreadStatusChanged(state, event as ThreadStatusChangedEvent);
			break;
		default:
			break;
	}
}

/** Query surface the replay helpers need (subset of EventStore). */
export interface IndexEventSource {
	query(filter: {
		types?: string[];
		after_sequence?: number;
	}): EventBase[];
}

/**
 * Rebuild the full session index from the log (no snapshot). The recovery
 * path for a lost or corrupted snapshot.
 */
export function rebuildSessionIndex(store: IndexEventSource): SessionIndexState {
	const state: SessionIndexState = { threads: new Map(), sessions: new Map() };
	for (const event of store.query({ types: [...SESSION_INDEX_EVENT_TYPES] })) {
		applyIndexEvent(state, event);
	}
	return state;
}

/**
 * Replay index events after a snapshot watermark onto snapshot state.
 * Self-heals boundary mutations that were appended to the log but whose
 * snapshot persist was lost (crash between append and persist).
 */
export function replayIndexEventsAfter(
	state: SessionIndexState,
	store: IndexEventSource,
	afterSequence: number,
): void {
	for (const event of store.query({ types: [...SESSION_INDEX_EVENT_TYPES], after_sequence: afterSequence })) {
		applyIndexEvent(state, event);
	}
}