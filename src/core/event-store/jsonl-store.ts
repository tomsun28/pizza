/**
 * JSONL EventStore Implementation
 *
 * Persists events to daily files: events-YYYY-MM-DD.jsonl
 * Maintains in-memory indexes for fast querying.
 * Files are loaded on demand by date.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { v7 as uuidv7 } from "uuid";
import type { EventBase } from "./types.js";
import type { EventAppendInput, EventQuery, EventStore, SubscribeOptions } from "./store.js";
import {
	deriveWorkspaceId,
	getEventLogDir,
	getEventLogPathInDir,
	getTodayDate,
} from "./workspace.js";

/**
 * JSONL-backed EventStore implementation.
 *
 * Features:
 * - Daily append-only files (events-YYYY-MM-DD.jsonl)
 * - Lazy loading: only loads today's file on init, other dates on demand
 * - In-memory indexes (byId, byType, byCausedBy)
 * - Real-time subscriptions via EventEmitter
 * - UUIDv7 ensures time-ordered event IDs
 */
export class JsonlEventStore implements EventStore {
	// In-memory indexes
	private events: EventBase[] = [];
	private byId: Map<string, EventBase> = new Map();
	private byType: Map<string, EventBase[]> = new Map();
	private byCausedBy: Map<string, EventBase[]> = new Map();
	private byIdempotencyKey: Map<string, EventBase> = new Map();
	private loadedDates: Set<string> = new Set();
	private nextSequence = 1;

	// Subscription management
	private emitter = new EventEmitter();
	private subscribers: Map<number, { handler: (event: EventBase) => void; options?: SubscribeOptions }> = new Map();
	private nextSubId = 0;

	// Persistence
	private workspaceDir: string;
	private currentDate: string;
	private runtimeId: string;

	readonly workspace_id: string;

	constructor(workspaceId: string, storagePath?: string, runtimeId = "local_runtime") {
		this.workspace_id = workspaceId;
		this.workspaceDir = storagePath ?? getEventLogDir(workspaceId);
		this.currentDate = getTodayDate();
		this.runtimeId = runtimeId;

		if (!existsSync(this.workspaceDir)) {
			mkdirSync(this.workspaceDir, { recursive: true });
		}

		// Load today's events immediately
		this._loadDate(this.currentDate);
	}

	// =========================================================================
	// Public API (EventStore interface)
	// =========================================================================

	append(partial: EventAppendInput): EventBase {
		if (partial.idempotency_key) {
			const existing = this.byIdempotencyKey.get(partial.idempotency_key);
			if (existing) return existing;
		}

		const now = Date.now();
		const date = new Date(now).toISOString().slice(0, 10);

		const event: EventBase = {
			...partial,
			sequence: partial.sequence ?? this.nextSequence++,
			event_id: partial.event_id ?? uuidv7(),
			timestamp: partial.timestamp ?? now,
			workspace_id: this.workspace_id,
			runtime_id: partial.runtime_id ?? this.runtimeId,
			schema_version: partial.schema_version ?? 1,
		};

		this._index(event);

		// Rotate to new date file if needed
		if (date !== this.currentDate) {
			this.currentDate = date;
		}

		this._persist(event);
		this._notify(event);

		return event;
	}

	appendBatch(
		partials: EventAppendInput[],
	): EventBase[] {
		const events: EventBase[] = [];
		const newEvents: EventBase[] = [];
		for (const partial of partials) {
			if (partial.idempotency_key) {
				const existing = this.byIdempotencyKey.get(partial.idempotency_key);
				if (existing) {
					events.push(existing);
					continue;
				}
			}
			const event: EventBase = {
				...partial,
				sequence: partial.sequence ?? this.nextSequence++,
				event_id: partial.event_id ?? uuidv7(),
				timestamp: partial.timestamp ?? Date.now(),
				workspace_id: this.workspace_id,
				runtime_id: partial.runtime_id ?? this.runtimeId,
				schema_version: partial.schema_version ?? 1,
			};
			events.push(event);
			newEvents.push(event);
		}

		for (const event of newEvents) {
			this._index(event);
		}

		// Group events by date for batch writes
		const byDate = new Map<string, EventBase[]>();
		for (const event of newEvents) {
			const date = new Date(event.timestamp).toISOString().slice(0, 10);
			if (!byDate.has(date)) byDate.set(date, []);
			byDate.get(date)!.push(event);
		}

		// Write each date file
		for (const [date, evts] of byDate) {
			const path = getEventLogPathInDir(this.workspaceDir, date);
			const line = evts.map((e) => JSON.stringify(e)).join("\n") + "\n";
			appendFileSync(path, line);
		}

		// Update current date
		const today = getTodayDate();
		if (byDate.has(today)) {
			this.currentDate = today;
		}

		for (const event of newEvents) {
			this._notify(event);
		}

		return events;
	}

