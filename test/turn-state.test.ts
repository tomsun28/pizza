/**
 * TurnState — explicit, log-replayable turn-level state.
 *
 * Pins the run_id-scoped replay contract: USER_FOLLOWUP_QUEUED events carry
 * the run_id that queued them; a fresh process run re-queues only its own
 * undelivered entries (stale ones belong to dead in-memory buffers) and
 * skips delivered/dropped ones. Legacy entries without a run_id fall back to
 * the sequence-vs-last-RUNTIME_STARTED comparison.
 */

import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { TurnState, generateRunId } from "../src/core/runtime/turn-state.js";

function queueFollowUp(store: SqliteEventStore, content: string, runId?: string): string {
	const e = store.append({
		actor_id: "user",
		type: "USER_FOLLOWUP_QUEUED",
		payload: { content, run_id: runId },
	});
	return e.event_id;
}

describe("TurnState replayFollowUpsFromLog", () => {
	it("re-queues this run's undelivered follow-ups", () => {
		const store = new SqliteEventStore("ws_turnstate_1", ":memory:");
		const state = new TurnState(generateRunId());
		store.append({
			actor_id: "runtime",
			type: "RUNTIME_STARTED",
			payload: { runtime_id: "rt", kind: "local", cwd: "/tmp", run_id: state.runId },
		});
		queueFollowUp(store, "queued this run", state.runId);

		const recovered = state.replayFollowUpsFromLog(store);
		expect(recovered).toHaveLength(1);
		expect(recovered[0]!.content).toBe("queued this run");
		expect(state.followUpQueue).toHaveLength(1);
		store.close();
	});

	it("ignores follow-ups from a previous run's run_id", () => {
		const store = new SqliteEventStore("ws_turnstate_2", ":memory:");
		const previousRun = generateRunId();
		const state = new TurnState(generateRunId());
		store.append({
			actor_id: "runtime",
			type: "RUNTIME_STARTED",
			payload: { runtime_id: "rt", kind: "local", cwd: "/tmp", run_id: state.runId },
		});
		queueFollowUp(store, "stale from previous run", previousRun);
		queueFollowUp(store, "fresh this run", state.runId);

		const recovered = state.replayFollowUpsFromLog(store);
		expect(recovered).toHaveLength(1);
		expect(recovered[0]!.content).toBe("fresh this run");
		store.close();
	});

	it("skips delivered follow-ups (USER_MESSAGE caused_by) and dropped ones", () => {
		const store = new SqliteEventStore("ws_turnstate_3", ":memory:");
		const state = new TurnState(generateRunId());
		const deliveredId = queueFollowUp(store, "delivered", state.runId);
		queueFollowUp(store, "dropped", state.runId);
		queueFollowUp(store, "pending", state.runId);
		// Delivery shape: a USER_MESSAGE (or AGENT_TURN_REQUESTED) caused_by the queue event.
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "delivered" },
			caused_by: deliveredId,
		});
		const droppedEvt = store.query({ types: ["USER_FOLLOWUP_QUEUED"] }).find((e) =>
			(e.payload as { content: string }).content === "dropped",
		)!;
		store.append({
			actor_id: "user",
			type: "USER_FOLLOWUP_DROPPED",
			payload: { dropped_event_ids: [droppedEvt.event_id], reason: "user_interrupt" },
		});

		const recovered = state.replayFollowUpsFromLog(store);
		expect(recovered).toHaveLength(1);
		expect((recovered[0]!.content as string)).toBe("pending");
		store.close();
	});

	it("falls back to sequence comparison for legacy entries without run_id", () => {
		const store = new SqliteEventStore("ws_turnstate_4", ":memory:");
		const state = new TurnState(generateRunId());
		queueFollowUp(store, "legacy stale (before restart)", undefined);
		const started = store.append({
			actor_id: "runtime",
			type: "RUNTIME_STARTED",
			payload: { runtime_id: "rt", kind: "local", cwd: "/tmp", run_id: state.runId },
		});
		expect(started.sequence).toBeGreaterThan(1);
		queueFollowUp(store, "legacy fresh (after restart)", undefined);

		const recovered = state.replayFollowUpsFromLog(store);
		expect(recovered).toHaveLength(1);
		expect((recovered[0]!.content as string)).toBe("legacy fresh (after restart)");
		store.close();
	});

	it("carries user_message_event_id through replay (mid-turn queueing shape)", () => {
		const store = new SqliteEventStore("ws_turnstate_5", ":memory:");
		const state = new TurnState(generateRunId());
		const raw = store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "raw mid-turn message" },
		});
		store.append({
			actor_id: "user",
			type: "USER_FOLLOWUP_QUEUED",
			payload: { content: "raw mid-turn message", reason: "turn_in_flight", user_message_event_id: raw.event_id, run_id: state.runId },
		});

		const recovered = state.replayFollowUpsFromLog(store);
		expect(recovered[0]!.userMessageEventId).toBe(raw.event_id);
		store.close();
	});
});

