/**
 * Headless tests for the history_tree tool, SessionManager.jumpToSession,
 * and the builtin command parsing.
 *
 * Verifies:
 * 1. buildHistoryTreeNodes organizes sessions into a depth-annotated tree
 * 2. SessionManager.jumpToSession switches/reopens sessions and emits SESSION_JUMPED
 * 3. EventStoreExtensionSessionManager.historyTree exposes list/view/jump/fork
 * 4. The history_tree tool definition executes each action
 * 5. parseBuiltinToolInput parses history_tree commands
 */

import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionManager as ProjectionSessionManager } from "../src/core/projection/session-manager.js";
import { buildHistoryTreeNodes, renderHistoryTreeText, buildSessionBreadcrumb } from "../src/core/projection/history-tree.js";
import { EventStoreExtensionSessionManager } from "../src/core/extensions/session-context.js";
import { createHistoryTreeToolDefinition } from "../src/core/tools/history-tree.js";
import { parseBuiltinToolInput } from "../src/core/tools/builtin-commands.js";

function makeStore(): { store: SqliteEventStore; sessionManager: ProjectionSessionManager } {
	const store = new SqliteEventStore("test-ws", ":memory:");
	const sessionManager = new ProjectionSessionManager(store, store);
	return { store, sessionManager };
}

function makeExtManager(
	store: SqliteEventStore,
	sessionManager: ProjectionSessionManager,
): EventStoreExtensionSessionManager {
	return new EventStoreExtensionSessionManager({
		store,
		projection: sessionManager.getActiveSession(),
		cwd: "/tmp",
		sessionManager,
	});
}

