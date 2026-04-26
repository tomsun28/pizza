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
	private filePath: string;

	constructor(
		private store: EventStore,
		storagePath?: string,
	) {
		this.inferrer = new SessionBoundaryInferrer();
		this.filePath = storagePath ?? getSessionIndexPath(store.workspace_id);
		this._ensureStorageDir();
		this._loadIndex();
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
	): SessionDescriptor {
		const desc: SessionDescriptor = {
			session_id: this._generateSessionId(),
			workspace_id: this.store.workspace_id,
			event_range: {
				start_event_id: this.store.head ?? "ORIGIN",
				end_event_id: "HEAD",
			},
			name,
			created_by,
			created_at: Date.now(),
		};

		this.sessions.set(desc.session_id, desc);
		this.activeSessionId = desc.session_id;
		this._persistIndex();

		// Emit session created event
		this.store.append({
			actor_id: "runtime",
			type: "SESSION_CREATED",
			payload: { session_id: desc.session_id, name, created_by },
		});

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
		const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	private _loadIndex(): void {
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