describe("TurnState removeFollowUp (per-item cancel)", () => {
	it("removes exactly the entry with the matching sourceEventId", () => {
		const state = new TurnState(generateRunId());
		state.queueFollowUp({ content: "a", kind: "followUp", sourceEventId: "ev_a" });
		state.queueFollowUp({ content: "b", kind: "followUp", sourceEventId: "ev_b" });
		state.queueFollowUp({ content: "c", kind: "steer", sourceEventId: "ev_c" });

		const removed = state.removeFollowUp("ev_b");
		expect(removed?.content).toBe("b");
		expect(state.followUpQueue.map((e) => e.sourceEventId)).toEqual(["ev_a", "ev_c"]);
	});

	it("returns undefined for an unknown id and leaves the queue intact", () => {
		const state = new TurnState(generateRunId());
		state.queueFollowUp({ content: "a", kind: "followUp", sourceEventId: "ev_a" });
		expect(state.removeFollowUp("ev_nope")).toBeUndefined();
		expect(state.followUpQueue).toHaveLength(1);
	});

	it("moveFollowUpToFront puts the entry at the front (send-now semantics)", () => {
		const state = new TurnState(generateRunId());
		state.queueFollowUp({ content: "a", kind: "followUp", sourceEventId: "ev_a" });
		state.queueFollowUp({ content: "b", kind: "followUp", sourceEventId: "ev_b" });
		state.queueFollowUp({ content: "c", kind: "steer", sourceEventId: "ev_c" });

		expect(state.moveFollowUpToFront("ev_c")).toBe(true);
		expect(state.followUpQueue.map((e) => e.sourceEventId)).toEqual(["ev_c", "ev_a", "ev_b"]);
		// Front entry: no-op, still true.
		expect(state.moveFollowUpToFront("ev_c")).toBe(true);
		// Unknown id: false, queue untouched.
		expect(state.moveFollowUpToFront("ev_nope")).toBe(false);
		expect(state.followUpQueue).toHaveLength(3);
	});

	it("replay skips an entry dropped via per-item cancel (USER_FOLLOWUP_DROPPED)", () => {
		const store = new SqliteEventStore("ws_turnstate_cancel", ":memory:");
		const runId = generateRunId();
		const state = new TurnState(runId);
		store.append({ actor_id: "runtime", type: "RUNTIME_STARTED", payload: {} });
		const keep = queueFollowUp(store, "keep", runId);
		const cancelled = queueFollowUp(store, "cancelled", runId);
		// Per-item cancel writes a USER_FOLLOWUP_DROPPED listing ONE id.
		store.append({
			actor_id: "runtime",
			type: "USER_FOLLOWUP_DROPPED",
			payload: { dropped_event_ids: [cancelled], reason: "user_cancel" },
		});

		state.replayFollowUpsFromLog(store);
		expect(state.followUpQueue.map((e) => e.sourceEventId)).toEqual([keep]);
	});
});

describe("TurnState in-memory operations", () => {
	it("manages retry timers: schedule, cancel-all clears timeouts", () => {
		const state = new TurnState(generateRunId());
		let fired = 0;
		state.scheduleRetry("re_1", {
			scheduled_event_id: "re_1",
			timeout: setTimeout(() => { fired++; }, 10_000),
			attempt: 1,
			errorMessage: "x",
			retry: () => {},
		});
		expect(state.hasPendingRetries).toBe(true);
		state.cancelAllRetries();
		expect(state.hasPendingRetries).toBe(false);
		expect(fired).toBe(0);
	});

	it("drainPendingApprovals resolves pending approvals with the default decision", () => {
		const state = new TurnState(generateRunId());
		let decision: boolean | undefined;
		state.pendingApprovals.set("intent_1", {
			resolve: (approved) => { decision = approved; },
			tool_call_id: "call_1",
			tool_name: "cli",
			arguments: {},
		});
		state.drainPendingApprovals(false);
		expect(decision).toBe(false);
		expect(state.pendingApprovals.size).toBe(0);
	});

	it("resetCycle clears lifecycle flags and loop signatures", () => {
		const state = new TurnState(generateRunId());
		state.turnInFlight = true;
		state.abortedByUser = true;
		state.recordToolRoundSignature(["cli:a"]);
		state.resetCycle();
		expect(state.turnInFlight).toBe(false);
		expect(state.abortedByUser).toBe(false);
		expect(state.toolRoundSignatures).toHaveLength(0);
	});
});