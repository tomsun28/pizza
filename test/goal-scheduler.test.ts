import { describe, it, expect, beforeEach } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { GoalScheduler } from "../src/core/goal/scheduler.js";

describe("GoalScheduler", () => {
	let store: SqliteEventStore;

	beforeEach(() => {
		store = new SqliteEventStore("test_workspace", ":memory:");
	});

	it("auto-assigns ready tasks after GOAL_PLANNED", () => {
		// Create goal and tasks first (before scheduler starts)
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "g1", title: "Build feature" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: { task_id: "t1", goal_id: "g1", title: "Write code", priority: "high" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: { task_id: "t2", goal_id: "g1", title: "Write tests", priority: "medium", depends_on: ["t1"] },
		});

		// Start scheduler — it subscribes to events
		const scheduler = new GoalScheduler(store);

		// Emit GOAL_PLANNED — triggers scheduling
		store.append({
			actor_id: "coder_agent",
			type: "GOAL_PLANNED",
			payload: { goal_id: "g1", task_ids: ["t1", "t2"] },
		});

		// Verify: t1 should be assigned (ready), t2 blocked
		const assignEvents = store.query({ types: ["TASK_ASSIGNED"] });
		expect(assignEvents).toHaveLength(1);
		expect((assignEvents[0].payload as any).task_id).toBe("t1");
		expect((assignEvents[0].payload as any).assigned_to).toBe("worker");

		scheduler.stop();
	});

	it("dispatches next task when previous completes", () => {
		store.append({ actor_id: "user", type: "GOAL_CREATED", payload: { goal_id: "g1", title: "Feature" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t1", goal_id: "g1", title: "First", priority: "high" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t2", goal_id: "g1", title: "Second", priority: "medium", depends_on: ["t1"] } });
		store.append({ actor_id: "agent", type: "GOAL_PLANNED", payload: { goal_id: "g1", task_ids: ["t1", "t2"] } });

		const scheduler = new GoalScheduler(store);

		// t1 gets assigned at init
		// Now simulate t1 completing
		store.append({ actor_id: "agent", type: "TASK_STARTED", payload: { task_id: "t1", session_id: "s1" } });
		store.append({ actor_id: "agent", type: "TASK_COMPLETED", payload: { task_id: "t1", summary: "done" } });

		// t2 should now be assigned
		const assignEvents = store.query({ types: ["TASK_ASSIGNED"] });
		const t2Assign = assignEvents.find((e) => (e.payload as any).task_id === "t2");
		expect(t2Assign).toBeDefined();

		scheduler.stop();
	});

	it("auto-completes goal when all tasks are done", () => {
		store.append({ actor_id: "user", type: "GOAL_CREATED", payload: { goal_id: "g1", title: "Feature" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t1", goal_id: "g1", title: "Only task", priority: "high" } });
		store.append({ actor_id: "agent", type: "GOAL_PLANNED", payload: { goal_id: "g1", task_ids: ["t1"] } });

		const scheduler = new GoalScheduler(store);

		// Complete the only task
		store.append({ actor_id: "agent", type: "TASK_STARTED", payload: { task_id: "t1", session_id: "s1" } });
		store.append({ actor_id: "agent", type: "TASK_COMPLETED", payload: { task_id: "t1" } });

		// Goal should be auto-completed
		const goalEvents = store.query({ types: ["GOAL_COMPLETED"] });
		expect(goalEvents).toHaveLength(1);
		expect((goalEvents[0].payload as any).goal_id).toBe("g1");

		scheduler.stop();
	});

	it("respects maxConcurrency", () => {
		store.append({ actor_id: "user", type: "GOAL_CREATED", payload: { goal_id: "g1", title: "Feature" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t1", goal_id: "g1", title: "Task A", priority: "high" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t2", goal_id: "g1", title: "Task B", priority: "high" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t3", goal_id: "g1", title: "Task C", priority: "medium" } });

		// maxConcurrency = 2
		const scheduler = new GoalScheduler(store, { maxConcurrency: 2 });

		store.append({ actor_id: "agent", type: "GOAL_PLANNED", payload: { goal_id: "g1", task_ids: ["t1", "t2", "t3"] } });

		const assignEvents = store.query({ types: ["TASK_ASSIGNED"] });
		// Should only assign 2 tasks (maxConcurrency)
		expect(assignEvents).toHaveLength(2);

		scheduler.stop();
	});

	it("infers agent role from task title", () => {
		store.append({ actor_id: "user", type: "GOAL_CREATED", payload: { goal_id: "g1", title: "Feature" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t1", goal_id: "g1", title: "Write unit tests", priority: "high" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t2", goal_id: "g1", title: "Review code changes", priority: "medium" } });
		store.append({ actor_id: "agent", type: "TASK_CREATED", payload: { task_id: "t3", goal_id: "g1", title: "Plan architecture", priority: "low" } });

		const scheduler = new GoalScheduler(store, { maxConcurrency: 3 });

		store.append({ actor_id: "agent", type: "GOAL_PLANNED", payload: { goal_id: "g1", task_ids: ["t1", "t2", "t3"] } });

		const assignEvents = store.query({ types: ["TASK_ASSIGNED"] });
		const byTaskId = Object.fromEntries(assignEvents.map((e) => [(e.payload as any).task_id, (e.payload as any).assigned_to]));
		expect(byTaskId["t1"]).toBe("tester");
		expect(byTaskId["t2"]).toBe("reviewer");
		expect(byTaskId["t3"]).toBe("planner");

		scheduler.stop();
	});
});
