import { describe, it, expect, beforeEach } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { TimelineProjection } from "../src/core/projection/timeline-projection.js";

describe("TimelineProjection", () => {
	let store: SqliteEventStore;
	let timeline: TimelineProjection;

	beforeEach(() => {
		store = new SqliteEventStore("test_workspace", ":memory:");
		timeline = new TimelineProjection(store);
	});

	it("converts USER_MESSAGE to user_message entry", () => {
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "Hello, please fix the bug" },
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe("user_message");
		expect(entries[0].summary).toBe("Hello, please fix the bug");
		expect(entries[0].actor_id).toBe("user");
	});

	it("truncates long user messages", () => {
		const longText = "x".repeat(200);
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: longText },
		});

		const entries = timeline.query();
		expect(entries[0].summary.length).toBeLessThan(110);
		expect(entries[0].summary).toContain("…");
	});

	it("converts AGENT_MESSAGE_END to agent_message entry", () => {
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "Here is the fix" }],
				stop_reason: "stop",
				usage: { total: 500 },
			},
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe("agent_message");
		expect(entries[0].summary).toBe("Here is the fix");
		expect(entries[0].metadata?.stop_reason).toBe("stop");
		expect(entries[0].metadata?.tokens).toBe(500);
	});

	it("calculates tool execution duration", () => {
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: { tool_call_id: "tc_1", tool_name: "read_file" },
			timestamp: 1000,
		});
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: { tool_call_id: "tc_1", tool_name: "read_file", is_error: false },
			timestamp: 1250,
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(1); // only END events are in timeline
		expect(entries[0].kind).toBe("tool_execution");
		expect(entries[0].summary).toBe("read_file");
		expect(entries[0].duration_ms).toBe(250);
	});

	it("marks tool execution errors", () => {
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: { tool_call_id: "tc_2", tool_name: "edit_file" },
		});
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: { tool_call_id: "tc_2", tool_name: "edit_file", is_error: true },
		});

		const entries = timeline.query();
		expect(entries[0].summary).toBe("edit_file (error)");
		expect(entries[0].metadata?.is_error).toBe(true);
	});

	it("includes file mutations", () => {
		store.append({
			actor_id: "runtime",
			type: "FILE_MUTATION_APPLIED",
			payload: { path: "src/main.ts", operation: "modify" },
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe("file_mutation");
		expect(entries[0].summary).toBe("modify src/main.ts");
	});

	it("includes nested file mutation payloads", () => {
		store.append({
			actor_id: "runtime",
			type: "FILE_MUTATION_APPLIED",
			payload: { mutation: { path: "README.md", operation: "create" } },
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe("file_mutation");
		expect(entries[0].summary).toBe("create README.md");
		expect(entries[0].metadata?.path).toBe("README.md");
	});

	it("includes goal events", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "g1", title: "Add auth" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "GOAL_COMPLETED",
			payload: { goal_id: "g1", title: "Add auth" },
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(2);
		expect(entries[0].kind).toBe("goal_event");
		expect(entries[0].summary).toContain("created");
		expect(entries[1].summary).toContain("completed");
	});

	it("includes session boundaries", () => {
		store.append({
			actor_id: "runtime",
			type: "SESSION_CREATED",
			payload: { session_id: "s1", reason: "user_explicit" },
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe("session_boundary");
		expect(entries[0].summary).toContain("created");
	});

	it("filters by kind", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "hi" } });
		store.append({ actor_id: "runtime", type: "TOOL_EXECUTION_START", payload: { tool_call_id: "t1", tool_name: "x" } });
		store.append({ actor_id: "runtime", type: "TOOL_EXECUTION_END", payload: { tool_call_id: "t1", tool_name: "x" } });
		store.append({ actor_id: "coder_agent", type: "AGENT_MESSAGE_END", payload: { content: [{ type: "text", text: "ok" }] } });

		const userOnly = timeline.query({ kinds: ["user_message"] });
		expect(userOnly).toHaveLength(1);
		expect(userOnly[0].kind).toBe("user_message");

		const toolsOnly = timeline.query({ kinds: ["tool_execution"] });
		expect(toolsOnly).toHaveLength(1);
	});

	it("respects limit", () => {
		for (let i = 0; i < 10; i++) {
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: `msg ${i}` } });
		}

		const entries = timeline.query({ limit: 3 });
		expect(entries).toHaveLength(3);
		// Should be the LAST 3
		expect(entries[0].summary).toBe("msg 7");
		expect(entries[2].summary).toBe("msg 9");
	});

	it("includes checkpoints", () => {
		store.append({
			actor_id: "runtime",
			type: "CHECKPOINT_CREATED",
			payload: { checkpoint_id: "cp_1", label: "before refactor" },
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe("checkpoint");
		expect(entries[0].summary).toBe("Checkpoint: before refactor");
	});

	it("includes runtime errors", () => {
		store.append({
			actor_id: "runtime",
			type: "RUNTIME_ERROR",
			payload: { error_message: "LLM rate limited" },
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe("error");
		expect(entries[0].summary).toBe("LLM rate limited");
	});

	it("includes agent errors and aborted compactions", () => {
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_ERROR",
			payload: { error: "Malformed provider response" },
		});
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_ABORTED",
			payload: { message: "User cancelled" },
		});

		const entries = timeline.query();
		expect(entries).toHaveLength(2);
		expect(entries[0].kind).toBe("error");
		expect(entries[0].summary).toBe("Malformed provider response");
		expect(entries[1].kind).toBe("compaction");
		expect(entries[1].summary).toBe("Context compaction aborted: User cancelled");
	});
});
