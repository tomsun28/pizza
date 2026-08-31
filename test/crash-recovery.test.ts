import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { recoverDanglingTurnState } from "../src/core/runtime/crash-recovery.js";

function makeStore(name: string): SqliteEventStore {
	return new SqliteEventStore(name, ":memory:");
}

function appendAssistantToolUse(store: SqliteEventStore, toolCallIds: string[], threadId?: string) {
	return store.append({
		actor_id: "coder_agent",
		type: "AGENT_MESSAGE_END",
		payload: {
			content: toolCallIds.map((id) => ({ type: "tool_call", id, name: "echo", arguments: { text: id } })),
			model: { provider: "test", model_id: "test" },
			usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
			stop_reason: "tool_use",
		},
		thread_id: threadId,
	});
}

describe("recoverDanglingTurnState", () => {
	it("compensates a tool call that has START but no END", () => {
		const store = makeStore("cr-start-no-end");
		const msg = appendAssistantToolUse(store, ["call_1"]);
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: { tool_call_id: "call_1", tool_name: "echo", arguments: {} },
			caused_by: msg.event_id,
		});

		const result = recoverDanglingTurnState(store);

		expect(result.compensated_tool_call_ids).toEqual(["call_1"]);
		// No second START was emitted
		expect(store.query({ types: ["TOOL_EXECUTION_START"] })).toHaveLength(1);
		const ends = store.query({ types: ["TOOL_EXECUTION_END"] });
		expect(ends).toHaveLength(1);
		const payload = ends[0].payload as { tool_call_id: string; is_error: boolean };
		expect(payload.tool_call_id).toBe("call_1");
		expect(payload.is_error).toBe(true);
		store.close();
	});

	it("emits a START/END pair for a tool call that never started (approval pending at crash)", () => {
		const store = makeStore("cr-never-started");
		appendAssistantToolUse(store, ["call_pending"]);

		const result = recoverDanglingTurnState(store);

		expect(result.compensated_tool_call_ids).toEqual(["call_pending"]);
		expect(store.query({ types: ["TOOL_EXECUTION_START"] })).toHaveLength(1);
		expect(store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(1);
		store.close();
	});

	it("closes the interrupted turn with AGENT_TURN_COMPLETED(reason=aborted)", () => {
		const store = makeStore("cr-turn-completed");
		appendAssistantToolUse(store, ["call_x"]);

		const result = recoverDanglingTurnState(store);

		expect(result.completed_thread_ids).toHaveLength(1);
		const completions = store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completions).toHaveLength(1);
		expect((completions[0].payload as { reason: string }).reason).toBe("aborted");
		store.close();
	});

	it("does not touch resolved tool calls or completed turns", () => {
		const store = makeStore("cr-clean-log");
		const msg = appendAssistantToolUse(store, ["done_1"]);
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: { tool_call_id: "done_1", tool_name: "echo", result: [], is_error: false, duration_ms: 1 },
			caused_by: msg.event_id,
		});
		store.append({ actor_id: "coder_agent", type: "AGENT_TURN_COMPLETED", payload: { reason: "stop" } });

		const result = recoverDanglingTurnState(store);

		expect(result.compensated_tool_call_ids).toHaveLength(0);
		expect(result.completed_thread_ids).toHaveLength(0);
		expect(store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);
		store.close();
	});

	it("is idempotent — a second run finds nothing to compensate", () => {
		const store = makeStore("cr-idempotent");
		appendAssistantToolUse(store, ["call_a", "call_b"]);

		const first = recoverDanglingTurnState(store);
		expect(first.compensated_tool_call_ids.sort()).toEqual(["call_a", "call_b"]);

		const second = recoverDanglingTurnState(store);
		expect(second.compensated_tool_call_ids).toHaveLength(0);
		expect(second.completed_thread_ids).toHaveLength(0);
		expect(store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(2);
		store.close();
	});

	it("skips the turn completion when a later AGENT_TURN_COMPLETED already exists in the thread", () => {
		const store = makeStore("cr-existing-completion");
		appendAssistantToolUse(store, ["call_y"], "thread_1");
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_TURN_COMPLETED",
			payload: { reason: "aborted" },
			thread_id: "thread_1",
		});

		const result = recoverDanglingTurnState(store);

		expect(result.compensated_tool_call_ids).toEqual(["call_y"]);
		expect(result.completed_thread_ids).toHaveLength(0);
		expect(store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);
		store.close();
	});

	it("handles multiple interrupted threads independently", () => {
		const store = makeStore("cr-multi-thread");
		appendAssistantToolUse(store, ["t1_call"], "thread_1");
		appendAssistantToolUse(store, ["t2_call"], "thread_2");

		const result = recoverDanglingTurnState(store);

		expect(result.compensated_tool_call_ids.sort()).toEqual(["t1_call", "t2_call"]);
		expect(result.completed_thread_ids.sort()).toEqual(["thread_1", "thread_2"]);
		store.close();
	});
});