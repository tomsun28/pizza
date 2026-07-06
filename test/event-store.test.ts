/**
 * EventStore tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { deriveWorkspaceId } from "../src/core/event-store/workspace.js";
import type { EventBase } from "../src/core/event-store/types.js";

describe("SqliteEventStore", () => {
	const testDir = join(tmpdir(), ".test-pizza-sqlite-event-store", String(Date.now()));
	const workspaceId = "sqlite-workspace";
	const stores: SqliteEventStore[] = [];

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		for (const store of stores.splice(0)) {
			store.close();
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	function createStore(workspace = workspaceId, dbName = "events.sqlite"): SqliteEventStore {
		const store = new SqliteEventStore(workspace, join(testDir, dbName), "runtime_test");
		stores.push(store);
		return store;
	}

	it("should append and query events with EventStore-compatible metadata", () => {
		const store = createStore();
		const first = store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "hello" },
			correlation_id: "turn_1",
		});
		const second = store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: { content: [{ type: "text", text: "hi" }], stop_reason: "stop" },
			caused_by: first.event_id,
			thread_id: "sess_1",
		});

		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(second.runtime_id).toBe("runtime_test");
		expect(store.size).toBe(2);
		expect(store.head).toBe(second.event_id);
		expect(store.head_sequence).toBe(2);
		expect(store.query({ after_sequence: 1 })).toEqual([second]);
		expect(store.query({ types: ["USER_MESSAGE"] })).toEqual([first]);
		expect(store.query({ thread_id: "sess_1" })).toEqual([second]);
		expect(store.latest(1)).toEqual([second]);
	});

	it("should assign monotonic sequences during appendBatch", () => {
		const store = createStore();
		const events = store.appendBatch([
			{ actor_id: "user", type: "USER_MESSAGE", payload: { content: "a" } },
			{ actor_id: "runtime", type: "TOOL_EXECUTION_END", payload: { tool_call_id: "call_1" } },
			{ actor_id: "user", type: "USER_MESSAGE", payload: { content: "b" } },
		]);

		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
		expect(store.query({}).map((event) => event.sequence)).toEqual([1, 2, 3]);
	});

	it("should preserve explicit sequence values during migration-style appendBatch", () => {
		const store = createStore();
		const events = store.appendBatch([
			{ event_id: "evt_1", sequence: 5, actor_id: "user", type: "USER_MESSAGE", payload: {} },
			{ event_id: "evt_2", sequence: 9, actor_id: "runtime", type: "TOOL_EXECUTION_END", payload: {} },
			{ event_id: "evt_3", actor_id: "user", type: "USER_MESSAGE", payload: {} },
		]);

		expect(events.map((event) => event.sequence)).toEqual([5, 9, 10]);
		expect(store.head_sequence).toBe(10);
	});

	it("should deduplicate idempotent appends per workspace", () => {
		const firstWorkspace = createStore("ws_one", "shared.sqlite");
		const secondWorkspace = createStore("ws_two", "shared.sqlite");

		const first = firstWorkspace.append({
			actor_id: "runtime",
			type: "CHECKPOINT_CREATED",
			payload: { checkpoint_id: "a" },
			idempotency_key: "checkpoint:a",
		});
		const duplicate = firstWorkspace.append({
			actor_id: "runtime",
			type: "CHECKPOINT_CREATED",
			payload: { checkpoint_id: "b" },
			idempotency_key: "checkpoint:a",
		});
		const otherWorkspace = secondWorkspace.append({
			actor_id: "runtime",
			type: "CHECKPOINT_CREATED",
			payload: { checkpoint_id: "a" },
			idempotency_key: "checkpoint:a",
		});

		expect(duplicate.event_id).toBe(first.event_id);
		expect(firstWorkspace.size).toBe(1);
		expect(secondWorkspace.size).toBe(1);
		expect(otherWorkspace.workspace_id).toBe("ws_two");
	});

	it("should query causal descendants recursively", () => {
		const store = createStore();
		const root = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		const child = store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {},
			caused_by: root.event_id,
		});
		const grandchild = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {},
			caused_by: child.event_id,
		});

		expect(store.query({ caused_by: root.event_id }).map((event) => event.event_id)).toEqual([
			child.event_id,
			grandchild.event_id,
		]);
		expect(store.getCausalChain(grandchild.event_id).map((event) => event.event_id)).toEqual([
			root.event_id,
			child.event_id,
			grandchild.event_id,
		]);
	});

	it("should notify subscribers with filters", () => {
		const store = createStore();
		const received: EventBase[] = [];
		const unsubscribe = store.subscribe((event) => received.push(event), { types: ["USER_MESSAGE"] });

		store.append({ actor_id: "runtime", type: "TOOL_EXECUTION_START", payload: {} });
		const userEvent = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		unsubscribe();
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });

		expect(received).toEqual([userEvent]);
	});

});

describe("deriveWorkspaceId", () => {
	it("should derive consistent id from same cwd", () => {
		const cwd = "/Users/test/project";
		const id1 = deriveWorkspaceId(cwd);
		const id2 = deriveWorkspaceId(cwd);
		expect(id1).toBe(id2);
		expect(id1.startsWith("ws_")).toBe(true);
	});

	it("should derive different ids for different cwds", () => {
		const id1 = deriveWorkspaceId("/Users/test/project1");
		const id2 = deriveWorkspaceId("/Users/test/project2");
		expect(id1).not.toBe(id2);
	});

	it("should resolve workspace_id from canonical cwd", () => {
		// Same canonical path should give same id
		const id1 = deriveWorkspaceId("/Users/test/project");
		const id2 = deriveWorkspaceId("/Users/test/project/"); // trailing slash
		const id3 = deriveWorkspaceId("/Users/test/./project"); // dot path
		expect(id1).toBe(id2);
		expect(id1).toBe(id3);
		expect(id1.startsWith("ws_")).toBe(true);
	});
});
