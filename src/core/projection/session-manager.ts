/**
 * Session Manager (Event-Sourced)
 *
 * Manages session descriptors, not session data.
 * Data lives in EventStore. Session is just a query view.
 */

import type { EventStore } from "../event-store/store.js";
import { isSessionStore, type SessionStore } from "../event-store/session-store.js";
import type { SessionDescriptor, SessionIndex, ThreadDescriptor } from "./types.js";
import { SessionProjection } from "./session-projection.js";

export interface CreateProjectionSessionOptions {
	parentSessionId?: string;
	threadId?: string;
	startEventId?: string;
	summaryEventId?: string;
	closeActive?: boolean;
}

// ============================================================================
// Session Manager
// ============================================================================

/**
 * SessionManager - manages session descriptors only.
 *
 * Storage: SessionStore implementation (typically SQLite via SqliteEventStore).
 *
 * Does NOT store messages. Tree structure emerges from EventStore's caused_by chain.
 */
export class SessionManager {
	private threads: Map<string, ThreadDescriptor> = new Map();
	private sessions: Map<string, SessionDescriptor> = new Map();
	private activeThreadId: string | undefined;
	private activeSessionId: string | undefined;
	private sessionStore: SessionStore | undefined;

	constructor(
		private store: EventStore,
		sessionStore?: SessionStore,
	) {
		this.sessionStore = sessionStore ?? (isSessionStore(store) ? store : undefined);
		this._loadIndex();
	}

	// =========================================================================
	// Session Operations
	// =========================================================================

	/**
	 * Get or create the active session.
	 */
	getActiveSession(): SessionProjection {
		if (!this.activeThreadId) {
			this.createThread();
		}
		if (!this.activeSessionId) {
			this.createSession("user_explicit", undefined, { threadId: this.activeThreadId });
		}
		const desc = this.sessions.get(this.activeSessionId!)!;
		return new SessionProjection(this.store, desc);
	}

