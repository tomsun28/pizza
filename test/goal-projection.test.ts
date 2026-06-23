import { describe, it, expect, beforeEach } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { GoalProjection } from "../src/core/projection/goal-projection.js";
import { buildRecentTaskHistory } from "../src/core/projection/task-history.js";

describe("GoalProjection", () => {
	let store: SqliteEventStore;
	let projection: GoalProjection;

	beforeEach(() => {
		store = new SqliteEventStore("test_workspace", ":memory:");
		projection = new GoalProjection(store);
	});

	it("creates a goal from GOAL_CREATED event", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: {
				goal_id: "goal_1",
				title: "Implement auth system",
				description: "Add JWT-based authentication",
			},
		});

		projection.rebuild();
		const goals = projection.listGoals();
		expect(goals).toHaveLength(1);
		expect(goals[0].goal_id).toBe("goal_1");
		expect(goals[0].title).toBe("Implement auth system");
		expect(goals[0].status).toBe("created");
	});

	it("tracks goal lifecycle through events", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "goal_1", title: "Build feature X" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "GOAL_CLASSIFIED",
			payload: { goal_id: "goal_1", classification: "long_running", reason: "Multi-file changes" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "GOAL_PLANNED",
			payload: {
				goal_id: "goal_1",
				task_ids: ["task_1", "task_2"],
				acceptance_criteria: ["Tests pass", "No regressions"],
			},
		});

		projection.rebuild();
		const goal = projection.getGoal("goal_1");
		expect(goal?.status).toBe("planned");
		expect(goal?.classification).toBe("long_running");
		expect(goal?.task_ids).toEqual(["task_1", "task_2"]);
		expect(goal?.acceptance_criteria).toEqual(["Tests pass", "No regressions"]);
	});

	it("creates tasks and links them to goal", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "goal_1", title: "Build feature" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: {
				task_id: "task_1",
				goal_id: "goal_1",
				title: "Write types",
				priority: "high",
				depends_on: [],
			},
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: {
				task_id: "task_2",
				goal_id: "goal_1",
				title: "Write implementation",
				priority: "medium",
				depends_on: ["task_1"],
			},
		});

		projection.rebuild();
		const tasks = projection.getTasksForGoal("goal_1");
		expect(tasks).toHaveLength(2);
		expect(tasks[0].title).toBe("Write types");
		expect(tasks[1].depends_on).toEqual(["task_1"]);

		const goal = projection.getGoal("goal_1");
		expect(goal?.task_ids).toContain("task_1");
		expect(goal?.task_ids).toContain("task_2");
	});

	it("identifies ready and blocked tasks", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "goal_1", title: "Build feature" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: { task_id: "task_1", goal_id: "goal_1", title: "Types", priority: "high", depends_on: [] },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: { task_id: "task_2", goal_id: "goal_1", title: "Impl", priority: "medium", depends_on: ["task_1"] },
		});

		projection.rebuild();

		// task_1 is ready (no deps), task_2 is blocked
		expect(projection.getReadyTasks("goal_1").map((t) => t.task_id)).toEqual(["task_1"]);
		expect(projection.getBlockedTasks("goal_1").map((t) => t.task_id)).toEqual(["task_2"]);

		// Complete task_1 — now task_2 should be ready
		store.append({
			actor_id: "coder_agent",
			type: "TASK_COMPLETED",
			payload: { task_id: "task_1", summary: "Done" },
		});
		projection.rebuild();
		expect(projection.getReadyTasks("goal_1").map((t) => t.task_id)).toEqual(["task_2"]);
		expect(projection.getBlockedTasks("goal_1")).toHaveLength(0);
	});

	it("tracks task lifecycle through events", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "goal_1", title: "Feature" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: { task_id: "task_1", goal_id: "goal_1", title: "Work", priority: "high" },
		});
		store.append({
			actor_id: "runtime",
			type: "TASK_ASSIGNED",
			payload: { task_id: "task_1", assigned_to: "worker", session_id: "sess_1" },
		});
		store.append({
			actor_id: "runtime",
			type: "TASK_STARTED",
			payload: { task_id: "task_1", session_id: "sess_1" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_PROGRESS",
			payload: { task_id: "task_1", note: "50% done", percentage: 50 },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_COMPLETED",
			payload: { task_id: "task_1", summary: "All done" },
		});
		store.append({
			actor_id: "user",
			type: "TASK_ACCEPTED",
			payload: { task_id: "task_1" },
		});

		projection.rebuild();
		const task = projection.getTask("task_1");
		expect(task?.status).toBe("accepted");
		expect(task?.assigned_to).toBe("worker");
		expect(task?.session_id).toBe("sess_1");
		expect(task?.progress_notes).toEqual(["50% done"]);
	});

	it("handles task rework", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "goal_1", title: "Feature" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: { task_id: "task_1", goal_id: "goal_1", title: "Work", priority: "high" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_COMPLETED",
			payload: { task_id: "task_1" },
		});
		store.append({
			actor_id: "user",
			type: "TASK_REWORK_REQUESTED",
			payload: { task_id: "task_1", reason: "Missing error handling" },
		});

		projection.rebuild();
		const task = projection.getTask("task_1");
		expect(task?.status).toBe("rework");
		expect(task?.rework_reason).toBe("Missing error handling");
	});

	it("goal transitions to running when task starts", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "goal_1", title: "Feature" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "GOAL_PLANNED",
			payload: { goal_id: "goal_1", task_ids: ["task_1"] },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			payload: { task_id: "task_1", goal_id: "goal_1", title: "Work", priority: "high" },
		});
		store.append({
			actor_id: "runtime",
			type: "TASK_STARTED",
			payload: { task_id: "task_1", session_id: "sess_1" },
		});

		projection.rebuild();
		const goal = projection.getGoal("goal_1");
		expect(goal?.status).toBe("running");
		expect(goal?.active_session_id).toBe("sess_1");
	});

	it("live subscription applies events incrementally", () => {
		projection.rebuild();
		projection.startLive();

		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "goal_1", title: "Live goal" },
		});

		const goal = projection.getGoal("goal_1");
		expect(goal?.title).toBe("Live goal");
		expect(goal?.status).toBe("created");

		store.append({
			actor_id: "coder_agent",
			type: "GOAL_COMPLETED",
			payload: { goal_id: "goal_1", summary: "Done" },
		});

		expect(projection.getGoal("goal_1")?.status).toBe("completed");
		expect(projection.listActiveGoals()).toHaveLength(0);

		projection.stopLive();
	});

	it("builds recent task history with generated summaries", () => {
		store.append({
			actor_id: "user",
			type: "GOAL_CREATED",
			payload: { goal_id: "goal_1", title: "Feature" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			timestamp: 1_000,
			payload: { task_id: "task_1", goal_id: "goal_1", title: "Write types", priority: "high" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_CREATED",
			timestamp: 2_000,
			payload: { task_id: "task_2", goal_id: "goal_1", title: "Write implementation", priority: "medium" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_PROGRESS",
			timestamp: 3_000,
			payload: { task_id: "task_2", note: "Parsing and rendering wired" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "TASK_COMPLETED",
			timestamp: 4_000,
			payload: { task_id: "task_1", summary: "Types exported and covered" },
		});

		projection.rebuild();
		const history = buildRecentTaskHistory(projection, 2);

		expect(history.map((task) => task.task_id)).toEqual(["task_1", "task_2"]);
		expect(history[0]).toMatchObject({
			status: "completed",
			summary: "Types exported and covered",
		});
		expect(history[1]).toMatchObject({
			status: "in_progress",
			summary: "Parsing and rendering wired",
		});
	});
});
