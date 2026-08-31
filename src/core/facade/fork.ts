/**
 * Fork preparation for createSessionFacade.
 *
 * Same-workspace forks are zero-copy (a new descriptor referencing the parent
 * event range). Cross-workspace forks currently clone the source context into
 * the target log — see prepareForkedSession for details.
 */

import type { EventBase } from "../event-store/types.js";
import type { EventAppendInput } from "../event-store/store.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import { getEventDatabasePath } from "../event-store/workspace.js";
import { SessionManager as ProjectionSessionManager } from "../projection/session-manager.js";

export interface ForkSource {
	workspaceId: string;
	sessionId: string;
	agentDir?: string;
}

function cloneContextEventForFork(event: EventBase): EventAppendInput {
	return {
		actor_id: event.actor_id,
		type: event.type,
		payload: event.payload,
		timestamp: event.timestamp,
		schema_version: event.schema_version,
	};
}

export function prepareForkedSession(options: {
	store: SqliteEventStore;
	sessionManager: ProjectionSessionManager;
	agentDir: string;
	source: ForkSource;
}): void {
	const { store, sessionManager, agentDir, source } = options;
	if (source.workspaceId === store.workspace_id) {
		sessionManager.forkFromSession(source.sessionId);
		return;
	}

	const sourceAgentDir = source.agentDir ?? agentDir;
	const sourceStore = new SqliteEventStore(
		source.workspaceId,
		getEventDatabasePath(source.workspaceId, sourceAgentDir),
		"session_fork_source",
	);
	const sourceSessionManager = new ProjectionSessionManager(
		sourceStore,
		sourceStore,
	);
	try {
		const sourceProjection = sourceSessionManager.getSessionProjection(source.sessionId);
		if (!sourceProjection) {
			throw new Error(`Session not found: ${source.sessionId}`);
		}

		const sourceDescriptor = sourceProjection.getDescriptor();
		const forkAtEventId =
			sourceDescriptor.event_range.end_event_id === "HEAD"
				? sourceStore.head ?? sourceDescriptor.event_range.start_event_id
				: sourceDescriptor.event_range.end_event_id;
		const forked = sessionManager.createSession("fork", sourceDescriptor.name, {
			parentSessionId: source.sessionId,
		});
		store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: source.sessionId,
				fork_at_event_id: forkAtEventId,
			},
			thread_id: forked.thread_id,
		});
		store.appendBatch(sourceProjection.buildContext().events.map(cloneContextEventForFork));
	} finally {
		sourceSessionManager.dispose();
		sourceStore.close();
	}
}