describe("history_tree", () => {
	// ── Tree building ────────────────────────────────────────────────────────

	describe("buildHistoryTreeNodes", () => {
		it("organizes sessions into a depth-first tree with child counts", () => {
			const { store, sessionManager } = makeStore();
			const root = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "root task" } });

			const child = sessionManager.createSession("user_explicit", "child-a");
			const grandchild = sessionManager.forkFromSession(child.session_id);

			const nodes = buildHistoryTreeNodes(
				sessionManager.listSessions(),
				sessionManager.getActiveSessionId(),
				store,
			);

			expect(nodes.length).toBe(3);
			const rootNode = nodes.find((n) => n.session_id === root.session_id)!;
			const childNode = nodes.find((n) => n.session_id === child.session_id)!;
			const grandchildNode = nodes.find((n) => n.session_id === grandchild.session_id)!;

			expect(rootNode.depth).toBe(0);
			// child was created without parentSessionId, so it's a root too
			expect(childNode.depth).toBe(0);
			expect(grandchildNode.depth).toBe(1);
			expect(grandchildNode.parent_session_id).toBe(child.session_id);
			expect(childNode.child_count).toBe(1);
			expect(grandchildNode.is_active).toBe(true);
			expect(rootNode.snippet).toContain("root task");

			const text = renderHistoryTreeText(nodes);
			expect(text).toContain(root.session_id);
			expect(text).toContain("[active]");

			sessionManager.dispose();
			store.close();
		});
	});

	// ── SessionManager.jumpToSession ─────────────────────────────────────────

	describe("SessionManager.jumpToSession", () => {
		it("is a no-op when jumping to the active session", () => {
			const { store, sessionManager } = makeStore();
			const active = sessionManager.getActiveSession().getDescriptor();

			const result = sessionManager.jumpToSession(active.session_id);
			expect(result.reopened).toBe(false);
			expect(result.descriptor.session_id).toBe(active.session_id);
			expect(store.query({ types: ["SESSION_JUMPED"] })).toHaveLength(0);

			sessionManager.dispose();
			store.close();
		});

		it("reopens a closed session via fork and emits SESSION_JUMPED", () => {
			const { store, sessionManager } = makeStore();
			const first = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "old work" } });

			// Creating a second session closes the first one
			sessionManager.createSession("user_explicit", "second");
			expect(sessionManager.getSession(first.session_id)!.event_range.end_event_id).not.toBe("HEAD");

			const result = sessionManager.jumpToSession(first.session_id, "return to old work");
			expect(result.reopened).toBe(true);
			expect(result.descriptor.session_id).not.toBe(first.session_id);
			expect(result.descriptor.parent_session_id).toBe(first.session_id);
			// Reopened session preserves the source's start boundary
			expect(result.descriptor.event_range.start_event_id).toBe(first.event_range.start_event_id);
			expect(sessionManager.getActiveSessionId()).toBe(result.descriptor.session_id);

			const jumped = store.query({ types: ["SESSION_JUMPED"] });
			expect(jumped).toHaveLength(1);
			expect((jumped[0].payload as any).target_session_id).toBe(first.session_id);
			expect((jumped[0].payload as any).reopened_as).toBe(result.descriptor.session_id);
			expect((jumped[0].payload as any).reason).toBe("return to old work");
			expect(store.query({ types: ["SESSION_FORKED"] })).toHaveLength(1);

			sessionManager.dispose();
			store.close();
		});

		it("throws for unknown session ids", () => {
			const { store, sessionManager } = makeStore();
			expect(() => sessionManager.jumpToSession("sess_missing")).toThrow("Session not found");
			sessionManager.dispose();
			store.close();
		});
	});

	// ── ExtensionSessionManager.historyTree ──────────────────────────────────

	describe("EventStoreExtensionSessionManager.historyTree", () => {
		it("is undefined when sessionManager is not provided", () => {
			const { store, sessionManager } = makeStore();
			const extManager = new EventStoreExtensionSessionManager({
				store,
				projection: sessionManager.getActiveSession(),
				cwd: "/tmp",
			});
			expect(extManager.historyTree).toBeUndefined();
			sessionManager.dispose();
			store.close();
		});

		it("lists, views, jumps, and forks sessions", () => {
			const { store, sessionManager } = makeStore();
			const extManager = makeExtManager(store, sessionManager);
			const first = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fix cli/args.ts parsing" } });

			sessionManager.createSession("user_explicit", "second topic");

			const historyTree = extManager.historyTree!;
			const nodes = historyTree.list();
			expect(nodes.length).toBe(2);
			expect(nodes.find((n) => n.session_id === first.session_id)?.snippet).toContain("cli/args.ts");

			const view = historyTree.view(first.session_id);
			expect(view).toBeDefined();
			expect(view!.messages.some((line) => line.includes("cli/args.ts"))).toBe(true);

			const jump = historyTree.jump(first.session_id, "back to args work");
			expect(jump.reopened).toBe(true);
			expect(sessionManager.getActiveSessionId()).toBe(jump.session_id);

			const fork = historyTree.fork(first.session_id);
			expect(fork.session_id).not.toBe(first.session_id);
			expect(sessionManager.getSession(fork.session_id)?.parent_session_id).toBe(first.session_id);

			sessionManager.dispose();
			store.close();
		});
	});

	// ── Tool Definition Execution ────────────────────────────────────────────

	describe("history_tree tool", () => {
		it("lists the tree and filters by query", async () => {
			const { store, sessionManager } = makeStore();
			const extManager = makeExtManager(store, sessionManager);
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "authentication bug hunt" } });
			sessionManager.createSession("user_explicit", "unrelated");

			const toolDef = createHistoryTreeToolDefinition();
			const ctx = { sessionManager: extManager } as any;

			const listResult = await toolDef.execute("t1", { action: "list" }, undefined, undefined, ctx);
			expect((listResult.content[0] as any).text).toContain("Session history tree (2 nodes)");

			const queryResult = await toolDef.execute(
				"t2",
				{ action: "list", query: "authentication" },
				undefined,
				undefined,
				ctx,
			);
			expect((queryResult.content[0] as any).text).toContain("authentication bug hunt");
			expect((queryResult.content[0] as any).text).toContain("(1 node)");

			const noMatch = await toolDef.execute(
				"t3",
				{ action: "list", query: "nonexistent-topic" },
				undefined,
				undefined,
				ctx,
			);
			expect((noMatch.content[0] as any).text).toContain("No sessions match");

			sessionManager.dispose();
			store.close();
		});

		it("views, jumps, and forks via the tool", async () => {
			const { store, sessionManager } = makeStore();
			const extManager = makeExtManager(store, sessionManager);
			const first = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "original topic" } });
			sessionManager.createSession("user_explicit", "second");

			const toolDef = createHistoryTreeToolDefinition();
			const ctx = { sessionManager: extManager } as any;

			const viewResult = await toolDef.execute(
				"t1",
				{ action: "view", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((viewResult.content[0] as any).text).toContain(`Session ${first.session_id}`);
			expect((viewResult.content[0] as any).text).toContain("original topic");

			const jumpResult = await toolDef.execute(
				"t2",
				{ action: "jump", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((jumpResult.content[0] as any).text).toContain(`Jumped to session ${first.session_id}`);
			expect((jumpResult.content[0] as any).text).toContain("reopened");

			const forkResult = await toolDef.execute(
				"t3",
				{ action: "fork", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((forkResult.content[0] as any).text).toContain(`Forked session ${first.session_id}`);

			sessionManager.dispose();
			store.close();
		});

		it("returns helpful errors for missing arguments and unknown sessions", async () => {
			const { store, sessionManager } = makeStore();
			const extManager = makeExtManager(store, sessionManager);
			const toolDef = createHistoryTreeToolDefinition();
			const ctx = { sessionManager: extManager } as any;

			const missing = await toolDef.execute("t1", { action: "jump" }, undefined, undefined, ctx);
			expect((missing.content[0] as any).text).toContain("jump requires session_id");

			const unknown = await toolDef.execute(
				"t2",
				{ action: "jump", session_id: "sess_missing" },
				undefined,
				undefined,
				ctx,
			);
			expect((unknown.content[0] as any).text).toContain("failed");

			const noManager = await toolDef.execute(
				"t3",
				{ action: "list" },
				undefined,
				undefined,
				{ sessionManager: undefined } as any,
			);
			expect((noManager.content[0] as any).text).toContain("not available");

			sessionManager.dispose();
			store.close();
		});
	});

	// ── Builtin Command Parsing ──────────────────────────────────────────────

	describe("parseBuiltinToolInput", () => {
		it("parses positional action and session id", () => {
			expect(parseBuiltinToolInput("history_tree", ["list"])).toEqual({
				command: "history_tree",
				input: { action: "list", session_id: undefined, query: undefined, max_messages: undefined, reason: undefined },
			});
			expect(parseBuiltinToolInput("history_tree", ["jump", "sess_0042"])).toMatchObject({
				command: "history_tree",
				input: { action: "jump", session_id: "sess_0042" },
			});
		});

		it("parses flags", () => {
			expect(
				parseBuiltinToolInput("history_tree", ["list", "--query", "auth bug"]),
			).toMatchObject({ input: { action: "list", query: "auth bug" } });
			expect(
				parseBuiltinToolInput("history_tree", ["view", "-s", "sess_1", "--max-messages", "5"]),
			).toMatchObject({ input: { action: "view", session_id: "sess_1", max_messages: 5 } });
			expect(
				parseBuiltinToolInput("history_tree", ["jump", "sess_1", "--reason", "back to work"]),
			).toMatchObject({ input: { action: "jump", session_id: "sess_1", reason: "back to work" } });
		});

		it("throws on unknown or missing action", () => {
			expect(() => parseBuiltinToolInput("history_tree", ["destroy"])).toThrow("unknown action");
			expect(() => parseBuiltinToolInput("history_tree", [])).toThrow("action required");
		});
	});

	// ── Breadcrumb ──────────────────────────────────────────────────────────
	describe("buildSessionBreadcrumb", () => {
		it("returns empty for single root with no children", () => {
			const sessions = [
				{ session_id: "s1", thread_id: "t1", workspace_id: "ws", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit" as const, created_at: 1000 },
			];
			expect(buildSessionBreadcrumb(sessions, "s1")).toBe("");
		});

		it("returns empty when active session is missing", () => {
			const sessions = [
				{ session_id: "s1", thread_id: "t1", workspace_id: "ws", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit" as const, created_at: 1000 },
			];
			expect(buildSessionBreadcrumb(sessions, "nonexistent")).toBe("");
		});

		it("returns breadcrumb for root with children", () => {
			const sessions = [
				{ session_id: "s1", thread_id: "t1", workspace_id: "ws", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit" as const, created_at: 1000 },
				{ session_id: "s2", thread_id: "t1", workspace_id: "ws", parent_session_id: "s1", event_range: { start_event_id: "e1", end_event_id: "HEAD" }, created_by: "fork" as const, created_at: 2000 },
			];
			const crumb = buildSessionBreadcrumb(sessions, "s1");
			expect(crumb).toContain("s1");
			expect(crumb).toContain("root");
			expect(crumb).toContain("history_tree list");
		});

		it("returns breadcrumb with branch chain for nested session", () => {
			const sessions = [
				{ session_id: "s1", thread_id: "t1", workspace_id: "ws", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit" as const, created_at: 1000 },
				{ session_id: "s2", thread_id: "t1", workspace_id: "ws", parent_session_id: "s1", event_range: { start_event_id: "e1", end_event_id: "HEAD" }, created_by: "fork" as const, created_at: 2000 },
				{ session_id: "s3", thread_id: "t1", workspace_id: "ws", parent_session_id: "s2", event_range: { start_event_id: "e2", end_event_id: "HEAD" }, created_by: "fork" as const, created_at: 3000 },
			];
			const crumb = buildSessionBreadcrumb(sessions, "s3");
			expect(crumb).toContain("s3");
			expect(crumb).toContain("depth 2");
			expect(crumb).toContain("s1 → s2 → s3");
		});
	});
});
