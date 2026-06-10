/**
 * Session Manager (Event-Sourced)
 *
 * Manages session descriptors, not session data.
 * Data lives in EventStore. Session is just a query view.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { EventBase } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import type { SessionDescriptor, SessionIndex } from "./types.js";
import { SessionProjection } from "./session-projection.js";
import { SessionBoundaryInferrer } from "./boundary-inferrer.js";
import { getSessionIndexPath, deriveWorkspaceId } from "../event-store/workspace.js";

export interface CreateProjectionSessionOptions {
	parentSessionId?: string;
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
 * Storage: ~/.pizza/agent/workspaces/<workspace_id>/sessions.json
 *
 * Does NOT store messages. Tree structure emerges from EventStore's caused_by chain.
 */
export class SessionManager {
	private sessions: Map<string, SessionDescriptor> = new Map();
	private activeSessionId: string | undefined;
	private inferrer: SessionBoundaryInferrer;
	private unsubscribe: (() => void) | undefined;
	private filePath: string | undefined;

	constructor(
		private store: EventStore,
		storagePath?: string,
	) {
		this.inferrer = new SessionBoundaryInferrer();
		this.filePath = storagePath === ":memory:" ? undefined : (storagePath ?? getSessionIndexPath(store.workspace_id));
		if (this.filePath) {
			this._ensureStorageDir();
			this._loadIndex();
		}
		this._subscribeToEvents();
	}

	// =========================================================================
	// Session Operations
	// =========================================================================

	/**
	 * Get or create the active session.
	 */
	getActiveSession(): SessionProjection {
		if (!this.activeSessionId) {
			this.createSession("user_explicit");
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
		const previousActiveId = options.closeActive !== false ? this.activeSessionId : undefined;
		const desc: SessionDescriptor = {
			session_id: this._generateSessionId(),
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
		});

		const previousActive = previousActiveId ? this.sessions.get(previousActiveId) : undefined;
		if (previousActive && previousActive.event_range.end_event_id === "HEAD") {
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
		});

		return forked;
	}

	/**
	 * Fork an existing session while preserving its projected history.
	 *
	 * The source session is frozen at the current head if it was tracking HEAD,
	 * and the forked descriptor reuses the source start boundary so context still
	 * includes the source conversation.
	 */
	forkFromSession(session_id: string): SessionDescriptor {
		const source = this.sessions.get(session_id);
		if (!source) {
			throw new Error(`Session not found: ${session_id}`);
		}

		const forkAtEventId =
			source.event_range.end_event_id === "HEAD"
				? this.store.head ?? source.event_range.start_event_id
				: source.event_range.end_event_id;
		if (source.event_range.end_event_id === "HEAD") {
			this.activeSessionId = source.session_id;
		}

		const forked = this.createSession("fork", source.name, {
			parentSessionId: source.session_id,
			startEventId: source.event_range.start_event_id,
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
		});

		return forked;
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

	/**
	 * Dispose the session manager.
	 */
	dispose(): void {
		this.unsubscribe?.();
	}

	// =========================================================================
	// Internal Methods
	// =========================================================================

	private _subscribeToEvents(): void {
		this.unsubscribe = this.store.subscribe((event) => {
			if (event.type === "USER_MESSAGE") {
				this._evaluateBoundary(event);
			}
		}, { types: ["USER_MESSAGE"] });
	}

	private _evaluateBoundary(event: EventBase): void {
		if (!this.activeSessionId) return;

		const current = this.sessions.get(this.activeSessionId);
		if (!current) return;

		// Only evaluate if we're at HEAD
		if (current.event_range.end_event_id !== "HEAD") return;

		const recent = this.store.latest(20);
		const decision = this.inferrer.evaluate(recent, event);

		if (decision.should_split) {
			// End current session's event_range
			const lastEvent = recent[recent.length - 2]; // event before current
			if (lastEvent) {
				current.event_range.end_event_id = lastEvent.event_id;
			}

			// Create new session
			this.createSession("auto_inferred", decision.suggested_name);

			this.store.append({
				actor_id: "runtime",
				type: "SESSION_BOUNDARY_INFERRED",
				payload: {
					reason: decision.reason,
					new_session_id: this.activeSessionId,
				},
				caused_by: event.event_id,
			});
		}
	}

	private _ensureStorageDir(): void {
		if (!this.filePath) return;
		const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	private _loadIndex(): void {
		if (!this.filePath) return;
		if (!existsSync(this.filePath)) return;

		try {
			const content = readFileSync(this.filePath, "utf8");
			const index = JSON.parse(content) as SessionIndex;
			for (const session of index.sessions) {
				this.sessions.set(session.session_id, session);
				if (session.event_range.end_event_id === "HEAD") {
					this.activeSessionId = session.session_id;
				}
			}
		} catch {
			// Start fresh if corrupted
		}
	}

	private _persistIndex(): void {
		if (!this.filePath) return;
		const index: SessionIndex = {
			sessions: Array.from(this.sessions.values()),
		};
		writeFileSync(this.filePath, JSON.stringify(index, null, 2));
	}

	private _generateSessionId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `sess_${timestamp}_${random}`;
	}
}
