import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { ThreadScopedStore } from "../src/core/event-store/thread-scoped-store.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { buildHistoryTreeNodes } from "../src/core/projection/history-tree.js";

/**
 * Caller-supplied thread ids — the SDK multi-tenancy contract.
 *
 * An embedder maps its own user identity onto `threadId` and expects:
 *   1. the id is adopted verbatim (no side mapping table needed),
 *   2. reconnecting with the same id resumes that user's conversation,
 *   3. one tenant never sees another's context or history listing.
 */
describe("SDK thread tenancy (caller-supplied threadId)", () => {
	function setup() {
		const store = new SqliteEventStore("ws_tenancy", ":memory:");
		return { store, sessionManager: new SessionManager(store, store) };
	}

	function say(store: SqliteEventStore, threadId: string, text: string) {
		new ThreadScopedStore(store, threadId).append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: text },
		});
	}

	it("adopts the caller's id verbatim", () => {
		const { sessionManager } = setup();
		const thread = sessionManager.useThread("user-1024");
		expect(thread.thread_id).toBe("user-1024");
		// A session must exist so the tenant can be prompted immediately.
		expect(sessionManager.getActiveSessionId()).toBeDefined();
		expect(sessionManager.getActiveThreadId()).toBe("user-1024");
	});

	it("resumes the same session when a user reconnects", () => {
		const { sessionManager } = setup();
		sessionManager.useThread("user-a");
		const first = sessionManager.getActiveSessionId();

		sessionManager.useThread("user-b");
		expect(sessionManager.getActiveSessionId()).not.toBe(first);

		// Reconnect: same id must land back in the original session, not fork.
		sessionManager.useThread("user-a");
		expect(sessionManager.getActiveSessionId()).toBe(first);
	});

	it("does not close another tenant's live session on connect", () => {
		const { sessionManager } = setup();
		sessionManager.useThread("user-a");
		const aSession = sessionManager.getActiveSessionId()!;

		sessionManager.useThread("user-b");

		const a = sessionManager.listSessions().find((s) => s.session_id === aSession)!;
		expect(a.event_range.end_event_id).toBe("HEAD");
	});

	it("isolates context between tenants", () => {
		const { store, sessionManager } = setup();
		sessionManager.useThread("user-a");
		say(store, "user-a", "my salary is 100k");
		sessionManager.useThread("user-b");
		say(store, "user-b", "hello from b");

		const texts = JSON.stringify(sessionManager.getActiveSession().buildContext().messages);
		expect(texts).toContain("hello from b");
		expect(texts).not.toContain("100k");
	});

	it("scopes the history tree to one tenant", () => {
		const { store, sessionManager } = setup();
		sessionManager.useThread("user-a");
		say(store, "user-a", "secret plan for a");
		sessionManager.useThread("user-b");
		say(store, "user-b", "b topic");

		const all = sessionManager.listSessions();
		const scoped = buildHistoryTreeNodes(all, sessionManager.getActiveSessionId(), store, "user-b");
		expect(scoped).toHaveLength(1);
		expect(scoped.every((n) => n.thread_id === "user-b")).toBe(true);
		expect(JSON.stringify(scoped)).not.toContain("secret plan");

		// Unscoped (single-user local use) still shows everything.
		expect(buildHistoryTreeNodes(all, sessionManager.getActiveSessionId(), store)).toHaveLength(2);
	});

	it("survives a restart: index reload keeps threads separate", () => {
		const { store, sessionManager } = setup();
		sessionManager.useThread("user-a");
		say(store, "user-a", "from a");
		sessionManager.useThread("user-b");
		say(store, "user-b", "from b");

		// New manager over the same store = process restart.
		const reloaded = new SessionManager(store, store);
		reloaded.useThread("user-a");
		const texts = JSON.stringify(reloaded.getActiveSession().buildContext().messages);
		expect(texts).toContain("from a");
		expect(texts).not.toContain("from b");
	});
});