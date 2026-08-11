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
	contextParentSessionId?: string;
	threadId?: string;
	startEventId?: string;
	summaryEventId?: string;
	closeActive?: boolean;
}

export interface SwitchToExistingSessionOptions {
	closePrevious?: "same-thread" | "always" | "never";
	background?: boolean;
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
		return new SessionProjection(this.store, desc, (sessionId) => this.sessions.get(sessionId));
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
			context_parent_session_id: options.contextParentSessionId,
			created_at: Date.now(),
		};

		this.sessions.set(desc.session_id, desc);
		this.activeSessionId = desc.session_id;
		this.activeThreadId = desc.thread_id;

		// Emit session created event
		const createdEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_CREATED",
			payload: {
				session_id: desc.session_id,
				name,
				created_by,
				parent_session_id: desc.parent_session_id,
				context_parent_session_id: desc.context_parent_session_id,
			},
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
		const source = active.getDescriptor();
		const forked = active.fork(event_id);
		this.sessions.set(forked.session_id, forked);
		this.activeSessionId = forked.session_id;
		this.activeThreadId = forked.thread_id;

		const forkedEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: forked.parent_session_id,
				fork_at_event_id: event_id,
			},
			thread_id: forked.thread_id,
		});
		if (source.event_range.end_event_id === "HEAD") {
			source.event_range.end_event_id = forkedEvent.event_id;
		}
		this._persistIndex();

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
		const previousActive =
			this.activeSessionId && this.activeSessionId !== source.session_id
				? this.sessions.get(this.activeSessionId)
				: undefined;

		const preserveHistory = options?.preserveHistory ?? true;
		const forkAtEventId =
			source.event_range.end_event_id === "HEAD"
				? this.store.head ?? source.event_range.start_event_id
				: source.event_range.end_event_id;
		if (source.event_range.end_event_id === "HEAD") {
			this.activeSessionId = source.session_id;
			this.activeThreadId = source.thread_id;
			this._promoteThreadToActive(source.thread_id);
		}

		const forked = this.createSession("fork", source.name, {
			parentSessionId: source.session_id,
			startEventId: preserveHistory ? source.event_range.start_event_id : forkAtEventId,
			summaryEventId: source.summary_event_id,
			threadId: source.thread_id,
		});

		const forkedEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: source.session_id,
				fork_at_event_id: forkAtEventId,
			},
			thread_id: forked.thread_id,
		});
		if (previousActive?.event_range.end_event_id === "HEAD") {
			previousActive.event_range.end_event_id = forkedEvent.event_id;
			this._persistIndex();
		}

		return forked;
	}

	/**
	 * If the active session is a closed historical view, make it writable before
	 * appending a prompt. We reuse an existing open continuation when possible;
	 * otherwise we create one in a fresh thread and prepend the closed source's
	 * context via context_parent_session_id.
	 */
	ensureActiveSessionWritable(reason?: string): SessionDescriptor | undefined {
		const activeId = this.activeSessionId;
		if (!activeId) return undefined;
		const active = this.sessions.get(activeId);
		if (!active || active.event_range.end_event_id === "HEAD") return active;

		const reusable = Array.from(this.sessions.values())
			.filter((session) =>
				session.context_parent_session_id === active.session_id &&
				session.event_range.end_event_id === "HEAD"
			)
			.sort((a, b) => b.created_at - a.created_at)[0];
		if (reusable) {
			this.switchToExistingSession(reusable.session_id, reason ?? "continue historical session", {
				closePrevious: "never",
				background: true,
			});
			return reusable;
		}

		const thread = this._createThreadRecord(active.name);
		const continuation = this.createSession("fork", active.name, {
			parentSessionId: active.session_id,
			contextParentSessionId: active.session_id,
			threadId: thread.thread_id,
			startEventId: this.store.head ?? active.event_range.end_event_id,
			closeActive: false,
		});
		this.store.append({
			actor_id: "runtime",
			type: "SESSION_JUMPED",
			payload: {
				target_session_id: active.session_id,
				reopened_as: continuation.session_id,
				reason: reason ?? "continue historical session",
				direct: true,
				background: true,
			},
			thread_id: continuation.thread_id,
		});
		this._persistIndex();
		return continuation;
	}

	/**
	 * Return the newest open continuation for a closed visible session.
	 *
	 * Internal continuations are hidden from the history tree, so selecting the
	 * visible source should land on its writable continuation when one exists.
	 */
	getOpenContinuationForSession(session_id: string): SessionDescriptor | undefined {
		return Array.from(this.sessions.values())
			.filter((session) =>
				session.context_parent_session_id === session_id &&
				session.event_range.end_event_id === "HEAD"
			)
			.sort((a, b) => b.created_at - a.created_at)[0];
	}

	/**
	 * Resolve a UI-visible history node to the session that should become active.
	 * Open targets switch directly; closed targets reuse their open continuation
	 * when present, otherwise they remain inspect-only and switch directly.
	 */
	resolveSwitchTargetSession(session_id: string): SessionDescriptor {
		const target = this.sessions.get(session_id);
		if (!target) {
			throw new Error(`Session not found: ${session_id}`);
		}
		if (target.event_range.end_event_id === "HEAD") {
			return target;
		}
		return this.getOpenContinuationForSession(session_id) ?? target;
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
		if (session_id === this.activeSessionId && target.event_range.end_event_id === "HEAD") {
			return { descriptor: target, reopened: false };
		}

		if (target.event_range.end_event_id === "HEAD") {
			this.switchToExistingSession(target.session_id, reason);
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
		const target = this.sessions.get(session_id);
		if (!target) {
			throw new Error(`Session not found: ${session_id}`);
		}
		this.activeSessionId = target.session_id;
		this.activeThreadId = target.thread_id;
		this._promoteThreadToActive(target.thread_id);
		this._persistIndex();
	}

	/**
	 * Switch to an existing session without reopening/forking it.
	 *
	 * This is intentionally different from jumpToSession(): closed sessions stay
	 * closed, so the UI can inspect them without creating another branch.
	 */
	switchToExistingSession(
		session_id: string,
		reason?: string,
		options: SwitchToExistingSessionOptions = {},
	): SessionDescriptor {
		const target = this.sessions.get(session_id);
		if (!target) {
			throw new Error(`Session not found: ${session_id}`);
		}
		// `background: true` marks a scheduler-driven switch (it hops into the
		// task's pinned session and hops back). Those must never promote a
		// background thread — only an explicit user navigation does.
		const userInitiated = options.background !== true;
		if (session_id === this.activeSessionId && target.thread_id === this.activeThreadId) {
			// Already here — still promote, otherwise a user sitting in a
			// background thread never gets it promoted (the switch that brought
			// them here may have been the scheduler's).
			if (userInitiated && this._promoteThreadToActive(target.thread_id)) {
				this._persistIndex();
			}
			return target;
		}
		const previousActive =
			this.activeSessionId && this.activeSessionId !== target.session_id
				? this.sessions.get(this.activeSessionId)
				: undefined;
		this.activeSessionId = target.session_id;
		this.activeThreadId = target.thread_id;
		if (userInitiated) this._promoteThreadToActive(target.thread_id);
		const jumpedEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_JUMPED",
			payload: { target_session_id: target.session_id, reason, direct: true, background: options.background },
			thread_id: target.thread_id,
		});
		if (previousActive?.event_range.end_event_id === "HEAD") {
			const closePrevious = options.closePrevious ?? "same-thread";
			const shouldClose =
				closePrevious === "always" ||
				(closePrevious === "same-thread" && previousActive.thread_id === target.thread_id);
			if (shouldClose) {
				previousActive.event_range.end_event_id = jumpedEvent.event_id;
			}
		}
		this._persistIndex();
		return target;
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
		return new SessionProjection(this.store, desc, (id) => this.sessions.get(id));
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
	createThread(name?: string, created_by: SessionDescriptor["created_by"] = "user_explicit"): ThreadDescriptor {
		// Scheduler-created threads are background threads: they exist to
		// isolate automated/scheduled turns from the interactive thread.
		// Background threads are never auto-selected as the active thread on
		// reload (see _loadIndex), so a leftover scheduled thread cannot
		// hijack the chat after a restart.
		const status: ThreadDescriptor["status"] = created_by === "schedule" ? "background" : "active";
		const thread = this._createThreadRecord(name, status);
		this.createSession(created_by, name, { threadId: thread.thread_id });
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

		// Load threads (without selecting an active thread yet) and index all
		// sessions first. The active thread is chosen deterministically below.
		for (const thread of index.threads ?? []) {
			this.threads.set(thread.thread_id, thread);
		}
		for (const session of index.sessions) {
			this.sessions.set(session.session_id, session);
		}

		// Deterministically select the active thread on reload.
		//
		// Background threads (created by the scheduler for automated tasks)
		// must NEVER be auto-selected as the interactive active thread —
		// otherwise a leftover background thread hijacks the user's chat on
		// every restart (the bug where user prompts landed in the wrong thread).
		//
		// Among interactive threads (status "active"), pick the one whose most
		// recent session was created latest — i.e. the thread the user was
		// actually last working in. This replaces the previous "last active
		// thread wins" behavior, which depended on storage iteration order and
		// could nondeterministically select a stale thread.
		const interactiveThreadIds = new Set(
			(index.threads ?? []).filter((t) => t.status === "active").map((t) => t.thread_id),
		);
		if (interactiveThreadIds.size > 0) {
			// Build a thread-created-at lookup so ties on session.created_at are
			// broken deterministically by thread recency (never by iteration order).
			const threadCreatedAt = new Map<string, number>();
			for (const thread of index.threads ?? []) {
				threadCreatedAt.set(thread.thread_id, thread.created_at);
			}
			let bestThreadId: string | undefined;
			let bestSessionCreatedAt = -1;
			let bestThreadCreatedAt = -1;
			for (const session of this.sessions.values()) {
				if (!interactiveThreadIds.has(session.thread_id)) continue;
				const tca = threadCreatedAt.get(session.thread_id) ?? 0;
				// Pick the thread whose latest session is newest; break ties by
				// thread recency so the result is deterministic.
				if (
					session.created_at > bestSessionCreatedAt ||
					(session.created_at === bestSessionCreatedAt && tca > bestThreadCreatedAt)
				) {
					bestSessionCreatedAt = session.created_at;
					bestThreadCreatedAt = tca;
					bestThreadId = session.thread_id;
				}
			}
			// Fallback: if an interactive thread has no sessions, take the most
			// recently created interactive thread.
			if (!bestThreadId) {
				bestThreadId = (index.threads ?? [])
					.filter((t) => t.status === "active")
					.sort((a, b) => b.created_at - a.created_at)[0]?.thread_id;
			}
			if (bestThreadId) this.activeThreadId = bestThreadId;
		}

		// Resolve the active session: the one at HEAD within the active thread.
		for (const session of this.sessions.values()) {
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

	/** Create a thread record (no session). Used by createThread and createSession auto-thread fallback. The status defaults to active; pass background for scheduler threads. */
	private _createThreadRecord(name?: string, status: ThreadDescriptor["status"] = "active"): ThreadDescriptor {
		const thread: ThreadDescriptor = {
			thread_id: this._generateThreadId(),
			workspace_id: this.store.workspace_id,
			name,
			created_at: Date.now(),
			status,
		};
		this.threads.set(thread.thread_id, thread);
		this.activeThreadId = thread.thread_id;
		return thread;
	}

	/**
	 * Promote a background thread to active when the user explicitly
	 * navigates into it (history tree click / jump / switch). Once a user
	 * has interacted with a scheduled thread, it should participate in
	 * active-thread selection on future reloads like any interactive thread.
	 * No-op for threads that are already active. Closed threads are not
	 * re-opened here.
	 *
	 * Returns true when the status actually changed, so callers that are not
	 * already persisting the index can do so.
	 */
	private _promoteThreadToActive(threadId: string | undefined): boolean {
		if (!threadId) return false;
		const thread = this.threads.get(threadId);
		if (thread?.status !== "background") return false;
		thread.status = "active";
		return true;
	}

	private _generateThreadId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `thread_${timestamp}_${random}`;
	}
}
