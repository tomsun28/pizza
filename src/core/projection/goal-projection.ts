/**
 * Goal Projection
 *
 * Derives goal and task state by scanning events from the EventStore.
 * A projection is a read-only view — it can be rebuilt at any time
 * by replaying the event log.
 */

import type { EventBase } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import type {
	GoalClassifiedPayload,
	GoalCompletedPayload,
	GoalCreatedPayload,
	GoalDescriptor,
	GoalLifecyclePayload,
	GoalPlannedPayload,
	GoalStatus,
	TaskAcceptedPayload,
	TaskAssignedPayload,
	TaskCancelledPayload,
	TaskCompletedPayload,
	TaskCreatedPayload,
	TaskDescriptor,
	TaskFailedPayload,
	TaskProgressPayload,
	TaskReworkPayload,
	TaskStartedPayload,
	TaskStatus,
} from "../goal/types.js";

// ============================================================================
// Goal Projection
// ============================================================================

/**
 * GoalProjection derives current goal and task state from the EventStore.
 *
 * Usage:
 *   const projection = new GoalProjection(store);
 *   projection.rebuild(); // scan all events
 *   const goals = projection.listGoals();
 *   const tasks = projection.getTasksForGoal(goalId);
 */
export class GoalProjection {
	private goals: Map<string, GoalDescriptor> = new Map();
	private tasks: Map<string, TaskDescriptor> = new Map();
	private unsubscribe?: () => void;

	constructor(private store: EventStore) {}

	/**
	 * Rebuild the projection from scratch by scanning all events.
	 */
	rebuild(): void {
		this.goals.clear();
		this.tasks.clear();

		const events = this.store.query({
			types: [
				"GOAL_CREATED",
				"GOAL_CLASSIFIED",
				"GOAL_PLANNED",
				"GOAL_PAUSED",
				"GOAL_RESUMED",
				"GOAL_COMPLETED",
				"GOAL_CANCELLED",
				"TASK_CREATED",
				"TASK_ASSIGNED",
				"TASK_STARTED",
				"TASK_PROGRESS",
				"TASK_COMPLETED",
				"TASK_FAILED",
				"TASK_REWORK_REQUESTED",
				"TASK_ACCEPTED",
				"TASK_CANCELLED",
			],
		});

		for (const event of events) {
			this._applyEvent(event);
		}
	}

	/**
	 * Start live-updating the projection by subscribing to new events.
	 */
	startLive(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = this.store.subscribe(
			(event) => this._applyEvent(event),
			{
				types: [
					"GOAL_CREATED",
					"GOAL_CLASSIFIED",
					"GOAL_PLANNED",
					"GOAL_PAUSED",
					"GOAL_RESUMED",
					"GOAL_COMPLETED",
					"GOAL_CANCELLED",
					"TASK_CREATED",
					"TASK_ASSIGNED",
					"TASK_STARTED",
					"TASK_PROGRESS",
					"TASK_COMPLETED",
					"TASK_FAILED",
					"TASK_REWORK_REQUESTED",
					"TASK_ACCEPTED",
					"TASK_CANCELLED",
				],
			},
		);
	}