	query(filter: EventQuery): EventBase[] {
		this._loadAll();
		let results = this.events;

		// Filter by after_sequence (exclusive)
		if (filter.after_sequence !== undefined) {
			results = results.filter((e) => e.sequence > filter.after_sequence!);
		}

		// Filter by before_sequence (exclusive)
		if (filter.before_sequence !== undefined) {
			results = results.filter((e) => e.sequence < filter.before_sequence!);
		}

		// Filter by after (exclusive)
		if (filter.after) {
			const afterIdx = this.events.findIndex((e) => e.event_id === filter.after);
			if (afterIdx >= 0) {
				results = results.slice(afterIdx + 1);
			}
		}

		// Filter by before (exclusive)
		if (filter.before) {
			const beforeIdx = results.findIndex((e) => e.event_id === filter.before);
			if (beforeIdx >= 0) {
				results = results.slice(0, beforeIdx);
			}
		}

		// Filter by types
		if (filter.types && filter.types.length > 0) {
			const typeSet = new Set(filter.types);
			results = results.filter((e) => typeSet.has(e.type));
		}

		// Filter by actor_ids
		if (filter.actor_ids && filter.actor_ids.length > 0) {
			const actorSet = new Set(filter.actor_ids);
			results = results.filter((e) => actorSet.has(e.actor_id));
		}

		// Filter by caused_by
		if (filter.caused_by) {
			const descendants = new Set<string>();
			const stack = [filter.caused_by];
			while (stack.length > 0) {
				const current = stack.pop()!;
				const children = this.byCausedBy.get(current) ?? [];
				for (const child of children) {
					if (!descendants.has(child.event_id)) {
						descendants.add(child.event_id);
						stack.push(child.event_id);
					}
				}
			}
			results = results.filter((e) => descendants.has(e.event_id));
		}

		// Filter by session_hint
		if (filter.session_hint) {
			results = results.filter((e) => e.session_hint === filter.session_hint);
		}

		// Reverse
		if (filter.reverse) {
			results = results.slice().reverse();
		}

		// Limit
		if (filter.limit && filter.limit > 0) {
			results = results.slice(0, filter.limit);
		}

		return results;
	}

	get(event_id: string): EventBase | undefined {
		if (!this.byId.has(event_id)) {
			this._loadAll();
		}
		return this.byId.get(event_id);
	}

	latest(count: number): EventBase[] {
		this._loadAll();
		return this.events.slice(-count);
	}

