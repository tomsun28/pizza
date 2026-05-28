/**
 * Dual-Write EventStore
 *
 * Uses SQLite as the primary store for queries and subscriptions,
 * and optionally mirrors all appends to a JSONL backend for human-readable
 * audit trails and debugging.
 *
 * The JSONL mirror is write-only from this adapter's perspective —
 * all reads go through SQLite.
 */

import type { EventBase } from "./types.js";
import type { EventAppendInput, EventQuery, EventStore, SubscribeOptions } from "./store.js";
import { SqliteEventStore } from "./sqlite-store.js";
import { JsonlEventStore } from "./jsonl-store.js";
import { deriveWorkspaceId, getEventDatabasePath, getEventLogDir } from "./workspace.js";

// ============================================================================
// Dual-Write Store
// ============================================================================

export interface DualStoreOptions {
	/** Working directory (used to derive workspace_id) */
	cwd: string;
	/** Agent directory for storage */
	agentDir?: string;
	/** SQLite database path override */
	sqlitePath?: string;
	/** JSONL directory path override */
	jsonlPath?: string;
	/** Runtime identifier */
	runtimeId?: string;
	/** Whether to enable JSONL mirroring (default: true) */
	enableMirror?: boolean;
}

/**
 * DualWriteEventStore — SQLite primary + optional JSONL mirror.
 *
 * All queries and subscriptions go through SQLite for performance.
 * Appends are dual-written to JSONL for human-readable auditing.
 */
export class DualWriteEventStore implements EventStore {
	private primary: SqliteEventStore;
	private mirror: JsonlEventStore | undefined;

	readonly workspace_id: string;

	constructor(options: DualStoreOptions) {
		const workspaceId = deriveWorkspaceId(options.cwd);
		this.workspace_id = workspaceId;

		// Primary: SQLite
		const sqlitePath = options.sqlitePath ?? getEventDatabasePath(workspaceId, options.agentDir);
		this.primary = new SqliteEventStore(workspaceId, sqlitePath, options.runtimeId);

		// Mirror: JSONL (optional, enabled by default)
		if (options.enableMirror !== false) {
			const jsonlPath = options.jsonlPath ?? getEventLogDir(workspaceId, options.agentDir);
			this.mirror = new JsonlEventStore(workspaceId, jsonlPath, options.runtimeId);
		}
	}

	// =========================================================================
	// EventStore Interface — delegates to SQLite primary
	// =========================================================================

	append(event: EventAppendInput): EventBase {
		const result = this.primary.append(event);
		// Mirror the complete event (not the input) so JSONL has the full record
		this._mirrorEvent(result);
		return result;
	}

	appendBatch(events: EventAppendInput[]): EventBase[] {
		const results = this.primary.appendBatch(events);
		for (const result of results) {
			this._mirrorEvent(result);
		}
		return results;
	}

	query(filter: EventQuery): EventBase[] {
		return this.primary.query(filter);
	}

	get(event_id: string): EventBase | undefined {
		return this.primary.get(event_id);
	}

	latest(count: number): EventBase[] {
		return this.primary.latest(count);
	}

	getCausalChain(event_id: string): EventBase[] {
		return this.primary.getCausalChain(event_id);
	}

	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		return this.primary.subscribe(handler, options);
	}

	get size(): number {
		return this.primary.size;
	}

	get head(): string | undefined {
		return this.primary.head;
	}

	get head_sequence(): number {
		return this.primary.head_sequence;
	}

	// =========================================================================
	// Additional Methods
	// =========================================================================

	/**
	 * Close both stores.
	 */
	close(): void {
		this.primary.close();
	}

	/**
	 * Get the primary SQLite store (for direct access if needed).
	 */
	getPrimary(): SqliteEventStore {
		return this.primary;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private _mirrorEvent(event: EventBase): void {
		if (!this.mirror) return;
		try {
			// Append to JSONL mirror. Since mirror maintains its own sequences,
			// we pass the complete event with pre-assigned fields.
			this.mirror.append({
				...event,
			});
		} catch {
			// Mirror failures should not break the primary write path.
			// In production this could be logged to a separate error channel.
		}
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a DualWriteEventStore for a workspace.
 */
export function createDualStore(cwd: string, agentDir?: string, runtimeId?: string): DualWriteEventStore {
	return new DualWriteEventStore({ cwd, agentDir, runtimeId });
}
