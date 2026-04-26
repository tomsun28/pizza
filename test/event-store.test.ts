/**
 * EventStore tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { JsonlEventStore } from "../src/core/event-store/jsonl-store.js";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { exportSqliteToJsonl, migrateJsonlToSqlite } from "../src/core/event-store/migrations.js";
import { deriveWorkspaceId } from "../src/core/event-store/workspace.js";
import type { EventBase } from "../src/core/event-store/types.js";

describe("JsonlEventStore", () => {
	const testDir = join(tmpdir(), ".test-pizza-event-store", String(Date.now()));
	const workspaceId = "test-workspace";

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should create an empty store", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		expect(store.workspace_id).toBe(workspaceId);
		expect(store.size).toBe(0);
		expect(store.head).toBeUndefined();
	});

	it("should append events with generated id and timestamp", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const event = store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "hello" },
		});

		expect(event.event_id).toBeDefined();
		expect(event.event_id.length).toBeGreaterThan(10);
		expect(event.sequence).toBe(1);
		expect(event.timestamp).toBeGreaterThan(0);
		expect(event.workspace_id).toBe(workspaceId);
		expect(event.runtime_id).toBe("local_runtime");
		expect(event.schema_version).toBe(1);
		expect(event.type).toBe("USER_MESSAGE");
		expect((event.payload as { content: string }).content).toBe("hello");

		expect(store.size).toBe(1);
		expect(store.head).toBe(event.event_id);
		expect(store.head_sequence).toBe(1);
	});

	it("should assign monotonic sequence numbers", () => {
		const store = new JsonlEventStore(workspaceId, testDir, "runtime_test");
		const first = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		const second = store.append({ actor_id: "runtime", type: "TOOL_EXECUTION_END", payload: {} });

		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(first.runtime_id).toBe("runtime_test");
		expect(store.query({ after_sequence: 1 })).toEqual([second]);
		expect(store.query({ before_sequence: 2 })).toEqual([first]);
	});

	it("should deduplicate idempotent appends", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const first = store.append({
			actor_id: "runtime",
			type: "CHECKPOINT_CREATED",
			payload: { ref: "a" },
			idempotency_key: "checkpoint:a",
		});
		const second = store.append({
			actor_id: "runtime",
			type: "CHECKPOINT_CREATED",
			payload: { ref: "b" },
			idempotency_key: "checkpoint:a",
		});

		expect(second).toBe(first);
		expect(store.size).toBe(1);
	});

	it("should get event by id", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const event = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "test" } });

		const retrieved = store.get(event.event_id);
		expect(retrieved).toBeDefined();
		expect(retrieved?.event_id).toBe(event.event_id);
	});

	it("should get undefined for non-existent id", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		expect(store.get("non-existent")).toBeUndefined();
	});

	it("should query by type", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "hello" } });
		store.append({ actor_id: "coder_agent", type: "AGENT_MESSAGE_END", payload: {} });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "world" } });

		const userMessages = store.query({ types: ["USER_MESSAGE"] });
		expect(userMessages.length).toBe(2);
		expect(userMessages.every((e) => e.type === "USER_MESSAGE")).toBe(true);

		const agentMessages = store.query({ types: ["AGENT_MESSAGE_END"] });
		expect(agentMessages.length).toBe(1);
	});

	it("should query by actor_id", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		store.append({ actor_id: "coder_agent", type: "AGENT_MESSAGE_END", payload: {} });
		store.append({ actor_id: "runtime", type: "TOOL_EXECUTION_END", payload: {} });

		const userEvents = store.query({ actor_ids: ["user"] });
		expect(userEvents.length).toBe(1);

		const nonUserEvents = store.query({ actor_ids: ["coder_agent", "runtime"] });
		expect(nonUserEvents.length).toBe(2);
	});

	it("should query with limit", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		for (let i = 0; i < 10; i++) {
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { i } });
		}

		const latest = store.latest(3);
		expect(latest.length).toBe(3);

		const limited = store.query({ limit: 5 });
		expect(limited.length).toBe(5);
	});

	it("should query with reverse order", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { n: 1 } });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { n: 2 } });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { n: 3 } });

		const reversed = store.query({ reverse: true });
		expect((reversed[0].payload as { n: number }).n).toBe(3);
		expect((reversed[2].payload as { n: number }).n).toBe(1);
	});

	it("should track causal chain", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const userEvent = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		const agentEvent = store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {},
			caused_by: userEvent.event_id,
		});
		const toolEvent = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {},
			caused_by: agentEvent.event_id,
		});

		const chain = store.getCausalChain(toolEvent.event_id);
		expect(chain.length).toBe(3);
		expect(chain[0].event_id).toBe(userEvent.event_id);
		expect(chain[1].event_id).toBe(agentEvent.event_id);
		expect(chain[2].event_id).toBe(toolEvent.event_id);
	});

	it("should query by caused_by (all descendants)", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const userEvent = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		const agentEvent = store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {},
			caused_by: userEvent.event_id,
		});
		const toolEvent = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {},
			caused_by: agentEvent.event_id, // grandchild of userEvent
		});
		// Another independent chain
		const userEvent2 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });

		// caused_by returns all descendants recursively
		const user2Children = store.query({ caused_by: userEvent2.event_id });
		expect(user2Children.length).toBe(0);

		// userEvent has 2 descendants: agentEvent and toolEvent
		const userChildren = store.query({ caused_by: userEvent.event_id });
		expect(userChildren.length).toBe(2);
		expect(userChildren.map((e) => e.event_id)).toContain(agentEvent.event_id);
		expect(userChildren.map((e) => e.event_id)).toContain(toolEvent.event_id);

		// agentEvent has 1 child: toolEvent
		const agentChildren = store.query({ caused_by: agentEvent.event_id });
		expect(agentChildren.length).toBe(1);
		expect(agentChildren[0].event_id).toBe(toolEvent.event_id);

		// getCausalChain returns the path from root to target
		const chain = store.getCausalChain(toolEvent.event_id);
		expect(chain.length).toBe(3);
		expect(chain[0].event_id).toBe(userEvent.event_id);
		expect(chain[1].event_id).toBe(agentEvent.event_id);
		expect(chain[2].event_id).toBe(toolEvent.event_id);
	});

	it("should subscribe and receive events", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const received: EventBase[] = [];

		const unsubscribe = store.subscribe((event) => {
			received.push(event);
		});

		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "hello" } });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "world" } });

		expect(received.length).toBe(2);

		unsubscribe();
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "after unsubscribe" } });
		expect(received.length).toBe(2);
	});

	it("should filter subscription by type", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const received: EventBase[] = [];

		const unsubscribe = store.subscribe(
			(event) => received.push(event),
			{ types: ["USER_MESSAGE"] },
		);

		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		store.append({ actor_id: "coder_agent", type: "AGENT_MESSAGE_END", payload: {} });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });

		expect(received.length).toBe(2);
		expect(received.every((e) => e.type === "USER_MESSAGE")).toBe(true);

		unsubscribe();
	});

	it("should filter subscription by after", async () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const e1 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		// Subscribe before appending e2/e3
		const received: EventBase[] = [];
		const unsubscribe = store.subscribe((event) => received.push(event), { after: e1.event_id });
		// Append more events after subscribing
		const e2 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: {} });

		expect(received.length).toBe(2);
		// All received events should come after e1
		for (const event of received) {
			expect(event.event_id > e1.event_id).toBe(true);
		}

		unsubscribe();
	});

	it("should persist events to disk", () => {
		const filePath = testDir;

		{
			const store = new JsonlEventStore(workspaceId, filePath);
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "persisted" } });
			store.append({ actor_id: "coder_agent", type: "AGENT_MESSAGE_END", payload: {} });
		}

		{
			const store = new JsonlEventStore(workspaceId, filePath);
			expect(store.size).toBe(2);
			expect(store.query({ types: ["USER_MESSAGE"] })[0]).toBeDefined();
		}
	});

	it("should load events from all daily files and legacy events.jsonl", () => {
		const firstDay = "2026-01-01";
		const secondDay = "2026-01-02";
		writeFileSync(
			join(testDir, `events-${firstDay}.jsonl`),
			JSON.stringify({
				event_id: "evt_first",
				workspace_id: workspaceId,
				actor_id: "user",
				timestamp: Date.parse(`${firstDay}T00:00:00.000Z`),
				type: "USER_MESSAGE",
				payload: { content: "first" },
			}) + "\n",
		);
		writeFileSync(
			join(testDir, `events-${secondDay}.jsonl`),
			JSON.stringify({
				event_id: "evt_second",
				sequence: 10,
				workspace_id: workspaceId,
				runtime_id: "remote_runtime",
				actor_id: "runtime",
				timestamp: Date.parse(`${secondDay}T00:00:00.000Z`),
				type: "TOOL_EXECUTION_END",
				payload: {},
				schema_version: 1,
			}) + "\n",
		);
		appendFileSync(
			join(testDir, "events.jsonl"),
			JSON.stringify({
				event_id: "evt_legacy",
				workspace_id: workspaceId,
				actor_id: "coder_agent",
				timestamp: Date.parse("2025-12-31T00:00:00.000Z"),
				type: "AGENT_MESSAGE_END",
				payload: {},
			}) + "\n",
		);

		const store = new JsonlEventStore(workspaceId, testDir);
		const events = store.query({});

		expect(events.map((e) => e.event_id)).toEqual(["evt_legacy", "evt_first", "evt_second"]);
		expect(events[0].sequence).toBe(1);
		expect(events[0].runtime_id).toBe("local_runtime");
		expect(events[2].sequence).toBe(10);
		expect(events[2].runtime_id).toBe("remote_runtime");
	});

	it("should appendBatch", () => {
		const store = new JsonlEventStore(workspaceId, testDir);
		const events = store.appendBatch([
			{ actor_id: "user", type: "USER_MESSAGE", payload: { content: "a" } },
			{ actor_id: "coder_agent", type: "AGENT_MESSAGE_END", payload: {} },
			{ actor_id: "user", type: "USER_MESSAGE", payload: { content: "b" } },
		]);

		expect(events.length).toBe(3);
		expect(store.size).toBe(3);
		expect(store.head).toBe(events[2].event_id);
	});
});

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
			session_hint: "sess_1",
		});

		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(second.runtime_id).toBe("runtime_test");
		expect(store.size).toBe(2);
		expect(store.head).toBe(second.event_id);
		expect(store.head_sequence).toBe(2);
		expect(store.query({ after_sequence: 1 })).toEqual([second]);
		expect(store.query({ types: ["USER_MESSAGE"] })).toEqual([first]);
		expect(store.query({ session_hint: "sess_1" })).toEqual([second]);
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

	it("should migrate JSONL events to SQLite", () => {
		const jsonlDir = join(testDir, "jsonl");
		mkdirSync(jsonlDir, { recursive: true });
		const source = new JsonlEventStore(workspaceId, jsonlDir, "jsonl_runtime");
		const root = source.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "migrate me" },
		});
		source.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: { content: [{ type: "text", text: "done" }] },
			caused_by: root.event_id,
		});

		const sqlitePath = join(testDir, "migrated.sqlite");
		const result = migrateJsonlToSqlite({
			workspace_id: workspaceId,
			jsonlDir,
			sqlitePath,
			runtime_id: "sqlite_runtime",
		});
		const target = createStore(workspaceId, "migrated.sqlite");

		expect(result).toEqual({ events_read: 2, events_written: 2 });
		expect(target.query({}).map((event) => event.event_id)).toEqual(
			source.query({}).map((event) => event.event_id),
		);
	});

	it("should export SQLite events to JSONL", () => {
		const store = createStore();
		const first = store.append({
			event_id: "evt_export_1",
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "export me" },
		});
		const second = store.append({
			event_id: "evt_export_2",
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {},
			caused_by: first.event_id,
		});

		const jsonlPath = join(testDir, "exports", "events.jsonl");
		const result = exportSqliteToJsonl({
			workspace_id: workspaceId,
			sqlitePath: join(testDir, "events.sqlite"),
			jsonlPath,
			overwrite: true,
		});

		expect(result).toEqual({ events_read: 2, events_written: 2 });
		expect(readFileSync(jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).event_id)).toEqual([
			first.event_id,
			second.event_id,
		]);
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