	/**
	 * Create a new session.
	 */
	createSession(
		created_by: SessionDescriptor["created_by"],
		name?: string,
		options: CreateProjectionSessionOptions = {},
	): SessionDescriptor {
		const threadId = options.threadId ?? this.activeThreadId ?? this._createThreadRecord().thread_id;
		const previousActiveId = options.closeActive !== false ? this.activeSessionId : undefined;
		const desc: SessionDescriptor = {
			session_id: this._generateSessionId(),
			thread_id: threadId,
			workspace_id: this.store.workspace_id,
			event_range: {
				start_event_id: options.startEventId ?? this.store.head ?? "ORIGIN",
				end_event_id: "HEAD",
			},
			summary_event_id: options.summaryEventId,
			name,
			created_by,
			parent_session_id: options.parentSessionId,
			created_at: Date.now(),
		};

		this.sessions.set(desc.session_id, desc);
		this.activeSessionId = desc.session_id;

		// Emit session created event
		const createdEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_CREATED",
			payload: { session_id: desc.session_id, name, created_by },
			thread_id: desc.thread_id,
		});

		const previousActive = previousActiveId ? this.sessions.get(previousActiveId) : undefined;
		if (previousActive && previousActive.thread_id === threadId && previousActive.event_range.end_event_id === "HEAD") {
			previousActive.event_range.end_event_id = createdEvent.event_id;
		}
		this._persistIndex();

		return desc;
	}

	/**
	 * Fork the current session at a specific event.
	 */
	forkAt(event_id: string): SessionDescriptor {
		const active = this.getActiveSession();
		const forked = active.fork(event_id);
		this.sessions.set(forked.session_id, forked);
		this.activeSessionId = forked.session_id;
		this._persistIndex();

		this.store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: forked.parent_session_id,
				fork_at_event_id: event_id,
			},
			thread_id: forked.thread_id,
		});

		return forked;
	}

	/**
	 * Fork an existing session while preserving its projected history.
	 *
	 * The source session is frozen at the current head if it was tracking HEAD,
	 * and the forked descriptor reuses the source start boundary so context still
	 * includes the source conversation.
	 *
	 * @param preserveHistory - When true (default), the forked session starts at
	 *   the source's start boundary, preserving the full source conversation.
	 *   When false, the forked session starts at the fork point (the source's
	 *   end boundary or current HEAD), excluding the source's earlier history.
	 *   Use false when the source's history is large and would cause context
	 *   overflow (e.g. forking from an old, long-running session).
	 */
	forkFromSession(session_id: string, options?: { preserveHistory?: boolean }): SessionDescriptor {
		const source = this.sessions.get(session_id);
		if (!source) {
			throw new Error(`Session not found: ${session_id}`);
		}

		const preserveHistory = options?.preserveHistory ?? true;
		const forkAtEventId =
			source.event_range.end_event_id === "HEAD"
				? this.store.head ?? source.event_range.start_event_id
				: source.event_range.end_event_id;
		if (source.event_range.end_event_id === "HEAD") {
			this.activeSessionId = source.session_id;
		}

		const forked = this.createSession("fork", source.name, {
			parentSessionId: source.session_id,
			startEventId: preserveHistory ? source.event_range.start_event_id : forkAtEventId,
			summaryEventId: source.summary_event_id,
		});

		this.store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: source.session_id,
				fork_at_event_id: forkAtEventId,
			},
			thread_id: forked.thread_id,
		});

		return forked;
	}

	/**
	 * Jump to a session in the history tree.
	 *
	 * - Target is already active: no-op.
	 * - Target is still open (`end_event_id === "HEAD"`): switch to it directly.
	 * - Target is closed: reopen it by forking (new session reuses the target's
	 *   start boundary so its conversation history is preserved).
	 *
	 * Emits SESSION_JUMPED so the reactor can refresh its projection.
	 */
	jumpToSession(session_id: string, reason?: string): { descriptor: SessionDescriptor; reopened: boolean } {
		const target = this.sessions.get(session_id);
		if (!target) {
			throw new Error(`Session not found: ${session_id}`);
		}
		if (session_id === this.activeSessionId) {
			return { descriptor: target, reopened: false };
		}

		if (target.event_range.end_event_id === "HEAD") {
			this.activeSessionId = target.session_id;
			this.activeThreadId = target.thread_id;
			this._persistIndex();
			this.store.append({
				actor_id: "runtime",
				type: "SESSION_JUMPED",
				payload: { target_session_id: target.session_id, reason },
				thread_id: target.thread_id,
			});
			return { descriptor: target, reopened: false };
		}

		const reopened = this.forkFromSession(session_id);
		this.store.append({
			actor_id: "runtime",
			type: "SESSION_JUMPED",
			payload: { target_session_id: session_id, reopened_as: reopened.session_id, reason },
			thread_id: reopened.thread_id,
		});
		return { descriptor: reopened, reopened: true };
	}

	/**
	 * List all sessions.
	 */
	listSessions(): SessionDescriptor[] {
		return Array.from(this.sessions.values()).sort((a, b) => b.created_at - a.created_at);
	}

	/**
	 * Switch to a different session.
	 */
	switchTo(session_id: string): void {
		if (!this.sessions.has(session_id)) {
			throw new Error(`Session not found: ${session_id}`);
		}
		this.activeSessionId = session_id;
		this._persistIndex();
	}

	/**
	 * Get a session by ID.
	 */
	getSession(session_id: string): SessionDescriptor | undefined {
		return this.sessions.get(session_id);
	}

	/**
	 * Get session projection by ID.
	 */
	getSessionProjection(session_id: string): SessionProjection | undefined {
		const desc = this.sessions.get(session_id);
		if (!desc) return undefined;
		return new SessionProjection(this.store, desc);
	}

	/**
	 * Update session name.
	 */
	renameSession(session_id: string, name: string): void {
		const desc = this.sessions.get(session_id);
		if (!desc) return;
		desc.name = name;
		this._persistIndex();
	}

	/**
	 * Get the active session ID.
	 */
	getActiveSessionId(): string | undefined {
		return this.activeSessionId;
	}

	getActiveThreadId(): string | undefined {
		return this.activeThreadId;
	}

	getActiveThread(): ThreadDescriptor | undefined {
		return this.activeThreadId ? this.threads.get(this.activeThreadId) : undefined;
	}

	/**
	 * Create a new thread (conversation). Threads are the isolation unit —
	 * events are tagged with thread_id. Creates the first session in the thread.
	 */
	createThread(name?: string): ThreadDescriptor {
		const thread = this._createThreadRecord(name);
		this.createSession("user_explicit", name, { threadId: thread.thread_id });
		this._persistIndex();
		return thread;
	}

	/**
	 * Dispose the session manager.
	 */
	dispose(): void {
		// no-op
	}

	// =========================================================================
	// Internal Methods
	// =========================================================================

	private _loadIndex(): void {
		const index = this.sessionStore?.getSessionIndex();
		if (!index) return;

		for (const thread of index.threads ?? []) {
			this.threads.set(thread.thread_id, thread);
			if (thread.status === "active") {
				this.activeThreadId = thread.thread_id;
			}
		}
		for (const session of index.sessions) {
			this.sessions.set(session.session_id, session);
			if (session.event_range.end_event_id === "HEAD" && session.thread_id === this.activeThreadId) {
				this.activeSessionId = session.session_id;
			}
		}
	}

	private _persistIndex(): void {
		if (!this.sessionStore) return;
		const index: SessionIndex = {
			threads: Array.from(this.threads.values()),
			sessions: Array.from(this.sessions.values()),
		};
		this.sessionStore.saveSessionIndex(index);
	}

	private _generateSessionId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `sess_${timestamp}_${random}`;
	}

	/** Create a thread record (no session). Used by createThread and createSession's auto-thread fallback. */
	private _createThreadRecord(name?: string): ThreadDescriptor {
		const thread: ThreadDescriptor = {
			thread_id: this._generateThreadId(),
			workspace_id: this.store.workspace_id,
			name,
			created_at: Date.now(),
			status: "active",
		};
		this.threads.set(thread.thread_id, thread);
		this.activeThreadId = thread.thread_id;
		return thread;
	}

	private _generateThreadId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `thread_${timestamp}_${random}`;
	}
}
