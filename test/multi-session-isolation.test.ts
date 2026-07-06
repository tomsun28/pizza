import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { ThreadScopedStore } from "../src/core/event-store/thread-scoped-store.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";

/**
 * Prove that two threads sharing one EventStore are isolated:
 * each thread's buildContext() only sees its own events (tagged by thread_id).
 *
 * Model: Thread = isolation unit (thread_id on events). Session = branch within
 * a thread (event_range). Two threads each get one session here.
 */
describe("multi-thread isolation", () => {
	function setup() {
		const store = new SqliteEventStore("ws_test", ":memory:");
		const sessionManager = new SessionManager(store, ":memory:");
		return { store, sessionManager };
	}

	function appendUserMessage(scopedStore: ThreadScopedStore, text: string) {
		scopedStore.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: text },
		});
	}

	function appendAssistantMessage(scopedStore: ThreadScopedStore, text: string) {
		scopedStore.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text }],
				model: { provider: "test", model_id: "test-model" },
				usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
	}

	function textOf(messages: { content: unknown }[]): string[] {
		return messages.map((m) => {
			const c = m.content;
			if (typeof c === "string") return c;
			return Array.isArray(c)
				? c.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("")
				: "";
		});
	}

	it("thread A does not see thread B's events", () => {
		const { store, sessionManager } = setup();

		// Two threads, each with its own first session
		const threadA = sessionManager.createThread();
		const descA = sessionManager.getSession(sessionManager.getActiveSessionId()!)!;
		const threadB = sessionManager.createThread();
		const descB = sessionManager.getSession(sessionManager.getActiveSessionId()!)!;

		// Tag events by thread via ThreadScopedStore
		const scopedA = new ThreadScopedStore(store, threadA.thread_id);
		const scopedB = new ThreadScopedStore(store, threadB.thread_id);

		appendUserMessage(scopedA, "hello from A");
		appendAssistantMessage(scopedA, "response A");

		appendUserMessage(scopedB, "hello from B");
		appendAssistantMessage(scopedB, "response B");

		// buildContext for A sees only A's events (thread_id filter)
		const textsA = textOf(new SessionProjection(store, descA).buildContext().messages);
		expect(textsA).toContain("hello from A");
		expect(textsA).toContain("response A");
		expect(textsA).not.toContain("hello from B");
		expect(textsA).not.toContain("response B");

		// buildContext for B sees only B's events
		const textsB = textOf(new SessionProjection(store, descB).buildContext().messages);
		expect(textsB).toContain("hello from B");
		expect(textsB).toContain("response B");
		expect(textsB).not.toContain("hello from A");
		expect(textsB).not.toContain("response A");
	});

	it("threads share the same SQLite store but have independent event counts", () => {
		const { store, sessionManager } = setup();

		const threadA = sessionManager.createThread();
		const descA = sessionManager.getSession(sessionManager.getActiveSessionId()!)!;
		const threadB = sessionManager.createThread();
		const descB = sessionManager.getSession(sessionManager.getActiveSessionId()!)!;

		const scopedA = new ThreadScopedStore(store, threadA.thread_id);
		const scopedB = new ThreadScopedStore(store, threadB.thread_id);

		// A has 4 content events, B has 2
		appendUserMessage(scopedA, "a1");
		appendAssistantMessage(scopedA, "a1-resp");
		appendUserMessage(scopedA, "a2");
		appendAssistantMessage(scopedA, "a2-resp");

		appendUserMessage(scopedB, "b1");
		appendAssistantMessage(scopedB, "b1-resp");

		// Each projection sees only its own thread's context-relevant events
		expect(new SessionProjection(store, descA).buildContext().messages.length).toBe(4);
		expect(new SessionProjection(store, descB).buildContext().messages.length).toBe(2);
	});
});
