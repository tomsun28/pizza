/**
 * Zero-copy cross-workspace fork tests (#5 of the 6-item refactor).
 *
 * Previously prepareForkedSession cloned the ENTIRE source context event list
 * into the target workspace's log (losing event_id/caused_by — broken causal
 * chain, no provenance marker). Now the forked descriptor carries
 * `source_ref` and buildContext lazily opens the source store read-only.
 *
 * Covered:
 *   - fork writes NO cloned events into the target log
 *   - buildContext messages match the source projection's context
 *   - events appended to the source AFTER the fork do not leak in
 *   - source workspace deleted → graceful degradation (no crash, own events only)
 *   - source_ref survives index replay (SESSION_CREATED / SESSION_FORKED)
 *   - legacy same-workspace forks unchanged
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { prepareForkedSession } from "../src/core/facade/fork.js";
import { rebuildSessionIndex } from "../src/core/projection/session-index-reducer.js";

let agentDir: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
	originalAgentDir = process.env.PIZZA_CODING_AGENT_DIR;
	agentDir = join(tmpdir(), `pizza-fork-zc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(agentDir, { recursive: true });
	// _resolveSourceContext resolves source workspaces against the default
	// agent dir — point it at our temp dir.
	process.env.PIZZA_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PIZZA_CODING_AGENT_DIR;
	else process.env.PIZZA_CODING_AGENT_DIR = originalAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

function makeWorkspace(workspaceId: string): { store: SqliteEventStore; manager: SessionManager } {
	const dir = join(agentDir, "workspaces", workspaceId);
	mkdirSync(dir, { recursive: true });
	const store = new SqliteEventStore(workspaceId, join(dir, "events.sqlite"));
	const manager = new SessionManager(store, store);
	return { store, manager };
}

/** Source workspace with a short conversation; returns ids for forking. */
function seedSource(): { store: SqliteEventStore; manager: SessionManager; sessionId: string } {
	const { store, manager } = makeWorkspace("ws_source");
	const session = manager.createSession("user_explicit", "source-session");
	store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "hello from source" }, thread_id: session.thread_id });
	store.append({
		actor_id: "agent",
		type: "AGENT_MESSAGE_END",
		payload: {
			content: [{ type: "text", text: "source reply" }],
			stop_reason: "stop",
			usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
			model: { provider: "test", model_id: "test-model" },
		},
		thread_id: session.thread_id,
	});
	return { store, manager, sessionId: session.session_id };
}

