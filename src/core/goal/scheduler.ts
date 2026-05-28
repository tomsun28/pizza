/**
 * Goal Scheduler
 *
 * Watches the EventStore for task completions and automatically
 * dispatches the next ready tasks. A lightweight scheduler that
 * does NOT execute tasks itself — it only emits TASK_ASSIGNED events
 * for ready tasks, and the runtime decides how to execute them.
 *
 * Design principle: the scheduler is a projection + policy.
 * It reads events to understand state, applies a scheduling policy,
 * and emits new events to drive execution.
 */

import type { EventBase } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import { GoalProjection } from "../projection/goal-projection.js";
import type { AgentRole, GoalDescriptor, TaskDescriptor } from "./types.js";

// ============================================================================
// Scheduler Policy
// ============================================================================

/** Scheduling policy — decides which tasks to dispatch and in what order */
export interface SchedulingPolicy {
	/** Select which ready tasks to assign, and to whom */
	selectTasks(
		readyTasks: TaskDescriptor[],
		goal: GoalDescriptor,
		context: SchedulingContext,
	): TaskAssignment[];
}

/** Context available to the scheduling policy */
export interface SchedulingContext {
	/** All tasks in the goal */
	allTasks: TaskDescriptor[];
	/** Currently running tasks */
	runningTasks: TaskDescriptor[];
	/** Maximum concurrent tasks allowed */
	maxConcurrency: number;
}

/** A task assignment decision */
export interface TaskAssignment {
	task_id: string;
	assigned_to: AgentRole;
}

// ============================================================================
// Default Policy
// ============================================================================

/**
 * DefaultSchedulingPolicy — FIFO with role inference from task content.
 *
 * Rules:
 * 1. Respects maxConcurrency (won't assign more tasks than allowed)
 * 2. Assigns tasks in priority order (critical > high > medium > low)
 * 3. Infers agent role from task title keywords
 */
export class DefaultSchedulingPolicy implements SchedulingPolicy {
	selectTasks(
		readyTasks: TaskDescriptor[],
		_goal: GoalDescriptor,
		context: SchedulingContext,
	): TaskAssignment[] {
		const slots = context.maxConcurrency - context.runningTasks.length;
		if (slots <= 0) return [];

		// Sort by priority
		const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
		const sorted = [...readyTasks].sort(
			(a, b) => priorityOrder[a.priority] - priorityOrder[b.priority],
		);

		return sorted.slice(0, slots).map((task) => ({
			task_id: task.task_id,
			assigned_to: this._inferRole(task),
		}));
	}

	private _inferRole(task: TaskDescriptor): AgentRole {
		const title = task.title.toLowerCase();
		if (title.includes("test") || title.includes("spec")) return "tester";
		if (title.includes("review") || title.includes("audit")) return "reviewer";
		if (title.includes("plan") || title.includes("design")) return "planner";
		return "worker";
	}
}

// ============================================================================
// Goal Scheduler
// ============================================================================

export interface GoalSchedulerOptions {
	/** Maximum concurrent tasks per goal (default: 1) */
	maxConcurrency?: number;
	/** Scheduling policy (default: DefaultSchedulingPolicy) */
	policy?: SchedulingPolicy;
	/** Auto-start on construction (default: true) */
	autoStart?: boolean;
}

/**
 * GoalScheduler watches task lifecycle events and auto-dispatches ready tasks.
 *
 * Usage:
 *   const scheduler = new GoalScheduler(store, { maxConcurrency: 2 });
 *   // ... scheduler emits TASK_ASSIGNED events when tasks become ready
 *   scheduler.stop();
 */
export class GoalScheduler {
	private projection: GoalProjection;
	private policy: SchedulingPolicy;
	private maxConcurrency: number;
	private unsubscribe?: () => void;

	constructor(
		private store: EventStore,
		options?: GoalSchedulerOptions,
	) {
		this.projection = new GoalProjection(store);
		this.policy = options?.policy ?? new DefaultSchedulingPolicy();
		this.maxConcurrency = options?.maxConcurrency ?? 1;

		this.projection.rebuild();

		if (options?.autoStart !== false) {
			this.start();
		}
	}

	/**
	 * Start watching for task lifecycle events.
	 */
	start(): void {
		if (this.unsubscribe) return;

		this.projection.startLive();

		this.unsubscribe = this.store.subscribe(
			(event) => this._onEvent(event),
			{
				types: [
					"GOAL_PLANNED",
					"TASK_COMPLETED",
					"TASK_ACCEPTED",
					"TASK_FAILED",
				],
			},
		);
	}

	/**
	 * Stop watching.
	 */
	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.projection.stopLive();
	}

	/**
	 * Manually trigger scheduling for a goal.
	 */
	scheduleGoal(goalId: string): void {
		this._tryDispatch(goalId);
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private _onEvent(event: EventBase): void {
		const payload = event.payload as { goal_id?: string; task_id?: string };

		if (event.type === "GOAL_PLANNED" && payload.goal_id) {
			this._tryDispatch(payload.goal_id);
			return;
		}

		// For task events, find the goal_id from the task
		if (payload.task_id) {
			const task = this.projection.getTask(payload.task_id);
			if (task) {
				this._tryDispatch(task.goal_id);
			}
		}
	}

	private _tryDispatch(goalId: string): void {
		const goal = this.projection.getGoal(goalId);
		if (!goal) return;
		if (goal.status === "completed" || goal.status === "cancelled") return;

		const allTasks = this.projection.getTasksForGoal(goalId);
		const readyTasks = this.projection.getReadyTasks(goalId);
		const runningTasks = allTasks.filter(
			(t) => t.status === "started" || t.status === "in_progress" || t.status === "assigned",
		);

		if (readyTasks.length === 0) {
			// Check if all tasks are done — if so, complete the goal
			const allDone = allTasks.every(
				(t) => t.status === "completed" || t.status === "accepted" || t.status === "cancelled",
			);
			if (allDone && allTasks.length > 0) {
				this.store.append({
					actor_id: "runtime",
					type: "GOAL_COMPLETED",
					payload: { goal_id: goalId, summary: "All tasks completed" },
					caused_by: this.store.head,
				});
			}
			return;
		}

		const assignments = this.policy.selectTasks(readyTasks, goal, {
			allTasks,
			runningTasks,
			maxConcurrency: this.maxConcurrency,
		});

		for (const assignment of assignments) {
			this.store.append({
				actor_id: "runtime",
				type: "TASK_ASSIGNED",
				payload: {
					task_id: assignment.task_id,
					assigned_to: assignment.assigned_to,
				},
				caused_by: this.store.head,
			});
		}
	}
}
