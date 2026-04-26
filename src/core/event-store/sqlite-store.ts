import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { v7 as uuidv7 } from "uuid";
import type { EventBase, EventType } from "./types.js";
import type { EventAppendInput, EventQuery, EventStore, SubscribeOptions } from "./store.js";
import { deriveWorkspaceId, getEventDatabasePath } from "./workspace.js";

const require = createRequire(import.meta.url);
type DatabaseSyncConstructor = typeof import("node:sqlite").DatabaseSync;
let DatabaseSyncCtor: DatabaseSyncConstructor | undefined;

type EventRow = {
	sequence: number;
	event_id: string;
	workspace_id: string;
	runtime_id: string;
	actor_id: string;
	timestamp: number;
	type: EventType;
	payload_json: string;
	caused_by: string | null;
	correlation_id: string | null;
	session_hint: string | null;
	schema_version: number;
	idempotency_key: string | null;
};

export class SqliteEventStore implements EventStore {
	private db: DatabaseSync;
	private subscribers: Map<number, { handler: (event: EventBase) => void; options?: SubscribeOptions }> = new Map();
	private nextSubId = 0;

	readonly workspace_id: string;

	constructor(
		workspaceId: string,
		dbPath: string,
		private runtimeId = "local_runtime",
	) {
		this.workspace_id = workspaceId;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new (loadDatabaseSync())(dbPath);
		this._initSchema();
	}

	append(partial: EventAppendInput): EventBase {
		if (partial.idempotency_key) {
			const existing = this._getByIdempotencyKey(partial.idempotency_key);
			if (existing) return existing;
		}

		const event = this._normalizeEvent(partial);
		this._insert(event);
		const inserted = this.get(event.event_id) ?? event;
		this._notify(inserted);
		return inserted;
	}

	appendBatch(partials: EventAppendInput[]): EventBase[] {
		const events: EventBase[] = [];
		const newEvents: EventBase[] = [];
		let nextSequence = this.head_sequence + 1;
		for (const partial of partials) {
			if (partial.idempotency_key) {
				const existing = this._getByIdempotencyKey(partial.idempotency_key);
				if (existing) {
					events.push(existing);
					continue;
				}
			}
			const sequence = partial.sequence ?? nextSequence;
			nextSequence = Math.max(nextSequence, sequence + 1);
			const event = this._normalizeEvent({ ...partial, sequence });
			events.push(event);
			newEvents.push(event);
		}

		this.db.exec("begin");
		try {
			for (const event of newEvents) {
				this._insert(event);
			}
			this.db.exec("commit");
		} catch (error) {
			this.db.exec("rollback");
			throw error;
		}

		for (const event of newEvents) {
			this._notify(event);
		}

		return events.map((event) => this.get(event.event_id) ?? event);
	}

	query(filter: EventQuery): EventBase[] {
		const clauses = ["workspace_id = ?"];
		const params: SQLInputValue[] = [this.workspace_id];

		if (filter.after_sequence !== undefined) {
			clauses.push("sequence > ?");
			params.push(filter.after_sequence);
		}
		if (filter.before_sequence !== undefined) {
			clauses.push("sequence < ?");
			params.push(filter.before_sequence);
		}
		if (filter.after) {
			const after = this.get(filter.after);
			if (after) {
				clauses.push("sequence > ?");
				params.push(after.sequence);
			}
		}
		if (filter.before) {
			const before = this.get(filter.before);
			if (before) {
				clauses.push("sequence < ?");
				params.push(before.sequence);
			}
		}
		if (filter.types?.length) {
			clauses.push(`type in (${filter.types.map(() => "?").join(", ")})`);
			params.push(...filter.types);
		}
		if (filter.actor_ids?.length) {
			clauses.push(`actor_id in (${filter.actor_ids.map(() => "?").join(", ")})`);
			params.push(...filter.actor_ids);
		}
		if (filter.session_hint) {
			clauses.push("session_hint = ?");
			params.push(filter.session_hint);
		}
		if (filter.caused_by) {
			clauses.push(`event_id in (
				with recursive descendants(event_id) as (
					select event_id from events where workspace_id = ? and caused_by = ?
					union all
					select e.event_id from events e join descendants d on e.caused_by = d.event_id
					where e.workspace_id = ?
				)
				select event_id from descendants
			)`);
			params.push(this.workspace_id, filter.caused_by, this.workspace_id);
		}

		let sql = `select * from events where ${clauses.join(" and ")} order by sequence ${filter.reverse ? "desc" : "asc"}`;
		if (filter.limit && filter.limit > 0) {
			sql += " limit ?";
			params.push(filter.limit);
		}

		return this.db.prepare(sql).all(...params).map((row) => rowToEvent(row as EventRow));
	}

	get(event_id: string): EventBase | undefined {
		const row = this.db
			.prepare("select * from events where workspace_id = ? and event_id = ?")
			.get(this.workspace_id, event_id) as EventRow | undefined;
		return row ? rowToEvent(row) : undefined;
	}