describe("zero-copy cross-workspace fork", () => {
	it("does not clone source events into the target log", () => {
		const src = seedSource();
		const { store, manager } = makeWorkspace("ws_target");

		const before = store.query({}).length;
		prepareForkedSession({ store, sessionManager: manager, agentDir, source: { workspaceId: "ws_source", sessionId: src.sessionId } });
		const appended = store.query({}).slice(before);

		// Only session bookkeeping (SESSION_CREATED + SESSION_FORKED) — no
		// USER_MESSAGE / AGENT_MESSAGE_END clones.
		const types = appended.map((e) => e.type);
		expect(types).not.toContain("USER_MESSAGE");
		expect(types).not.toContain("AGENT_MESSAGE_END");
		expect(types).toContain("SESSION_FORKED");

		src.manager.dispose(); src.store.close(); manager.dispose(); store.close();
	});

	it("buildContext prepends the source conversation via source_ref", () => {
		const src = seedSource();
		const sourceContext = src.manager.getSessionProjection(src.sessionId)!.buildContext();

		const { store, manager } = makeWorkspace("ws_target");
		prepareForkedSession({ store, sessionManager: manager, agentDir, source: { workspaceId: "ws_source", sessionId: src.sessionId } });

		const forked = manager.getActiveSession();
		expect(forked.getDescriptor().source_ref).toEqual(
			expect.objectContaining({ workspace_id: "ws_source", session_id: src.sessionId }),
		);
		const ctx = forked.buildContext();
		// Same messages as the source context (zero-copy read-through).
		expect(ctx.messages).toEqual(sourceContext.messages);
		expect(ctx.messages.length).toBeGreaterThan(0);

		src.manager.dispose(); src.store.close(); manager.dispose(); store.close();
	});

	it("events appended to the source AFTER the fork do not leak in", () => {
		const src = seedSource();
		const { store, manager } = makeWorkspace("ws_target");
		prepareForkedSession({ store, sessionManager: manager, agentDir, source: { workspaceId: "ws_source", sessionId: src.sessionId } });

		const beforeCount = manager.getActiveSession().buildContext().messages.length;

		// Continue the source conversation after the fork.
		const srcThread = src.manager.getActiveSession().getDescriptor().thread_id;
		src.store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "post-fork message" }, thread_id: srcThread });

		// Fresh manager (fresh source cache) — still must not see the new event.
		const manager2 = new SessionManager(store, store);
		const after = manager2.getActiveSession().buildContext();
		expect(after.messages.length).toBe(beforeCount);
		expect(JSON.stringify(after.messages)).not.toContain("post-fork message");

		src.manager.dispose(); src.store.close(); manager.dispose(); manager2.dispose(); store.close();
	});

	it("degrades gracefully when the source workspace is deleted", () => {
		const src = seedSource();
		const { store, manager } = makeWorkspace("ws_target");
		prepareForkedSession({ store, sessionManager: manager, agentDir, source: { workspaceId: "ws_source", sessionId: src.sessionId } });
		src.manager.dispose();
		src.store.close();

		// Delete the source workspace entirely.
		rmSync(join(agentDir, "workspaces", "ws_source"), { recursive: true, force: true });

		// New manager, no cache — buildContext must not throw and must still
		// serve the target session's own events.
		const manager2 = new SessionManager(store, store);
		const forkedProjection = manager2.getActiveSession();
		const threadId = forkedProjection.getDescriptor().thread_id;
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "own message" }, thread_id: threadId });
		const ctx = manager2.getActiveSession().buildContext();
		expect(JSON.stringify(ctx.messages)).toContain("own message");
		expect(JSON.stringify(ctx.messages)).not.toContain("hello from source");

		manager.dispose(); manager2.dispose(); store.close();
	});

	it("source_ref survives a full index replay from the log", () => {
		const src = seedSource();
		const { store, manager } = makeWorkspace("ws_target");
		prepareForkedSession({ store, sessionManager: manager, agentDir, source: { workspaceId: "ws_source", sessionId: src.sessionId } });
		const forkedId = manager.getActiveSessionId()!;

		const rebuilt = rebuildSessionIndex(store);
		const replayed = rebuilt.sessions.get(forkedId);
		expect(replayed?.source_ref).toEqual(
			expect.objectContaining({ workspace_id: "ws_source", session_id: src.sessionId }),
		);

		src.manager.dispose(); src.store.close(); manager.dispose(); store.close();
	});

	it("same-workspace forks stay on the legacy zero-copy path (no source_ref)", () => {
		const src = seedSource();
		prepareForkedSession({
			store: src.store,
			sessionManager: src.manager,
			agentDir,
			source: { workspaceId: "ws_source", sessionId: src.sessionId },
		});
		const forked = src.manager.getActiveSession().getDescriptor();
		expect(forked.source_ref).toBeUndefined();
		expect(forked.parent_session_id).toBe(src.sessionId);

		src.manager.dispose(); src.store.close();
	});

	it("throws a clear error when forking from a nonexistent workspace", () => {
		const { store, manager } = makeWorkspace("ws_target");
		expect(() =>
			prepareForkedSession({ store, sessionManager: manager, agentDir, source: { workspaceId: "ws_missing", sessionId: "sess_x" } }),
		).toThrow(/not found/i);
		manager.dispose(); store.close();
	});
});