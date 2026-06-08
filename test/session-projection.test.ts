/**
 * Session Projection tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";

describe("SessionProjection", () => {
	const testDir = join(tmpdir(), ".test-pizza-projection", String(Date.now()));
	let store: SqliteEventStore;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		store = new SqliteEventStore("test-ws", join(testDir, "projection-events.sqlite"));
	});

	afterEach(() => {
		store.close();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	function createDescriptor(overrides?: Partial<SessionDescriptor>): SessionDescriptor {
		return {
			session_id: "sess_test",
			workspace_id: "test-ws",
			event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
			created_by: "user_explicit",
			created_at: Date.now(),
			...overrides,
		};
	}

	it("should build empty context from empty store", () => {
		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(0);
		expect(context.events).toHaveLength(0);
		expect(context.descriptor.session_id).toBe("sess_test");
	});

	it("should build context with user and agent messages", () => {
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "Hello agent" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "Hello user" }],
				model: { provider: "anthropic", model_id: "claude-sonnet" },
				usage: { input: 10, output: 20, cache_read: 0, cache_write: 0, total: 30, cost: 0.001 },
				stop_reason: "stop",
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("user");
		expect(context.messages[1].role).toBe("assistant");
	});

	it("should build context with tool results", () => {
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "Read file.ts" },
		});
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "call_1",
				tool_name: "read",
				result: [{ type: "text", text: "file contents here" }],
				is_error: false,
				duration_ms: 50,
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(2);
		expect(context.messages[1].role).toBe("toolResult");
	});

	it("should include compaction events once when building context", () => {
		const summary = store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Compacted context",
				first_kept_event_id: "evt-keep",
				tokens_before: 12000,
				tokens_after: 900,
			},
		});

		const projection = new SessionProjection(
			store,
			createDescriptor({ summary_event_id: summary.event_id }),
		);
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(1);
		expect(context.messages[0].role).toBe("compactionSummary");
		expect((context.messages[0] as any).summary).toBe("Compacted context");
	});

	it("should treat COMPACTION_END first_kept_event_id as a context boundary", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "old request" } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "old response" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "kept request" } });
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Old request and response were summarized",
				first_kept_event_id: kept.event_id,
				tokens_before: 9000,
				tokens_after: 1000,
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("compactionSummary");
		expect((context.messages[1] as any).content).toBe("kept request");
		expect(context.messages.some((message) => JSON.stringify(message).includes("old request"))).toBe(false);
	});

	it("should skip non-context events like AGENT_THINKING_START", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Hi" } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_START", payload: {} });
		store.append({ actor_id: "coder_agent", type: "AGENT_TURN_START", payload: { message_count: 1 } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "response" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
		store.append({ actor_id: "coder_agent", type: "AGENT_TURN_END", payload: { tool_calls_count: 0 } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_END", payload: {} });

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		// Only USER_MESSAGE and AGENT_MESSAGE_END should produce messages
		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("user");
		expect(context.messages[1].role).toBe("assistant");
	});

	it("should apply token budget truncation", () => {
		// Add many messages
		for (let i = 0; i < 100; i++) {
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: `Message ${i}` } });
		}

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext({ max_tokens: 500 }); // 500 / 100 = 5 messages max

		expect(context.messages.length).toBeLessThan(100);
	});

	it("should return timeline entries", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Hello" } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_START", payload: {} });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "Hi" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const timeline = projection.getTimeline();

		expect(timeline).toHaveLength(3);
		expect(timeline[0].kind).toBe("user_message");
		expect(timeline[0].summary).toContain("User:");
		expect(timeline[2].kind).toBe("agent_message");
		expect(timeline[2].summary).toContain("Agent");
	});

	it("should fork session from a specific event", () => {
		const e1 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "A" } });
		const e2 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "B" } });
		const e3 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "C" } });

		const projection = new SessionProjection(store, createDescriptor());
		const forked = projection.fork(e2.event_id);

		expect(forked.event_range.start_event_id).toBe(e2.event_id);
		expect(forked.event_range.end_event_id).toBe("HEAD");
		expect(forked.created_by).toBe("fork");
		expect(forked.parent_session_id).toBe("sess_test");
	});
});

describe("SessionManager", () => {
	const testDir = join(tmpdir(), ".test-pizza-session-mgr", String(Date.now()));
	let store: SqliteEventStore;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		store = new SqliteEventStore("test-ws", join(testDir, "session-events.sqlite"));
	});

	afterEach(() => {
		store.close();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should create a session on first access", () => {
		const mgr = new SessionManager(store, join(testDir, "sessions.json"));
		const session = mgr.getActiveSession();

		expect(session).toBeDefined();
		expect(mgr.getActiveSessionId()).toBeDefined();
	});

	it("should create named sessions", () => {
		const mgr = new SessionManager(store, join(testDir, "sessions.json"));
		const desc = mgr.createSession("user_explicit", "My Session");

		expect(desc.name).toBe("My Session");
		expect(desc.created_by).toBe("user_explicit");
		expect(mgr.getActiveSessionId()).toBe(desc.session_id);
	});

	it("should list sessions", () => {
		const mgr = new SessionManager(store, join(testDir, "sessions.json"));
		mgr.createSession("user_explicit", "Session A");
		mgr.createSession("user_explicit", "Session B");

		const list = mgr.listSessions();
		expect(list.length).toBe(2);
	});

	it("should switch sessions", () => {
		const mgr = new SessionManager(store, join(testDir, "sessions.json"));
		const s1 = mgr.createSession("user_explicit", "Session 1");
		const s2 = mgr.createSession("user_explicit", "Session 2");

		expect(mgr.getActiveSessionId()).toBe(s2.session_id);

		mgr.switchTo(s1.session_id);
		expect(mgr.getActiveSessionId()).toBe(s1.session_id);
	});

	it("should throw when switching to non-existent session", () => {
		const mgr = new SessionManager(store, join(testDir, "sessions.json"));
		mgr.createSession("user_explicit");

		expect(() => mgr.switchTo("non-existent")).toThrow("Session not found");
	});

	it("should rename sessions", () => {
		const mgr = new SessionManager(store, join(testDir, "sessions.json"));
		const desc = mgr.createSession("user_explicit", "Old Name");

		mgr.renameSession(desc.session_id, "New Name");
		const updated = mgr.getSession(desc.session_id);
		expect(updated?.name).toBe("New Name");
	});

	it("should fork sessions", () => {
		const mgr = new SessionManager(store, join(testDir, "sessions.json"));
		mgr.createSession("user_explicit", "Original");
		const event = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fork point" } });

		const forked = mgr.forkAt(event.event_id);
		expect(forked.created_by).toBe("fork");
		expect(forked.parent_session_id).toBeDefined();
		expect(mgr.getActiveSessionId()).toBe(forked.session_id);
	});

	it("should persist sessions to disk", () => {
		const sessionPath = join(testDir, "sessions.json");
		{
			const mgr = new SessionManager(store, sessionPath);
			mgr.createSession("user_explicit", "Persisted");
			mgr.dispose();
		}

		{
			const mgr = new SessionManager(store, sessionPath);
			const list = mgr.listSessions();
			expect(list.length).toBe(1);
			expect(list[0].name).toBe("Persisted");
			mgr.dispose();
		}
	});
});
