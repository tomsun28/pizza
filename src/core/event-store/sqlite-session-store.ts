import type { DatabaseSync } from "node:sqlite";
import type { SessionDescriptor, SessionIndex, ThreadDescriptor } from "../projection/types.js";
import type { SessionStore } from "./session-store.js";

/**
 * SQLite-backed SessionStore implementation.
 *
 * Stores threads and sessions in the same SQLite database as the event log.
 */
export class SqliteSessionStore implements SessionStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly workspaceId: string,
	) {
		this._initSchema();
	}

	getSessionIndex(): SessionIndex | undefined {
		const threads = this._loadThreads();
		const sessions = this._loadSessions();
		if (threads.length === 0 && sessions.length === 0) {
			return undefined;
		}
		return { threads, sessions };
	}

	saveSessionIndex(index: SessionIndex): void {
		this.db.exec("begin");
		try {
			const upsertThread = this.db.prepare(`
				insert into threads (thread_id, workspace_id, name, created_at, status)
				values (?, ?, ?, ?, ?)
				on conflict(thread_id) do update set
					name = excluded.name,
					status = excluded.status
			`);
			for (const thread of index.threads) {
				upsertThread.run(
					thread.thread_id,
					thread.workspace_id,
					thread.name ?? null,
					thread.created_at,
					thread.status,
				);
			}

			const upsertSession = this.db.prepare(`
				insert into sessions (
					session_id, thread_id, workspace_id, start_event_id, end_event_id,
					summary_event_id, name, created_by, boundary_reason, parent_session_id, created_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				on conflict(session_id) do update set
					thread_id = excluded.thread_id,
					start_event_id = excluded.start_event_id,
					end_event_id = excluded.end_event_id,
					summary_event_id = excluded.summary_event_id,
					name = excluded.name,
					boundary_reason = excluded.boundary_reason,
					parent_session_id = excluded.parent_session_id
			`);
			for (const session of index.sessions) {
				upsertSession.run(
					session.session_id,
					session.thread_id,
					session.workspace_id,
					session.event_range.start_event_id,
					session.event_range.end_event_id,
					session.summary_event_id ?? null,
					session.name ?? null,
					session.created_by,
					session.boundary_reason ?? null,
					session.parent_session_id ?? null,
					session.created_at,
				);
			}

			const validThreadIds = index.threads.map((t) => t.thread_id);
			const validSessionIds = index.sessions.map((s) => s.session_id);
			this._deleteStale("threads", "thread_id", validThreadIds);
			this._deleteStale("sessions", "session_id", validSessionIds);

			this.db.exec("commit");
		} catch (error) {
			this.db.exec("rollback");
			throw error;
		}
	}

	private _deleteStale(table: string, idColumn: string, validIds: string[]): void {
		if (validIds.length === 0) {
			this.db.exec(`delete from ${table}`);
			return;
		}
		const placeholders = validIds.map(() => "?").join(", ");
		this.db.prepare(`delete from ${table} where ${idColumn} not in (${placeholders})`).run(...validIds);
	}

	private _initSchema(): void {
		this.db.exec(`
			create table if not exists threads (
				thread_id text primary key,
				workspace_id text not null,
				name text,
				created_at integer not null,
				status text not null
			);

			create table if not exists sessions (
				session_id text primary key,
				thread_id text not null,
				workspace_id text not null,
				start_event_id text not null,
				end_event_id text not null,
				summary_event_id text,
				name text,
				created_by text not null,
				boundary_reason text,
				parent_session_id text,
				created_at integer not null
			);

			create index if not exists idx_sessions_thread_id on sessions(thread_id);
			create index if not exists idx_sessions_workspace_id on sessions(workspace_id);
			create index if not exists idx_sessions_parent_id on sessions(parent_session_id);
		`);
	}

	private _loadThreads(): ThreadDescriptor[] {
		const rows = this.db.prepare("select * from threads").all() as ThreadRow[];
		return rows.map((row) => ({
			thread_id: row.thread_id,
			workspace_id: row.workspace_id,
			name: row.name ?? undefined,
			created_at: row.created_at,
			status: row.status as ThreadDescriptor["status"],
		}));
	}

	private _loadSessions(): SessionDescriptor[] {
		const rows = this.db.prepare("select * from sessions").all() as SessionRow[];
		return rows.map((row) => ({
			session_id: row.session_id,
			thread_id: row.thread_id,
			workspace_id: row.workspace_id,
			event_range: {
				start_event_id: row.start_event_id,
				end_event_id: row.end_event_id,
			},
			summary_event_id: row.summary_event_id ?? undefined,
			name: row.name ?? undefined,
			created_by: row.created_by as SessionDescriptor["created_by"],
			boundary_reason: row.boundary_reason as SessionDescriptor["boundary_reason"] | undefined,
			parent_session_id: row.parent_session_id ?? undefined,
			created_at: row.created_at,
		}));
	}
}

type ThreadRow = {
	thread_id: string;
	workspace_id: string;
	name: string | null;
	created_at: number;
	status: string;
};

type SessionRow = {
	session_id: string;
	thread_id: string;
	workspace_id: string;
	start_event_id: string;
	end_event_id: string;
	summary_event_id: string | null;
	name: string | null;
	created_by: string;
	boundary_reason: string | null;
	parent_session_id: string | null;
	created_at: number;
};