	getCausalChain(event_id: string): EventBase[] {
		this._loadAll();
		const chain: EventBase[] = [];
		let currentId: string | undefined = event_id;

		while (currentId) {
			const event = this.byId.get(currentId);
			if (!event) break;
			chain.unshift(event);
			currentId = event.caused_by;
		}

		return chain;
	}

	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		const subId = this.nextSubId++;
		this.subscribers.set(subId, { handler, options });
		return () => this.subscribers.delete(subId);
	}

	get size(): number {
		this._loadAll();
		return this.events.length;
	}

	get head(): string | undefined {
		this._loadAll();
		return this.events.length > 0 ? this.events[this.events.length - 1].event_id : undefined;
	}

	get head_sequence(): number {
		this._loadAll();
		return this.nextSequence - 1;
	}

	// =========================================================================
	// Internal Methods
	// =========================================================================

	private _index(event: EventBase): void {
		if (this.byId.has(event.event_id)) return;
		this.events.push(event);
		this.events.sort((a, b) => a.sequence - b.sequence || a.timestamp - b.timestamp);
		this.byId.set(event.event_id, event);
		this.nextSequence = Math.max(this.nextSequence, event.sequence + 1);

		// Index by type
		if (!this.byType.has(event.type)) {
			this.byType.set(event.type, []);
		}
		this.byType.get(event.type)!.push(event);

		// Index by caused_by
		if (event.caused_by) {
			if (!this.byCausedBy.has(event.caused_by)) {
				this.byCausedBy.set(event.caused_by, []);
			}
			this.byCausedBy.get(event.caused_by)!.push(event);
		}

		if (event.idempotency_key) {
			this.byIdempotencyKey.set(event.idempotency_key, event);
		}
	}

	private _persist(event: EventBase): void {
		// Write to date-based file, always flush immediately for durability
		const date = new Date(event.timestamp).toISOString().slice(0, 10);
		const path = getEventLogPathInDir(this.workspaceDir, date);
		appendFileSync(path, JSON.stringify(event) + "\n");
	}

	private _notify(event: EventBase): void {
		for (const [, sub] of this.subscribers) {
			if (this._matchesFilter(event, sub.options)) {
				sub.handler(event);
			}
		}
		this.emitter.emit("event", event);
	}

	private _matchesFilter(event: EventBase, options?: SubscribeOptions): boolean {
		if (!options) return true;

		if (options.after && event.event_id <= options.after) {
			return false;
		}

		if (options.after_sequence !== undefined && event.sequence <= options.after_sequence) {
			return false;
		}

		if (options.types && options.types.length > 0 && !options.types.includes(event.type)) {
			return false;
		}

		if (options.actor_ids && options.actor_ids.length > 0 && !options.actor_ids.includes(event.actor_id)) {
			return false;
		}

		return true;
	}

	/** Load events from a specific date file */
	private _loadDate(date: string): void {
		const path = getEventLogPathInDir(this.workspaceDir, date);
		if (!existsSync(path)) return;
		if (this.loadedDates.has(date)) return;

		try {
			const content = readFileSync(path, "utf8");
			const lines = content.trim().split("\n");

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = this._normalizeEvent(JSON.parse(line) as Partial<EventBase>);
					// Only index if not already present
					if (!this.byId.has(event.event_id)) {
						this._index(event);
					}
				} catch {
					// Skip malformed lines
				}
			}
		} catch {
			// File unreadable, skip
		} finally {
			this.loadedDates.add(date);
		}
	}

	/** Load all events from all date files */
	private _loadAll(): void {
		this._loadLegacyEventsFile();
		const dates = this._listEventDates();
		for (const date of dates) {
			this._loadDate(date);
		}
	}

	/** List all event date files in the workspace directory */
	private _listEventDates(): string[] {
		if (!existsSync(this.workspaceDir)) return [];

		try {
			return readdirSync(this.workspaceDir)
				.filter((f: string) => f.startsWith("events-") && f.endsWith(".jsonl"))
				.map((f: string) => f.slice(7, 17)) // "events-YYYY-MM-DD.jsonl" → "YYYY-MM-DD"
				.filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
				.sort();
		} catch {
			return [];
		}
	}

	private _loadLegacyEventsFile(): void {
		const legacyPath = `${this.workspaceDir}/events.jsonl`;
		if (!existsSync(legacyPath) || this.loadedDates.has("legacy")) return;

		try {
			const content = readFileSync(legacyPath, "utf8");
			const lines = content.trim().split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					this._index(this._normalizeEvent(JSON.parse(line) as Partial<EventBase>));
				} catch {
					// Skip malformed legacy lines
				}
			}
		} catch {
			// File unreadable, skip
		} finally {
			this.loadedDates.add("legacy");
		}
	}

	private _normalizeEvent(raw: Partial<EventBase>): EventBase {
		return {
			...raw,
			sequence: raw.sequence ?? this.nextSequence++,
			event_id: raw.event_id ?? uuidv7(),
			workspace_id: raw.workspace_id ?? this.workspace_id,
			runtime_id: raw.runtime_id ?? this.runtimeId,
			actor_id: raw.actor_id ?? "runtime",
			timestamp: raw.timestamp ?? Date.now(),
			type: raw.type ?? "RUNTIME_ERROR",
			payload: raw.payload ?? {},
			schema_version: raw.schema_version ?? 1,
		};
	}

	/** Force flush (no-op since we always flush immediately) */
	flush(): void {
		// no-op: each append() writes immediately
	}
}

/**
 * Create an EventStore for a given workspace.
 * Automatically derives workspace_id from cwd.
 */
export function createEventStore(cwd: string, agentDir?: string): JsonlEventStore {
	const workspaceId = deriveWorkspaceId(cwd);
	const workspaceDir = getEventLogDir(workspaceId, agentDir);
	return new JsonlEventStore(workspaceId, workspaceDir);
}
