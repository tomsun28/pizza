import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { EventStore } from "./store.js";
import { JsonlEventStore } from "./jsonl-store.js";
import { SqliteEventStore } from "./sqlite-store.js";

export interface EventStoreMigrationResult {
	events_read: number;
	events_written: number;
}

export function migrateJsonlToSqlite(options: {
	workspace_id: string;
	jsonlDir: string;
	sqlitePath: string;
	runtime_id?: string;
}): EventStoreMigrationResult {
	const source = new JsonlEventStore(options.workspace_id, options.jsonlDir, options.runtime_id);
	const target = new SqliteEventStore(options.workspace_id, options.sqlitePath, options.runtime_id);
	try {
		return copyEvents(source, target);
	} finally {
		target.close();
	}
}

export function exportSqliteToJsonl(options: {
	workspace_id: string;
	sqlitePath: string;
	jsonlPath: string;
	runtime_id?: string;
	overwrite?: boolean;
}): EventStoreMigrationResult {
	if (options.overwrite && existsSync(options.jsonlPath)) {
		rmSync(options.jsonlPath);
	}
	mkdirSync(dirname(options.jsonlPath), { recursive: true });

	const source = new SqliteEventStore(options.workspace_id, options.sqlitePath, options.runtime_id);
	try {
		const events = source.query({});
		for (const event of events) {
			appendFileSync(options.jsonlPath, `${JSON.stringify(event)}\n`);
		}

		return { events_read: events.length, events_written: events.length };
	} finally {
		source.close();
	}
}

export function copyEvents(source: EventStore, target: EventStore): EventStoreMigrationResult {
	const events = source.query({});
	const written = target.appendBatch(events);
	return { events_read: events.length, events_written: written.length };
}
