/**
 * Session index as a pure projection of the log.
 *
 * The review finding: the session tree was dual-written (events + snapshot)
 * with no replay path, so "log has the session, index does not" was a real,
 * unrecoverable split-brain state. These tests pin the new contract:
 *
 *   1. Convergence: rebuilding the index from SESSION_* / THREAD_* events
 *      alone (no snapshot) yields the same tree the live path produced.
 *   2. Self-healing: a snapshot that missed the last persist (crash between
 *      append and persist) is healed by replaying events after the watermark.
 */

import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { rebuildSessionIndex } from "../src/core/projection/session-index-reducer.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";

function normalize(sessions: Iterable<SessionDescriptor>): Array<Record<string, unknown>> {
	return Array.from(sessions)
		.map((s) => ({
			session_id: s.session_id,
			thread_id: s.thread_id,
			start: s.event_range.start_event_id,
			end: s.event_range.end_event_id,
			name: s.name,
			created_by: s.created_by,
			parent: s.parent_session_id,
			context_parent: s.context_parent_session_id,
		}))
		.sort((a, b) => (a.session_id as string).localeCompare(b.session_id as string));
}

function seedTurn(store: SqliteEventStore, threadId: string, text: string): void {
	store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { text }, thread_id: threadId });
}

describe("session index projection", () => {
	it("live index converges with a pure rebuild from the log", () => {
		const store = new SqliteEventStore("ws_test", ":memory:");
		const manager = new SessionManager(store, store);

		// Drive a representative session tree through the live path.
		const first = manager.getActiveSession().getDescriptor();
		seedTurn(store, first.thread_id, "hello");
		manager.createSession("user_explicit", "second"); // closes first
		seedTurn(store, first.thread_id, "more work");
		const forked = manager.forkAt(store.head!); // closes second
		seedTurn(store, forked.thread_id, "forked work");
		manager.renameSession(forked.session_id, "renamed fork");
		const bgThread = manager.createThread("scheduled", "schedule");
		seedTurn(store, bgThread.thread_id, "background turn");
		// Promote the background thread via explicit navigation.
		const bgSession = manager
			.listSessions()
			.find((s) => s.thread_id === bgThread.thread_id)!;
		manager.switchToExistingSession(bgSession.session_id, "user clicked");

		// Rebuild purely from the log (no snapshot).
		const rebuilt = rebuildSessionIndex(store);

		expect(normalize(rebuilt.sessions.values())).toEqual(normalize(manager.listSessions()));
		expect(
			Array.from(rebuilt.threads.values())
				.map((t) => ({ thread_id: t.thread_id, status: t.status }))
				.sort((a, b) => a.thread_id.localeCompare(b.thread_id)),
		).toEqual(
			[
				...new Map(
					manager.listSessions().map((s) => [s.thread_id, s.thread_id]),
				).keys(),
			]
				.map((id) => ({
					thread_id: id,
					status: id === bgThread.thread_id ? "active" : "active", // promoted
				}))
				.sort((a, b) => a.thread_id.localeCompare(b.thread_id)),
		);
		store.close();
	});

	it("a fresh manager rebuilds the index from the log when the snapshot is missing", () => {
		const store = new SqliteEventStore("ws_test", ":memory:");
		// Build a tree with a manager that has NO session store (never persists).
		const manager = new SessionManager(store);
		const first = manager.getActiveSession().getDescriptor();
		seedTurn(store, first.thread_id, "hello");
		manager.createSession("user_explicit", "second");
		const expected = normalize(manager.listSessions());

		// A new manager over the same store, still no snapshot: must rebuild.
		const recovered = new SessionManager(store);
		expect(normalize(recovered.listSessions())).toEqual(expected);
		// Active session must resolve to the open session in the active thread.
		expect(recovered.getActiveSessionId()).toBe(manager.getActiveSessionId());
		store.close();
	});

	it("self-heals a snapshot that missed the latest boundary mutations", () => {
		const store = new SqliteEventStore("ws_test", ":memory:");
		const manager = new SessionManager(store, store);
		const first = manager.getActiveSession().getDescriptor();
		seedTurn(store, first.thread_id, "hello");
		// Persisted state now: first session open, snapshot watermark ~= head.

		// Simulate "appended to log but snapshot persist was lost": write the
		// boundary events directly (what createSession would append) without
		// touching the snapshot tables.
		const created = store.append({
			actor_id: "runtime",
			type: "SESSION_CREATED",
			payload: {
				session_id: "sess_crashed_0001",
				name: "crashed",
				created_by: "user_explicit",
				start_event_id: store.head ?? "ORIGIN",
				created_at: Date.now(),
				closes_session_id: first.session_id,
			},
			thread_id: first.thread_id,
		});

		// A fresh manager loads snapshot + replays after watermark.
		const healed = new SessionManager(store, store);
		const healedFirst = healed.getSession(first.session_id)!;
		expect(healedFirst.event_range.end_event_id).toBe(created.event_id);
		const crashed = healed.getSession("sess_crashed_0001")!;
		expect(crashed).toBeDefined();
		expect(crashed.event_range.end_event_id).toBe("HEAD");
		expect(healed.getActiveSessionId()).toBe("sess_crashed_0001");
		store.close();
	});

	it("renames are replayable from the log", () => {
		const store = new SqliteEventStore("ws_test", ":memory:");
		const manager = new SessionManager(store, store);
		const first = manager.getActiveSession().getDescriptor();
		manager.renameSession(first.session_id, "my name");

		const rebuilt = rebuildSessionIndex(store);
		expect(rebuilt.sessions.get(first.session_id)?.name).toBe("my name");
		store.close();
	});
});