	latest(count: number): EventBase[] {
		return this.query({ limit: count, reverse: true }).reverse();
	}

	getCausalChain(event_id: string): EventBase[] {
		const chain: EventBase[] = [];
		let currentId: string | undefined = event_id;
		while (currentId) {
			const event = this.get(currentId);
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
		const row = this.db
			.prepare("select count(*) as count from events where workspace_id = ?")
			.get(this.workspace_id) as { count: number };
		return row.count;
	}

	get head(): string | undefined {
		const row = this.db
			.prepare("select event_id from events where workspace_id = ? order by sequence desc limit 1")
			.get(this.workspace_id) as { event_id: string } | undefined;
		return row?.event_id;
	}

	get head_sequence(): number {
		const row = this.db
			.prepare("select coalesce(max(sequence), 0) as sequence from events where workspace_id = ?")
			.get(this.workspace_id) as { sequence: number };
		return row.sequence;
	}

	close(): void {
		this.db.close();
	}

	private _initSchema(): void {
		this.db.exec(`
			create table if not exists events (
				sequence integer not null,
				event_id text not null unique,
				workspace_id text not null,
				runtime_id text not null,
				actor_id text not null,
				timestamp integer not null,
				type text not null,
				payload_json text not null,
				caused_by text,
				correlation_id text,
				session_hint text,
				schema_version integer not null default 1,
				idempotency_key text
			);
			create index if not exists idx_events_workspace_sequence on events(workspace_id, sequence);
			create unique index if not exists uniq_events_workspace_sequence on events(workspace_id, sequence);
			create index if not exists idx_events_workspace_type_sequence on events(workspace_id, type, sequence);
			create index if not exists idx_events_caused_by on events(caused_by);
			create index if not exists idx_events_correlation on events(correlation_id);
			create unique index if not exists idx_events_workspace_idempotency
				on events(workspace_id, idempotency_key)
				where idempotency_key is not null;
		`);
	}

	private _normalizeEvent(partial: EventAppendInput): EventBase {
		return {
			...partial,
			sequence: partial.sequence ?? this.head_sequence + 1,
			event_id: partial.event_id ?? uuidv7(),
			workspace_id: this.workspace_id,
			runtime_id: partial.runtime_id ?? this.runtimeId,
			timestamp: partial.timestamp ?? Date.now(),
			schema_version: partial.schema_version ?? 1,
		};
	}

	private _insert(event: EventBase): void {
		this.db.prepare(`
			insert into events (
				sequence, event_id, workspace_id, runtime_id, actor_id, timestamp, type,
				payload_json, caused_by, correlation_id, session_hint, schema_version, idempotency_key
			) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			event.sequence,
			event.event_id,
			event.workspace_id,
			event.runtime_id,
			event.actor_id,
			event.timestamp,
			event.type,
			JSON.stringify(event.payload),
			event.caused_by ?? null,
			event.correlation_id ?? null,
			event.session_hint ?? null,
			event.schema_version,
			event.idempotency_key ?? null,
		);
	}

	private _getByIdempotencyKey(idempotencyKey: string): EventBase | undefined {
		const row = this.db
			.prepare("select * from events where workspace_id = ? and idempotency_key = ?")
			.get(this.workspace_id, idempotencyKey) as EventRow | undefined;
		return row ? rowToEvent(row) : undefined;
	}

	private _notify(event: EventBase): void {
		for (const [, sub] of this.subscribers) {
			if (matchesSubscription(event, sub.options)) {
				sub.handler(event);
			}
		}
	}
}

function rowToEvent(row: EventRow): EventBase {
	return {
		sequence: row.sequence,
		event_id: row.event_id,
		workspace_id: row.workspace_id,
		runtime_id: row.runtime_id,
		actor_id: row.actor_id,
		timestamp: row.timestamp,
		type: row.type,
		payload: JSON.parse(row.payload_json) as unknown,
		caused_by: row.caused_by ?? undefined,
		correlation_id: row.correlation_id ?? undefined,
		session_hint: row.session_hint ?? undefined,
		schema_version: row.schema_version,
		idempotency_key: row.idempotency_key ?? undefined,
	};
}

function matchesSubscription(event: EventBase, options?: SubscribeOptions): boolean {
	if (!options) return true;
	if (options.after && event.event_id <= options.after) return false;
	if (options.after_sequence !== undefined && event.sequence <= options.after_sequence) return false;
	if (options.types?.length && !options.types.includes(event.type)) return false;
	if (options.actor_ids?.length && !options.actor_ids.includes(event.actor_id)) return false;
	return true;
}

function loadDatabaseSync(): DatabaseSyncConstructor {
	if (!DatabaseSyncCtor) {
		DatabaseSyncCtor = (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
	}
	return DatabaseSyncCtor;
}

export function createEventStore(cwd: string, agentDir?: string, runtimeId?: string): SqliteEventStore {
	const workspaceId = deriveWorkspaceId(cwd);
	return new SqliteEventStore(workspaceId, getEventDatabasePath(workspaceId, agentDir), runtimeId);
}