	/**
	 * Stop live updates.
	 */
	stopLive(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	// =========================================================================
	// Queries
	// =========================================================================

	/** Get all goals */
	listGoals(): GoalDescriptor[] {
		return [...this.goals.values()];
	}

	/** Get active (non-terminal) goals */
	listActiveGoals(): GoalDescriptor[] {
		return this.listGoals().filter(
			(g) => g.status !== "completed" && g.status !== "cancelled",
		);
	}

	/** Get a specific goal */
	getGoal(goalId: string): GoalDescriptor | undefined {
		return this.goals.get(goalId);
	}

	/** Get all tasks for a goal */
	getTasksForGoal(goalId: string): TaskDescriptor[] {
		return [...this.tasks.values()].filter((t) => t.goal_id === goalId);
	}

	/** Get all tasks */
	listTasks(): TaskDescriptor[] {
		return [...this.tasks.values()];
	}

	/** Get a specific task */
	getTask(taskId: string): TaskDescriptor | undefined {
		return this.tasks.get(taskId);
	}

	/** Get tasks that are ready to start (all dependencies completed/accepted) */
	getReadyTasks(goalId: string): TaskDescriptor[] {
		const goalTasks = this.getTasksForGoal(goalId);
		return goalTasks.filter((task) => {
			if (task.status !== "created") return false;
			return task.depends_on.every((depId) => {
				const dep = this.tasks.get(depId);
				return dep && (dep.status === "completed" || dep.status === "accepted");
			});
		});
	}

	/** Get tasks blocked by dependencies */
	getBlockedTasks(goalId: string): TaskDescriptor[] {
		const goalTasks = this.getTasksForGoal(goalId);
		return goalTasks.filter((task) => {
			if (task.status !== "created") return false;
			return task.depends_on.some((depId) => {
				const dep = this.tasks.get(depId);
				return !dep || (dep.status !== "completed" && dep.status !== "accepted");
			});
		});
	}

	// =========================================================================
	// Event Application
	// =========================================================================

	private _applyEvent(event: EventBase): void {
		switch (event.type) {
			case "GOAL_CREATED":
				this._onGoalCreated(event);
				break;
			case "GOAL_CLASSIFIED":
				this._onGoalClassified(event);
				break;
			case "GOAL_PLANNED":
				this._onGoalPlanned(event);
				break;
			case "GOAL_PAUSED":
				this._onGoalStatusChange(event, "paused");
				break;
			case "GOAL_RESUMED":
				this._onGoalStatusChange(event, "running");
				break;
			case "GOAL_COMPLETED":
				this._onGoalStatusChange(event, "completed");
				break;
			case "GOAL_CANCELLED":
				this._onGoalStatusChange(event, "cancelled");
				break;
			case "TASK_CREATED":
				this._onTaskCreated(event);
				break;
			case "TASK_ASSIGNED":
				this._onTaskAssigned(event);
				break;
			case "TASK_STARTED":
				this._onTaskStarted(event);
				break;
			case "TASK_PROGRESS":
				this._onTaskProgress(event);
				break;
			case "TASK_COMPLETED":
				this._onTaskCompleted(event);
				break;
			case "TASK_FAILED":
				this._onTaskFailed(event);
				break;
			case "TASK_REWORK_REQUESTED":
				this._onTaskRework(event);
				break;
			case "TASK_ACCEPTED":
				this._onTaskStatusChange(event, "accepted");
				break;
			case "TASK_CANCELLED":
				this._onTaskCancelled(event);
				break;
		}
	}

	private _onGoalCreated(event: EventBase): void {
		const payload = event.payload as GoalCreatedPayload;
		this.goals.set(payload.goal_id, {
			goal_id: payload.goal_id,
			workspace_id: event.workspace_id,
			status: "created",
			title: payload.title,
			description: payload.description,
			root_event_id: event.event_id,
			task_ids: [],
			created_at: event.timestamp,
			updated_at: event.timestamp,
		});
	}

	private _onGoalClassified(event: EventBase): void {
		const payload = event.payload as GoalClassifiedPayload;
		const goal = this.goals.get(payload.goal_id);
		if (!goal) return;
		goal.status = "classified";
		goal.classification = payload.classification;
		goal.updated_at = event.timestamp;
	}

	private _onGoalPlanned(event: EventBase): void {
		const payload = event.payload as GoalPlannedPayload;
		const goal = this.goals.get(payload.goal_id);
		if (!goal) return;
		goal.status = "planned";
		goal.task_ids = payload.task_ids;
		goal.acceptance_criteria = payload.acceptance_criteria;
		goal.updated_at = event.timestamp;
	}

	private _onGoalStatusChange(event: EventBase, status: GoalStatus): void {
		const payload = event.payload as GoalLifecyclePayload;
		const goal = this.goals.get(payload.goal_id);
		if (!goal) return;
		goal.status = status;
		goal.updated_at = event.timestamp;
	}

	private _onTaskCreated(event: EventBase): void {
		const payload = event.payload as TaskCreatedPayload;
		this.tasks.set(payload.task_id, {
			task_id: payload.task_id,
			goal_id: payload.goal_id,
			status: "created",
			title: payload.title,
			description: payload.description,
			priority: payload.priority,
			depends_on: payload.depends_on ?? [],
			root_event_id: event.event_id,
			acceptance_criteria: payload.acceptance_criteria,
			progress_notes: [],
			created_at: event.timestamp,
			updated_at: event.timestamp,
		});

		// Also add to goal's task_ids if not already there
		const goal = this.goals.get(payload.goal_id);
		if (goal && !goal.task_ids.includes(payload.task_id)) {
			goal.task_ids.push(payload.task_id);
		}
	}

	private _onTaskAssigned(event: EventBase): void {
		const payload = event.payload as TaskAssignedPayload;
		const task = this.tasks.get(payload.task_id);
		if (!task) return;
		task.status = "assigned";
		task.assigned_to = payload.assigned_to;
		if (payload.session_id) task.session_id = payload.session_id;
		task.updated_at = event.timestamp;
	}

	private _onTaskStarted(event: EventBase): void {
		const payload = event.payload as TaskStartedPayload;
		const task = this.tasks.get(payload.task_id);
		if (!task) return;
		task.status = "started";
		task.session_id = payload.session_id;
		task.updated_at = event.timestamp;

		// Mark goal as running if not already
		const goal = this.goals.get(task.goal_id);
		if (goal && (goal.status === "planned" || goal.status === "classified")) {
			goal.status = "running";
			goal.active_session_id = payload.session_id;
			goal.updated_at = event.timestamp;
		}
	}

	private _onTaskProgress(event: EventBase): void {
		const payload = event.payload as TaskProgressPayload;
		const task = this.tasks.get(payload.task_id);
		if (!task) return;
		task.status = "in_progress";
		task.progress_notes.push(payload.note);
		task.updated_at = event.timestamp;
	}

	private _onTaskFailed(event: EventBase): void {
		const payload = event.payload as TaskFailedPayload;
		const task = this.tasks.get(payload.task_id);
		if (!task) return;
		task.status = "failed";
		task.failure_message = payload.error_message;
		task.updated_at = event.timestamp;
	}

	private _onTaskRework(event: EventBase): void {
		const payload = event.payload as TaskReworkPayload;
		const task = this.tasks.get(payload.task_id);
		if (!task) return;
		task.status = "rework";
		task.rework_reason = payload.reason;
		task.updated_at = event.timestamp;
	}

	private _onTaskCompleted(event: EventBase): void {
		const payload = event.payload as TaskCompletedPayload;
		const task = this.tasks.get(payload.task_id);
		if (!task) return;
		task.status = "completed";
		task.summary = payload.summary ?? task.summary;
		task.updated_at = event.timestamp;
	}

	private _onTaskCancelled(event: EventBase): void {
		const payload = event.payload as TaskCancelledPayload;
		const task = this.tasks.get(payload.task_id);
		if (!task) return;
		task.status = "cancelled";
		task.cancel_reason = payload.reason;
		task.updated_at = event.timestamp;
	}

	private _onTaskStatusChange(event: EventBase, status: TaskStatus): void {
		const payload = event.payload as TaskAcceptedPayload;
		const task = this.tasks.get(payload.task_id);
		if (!task) return;
		task.status = status;
		task.updated_at = event.timestamp;
	}
}
