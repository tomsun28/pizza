/**
 * Goal & Task Types
 *
 * Data model for long-running goals and their decomposed tasks.
 * Goals are top-level user objectives that may span multiple sessions.
 * Tasks are concrete work items within a goal.
 *
 * All state is derived from EventStore events — these types represent
 * the projected view of that state.
 */

// ============================================================================
// Goal Types
// ============================================================================

/** Goal status derived from event stream */
export type GoalStatus =
	| "created"
	| "classified"
	| "planned"
	| "running"
	| "paused"
	| "completed"
	| "cancelled";

/** Whether a goal is short-running (single session) or long-running (multi-session) */
export type GoalClassification = "short_running" | "long_running";

/** Goal phase — maps to sessions within the goal */
export type GoalPhase = "planning" | "implementation" | "testing" | "review" | "rework";

/** Projected goal state (derived from events, not stored directly) */
export interface GoalDescriptor {
	/** Unique goal identifier */
	goal_id: string;
	/** Workspace this goal belongs to */
	workspace_id: string;
	/** Current status */
	status: GoalStatus;
	/** Classification (if classified) */
	classification?: GoalClassification;
	/** Current phase */
	phase?: GoalPhase;
	/** Human-readable title */
	title: string;
	/** Detailed description or user request */
	description?: string;
	/** Event that created this goal */
	root_event_id: string;
	/** Task references (task_ids) */
	task_ids: string[];
	/** Active session ID (if running) */
	active_session_id?: string;
	/** Acceptance criteria (from planning) */
	acceptance_criteria?: string[];
	/** Timestamp of creation */
	created_at: number;
	/** Timestamp of last status change */
	updated_at: number;
}

// ============================================================================
// Task Types
// ============================================================================

/** Task status derived from event stream */
export type TaskStatus =
	| "created"
	| "assigned"
	| "started"
	| "in_progress"
	| "completed"
	| "failed"
	| "rework"
	| "accepted"
	| "cancelled";

/** Task priority */
export type TaskPriority = "critical" | "high" | "medium" | "low";

/** Agent role that can be assigned to a task */
export type AgentRole = "planner" | "worker" | "tester" | "reviewer" | "memory" | "skill";

/** Projected task state (derived from events) */
export interface TaskDescriptor {
	/** Unique task identifier */
	task_id: string;
	/** Parent goal ID */
	goal_id: string;
	/** Current status */
	status: TaskStatus;
	/** Human-readable title */
	title: string;
	/** Detailed specification */
	description?: string;
	/** Assigned agent role */
	assigned_to?: AgentRole;
	/** Task priority */
	priority: TaskPriority;
	/** Dependencies — task_ids that must complete before this one */
	depends_on: string[];
	/** Session ID where this task is being worked on */
	session_id?: string;
	/** Event that created this task */
	root_event_id: string;
	/** Acceptance criteria specific to this task */
	acceptance_criteria?: string[];
	/** Progress notes (from TASK_PROGRESS events) */
	progress_notes: string[];
	/** Rework reason (if status is "rework") */
	rework_reason?: string;
	/** Timestamp of creation */
	created_at: number;
	/** Timestamp of last status change */
	updated_at: number;
}

// ============================================================================
// Event Payloads
// ============================================================================

/** Payload for GOAL_CREATED event */
export interface GoalCreatedPayload {
	goal_id: string;
	title: string;
	description?: string;
	/** User message that triggered goal creation */
	source_message?: string;
}

/** Payload for GOAL_CLASSIFIED event */
export interface GoalClassifiedPayload {
	goal_id: string;
	classification: GoalClassification;
	reason?: string;
}

/** Payload for GOAL_PLANNED event */
export interface GoalPlannedPayload {
	goal_id: string;
	task_ids: string[];
	acceptance_criteria?: string[];
	plan_summary?: string;
}

/** Payload for GOAL_PAUSED / GOAL_RESUMED event */
export interface GoalLifecyclePayload {
	goal_id: string;
	reason?: string;
}

/** Payload for GOAL_COMPLETED event */
export interface GoalCompletedPayload {
	goal_id: string;
	summary?: string;
}

/** Payload for GOAL_CANCELLED event */
export interface GoalCancelledPayload {
	goal_id: string;
	reason?: string;
}

/** Payload for TASK_CREATED event */
export interface TaskCreatedPayload {
	task_id: string;
	goal_id: string;
	title: string;
	description?: string;
	priority: TaskPriority;
	depends_on?: string[];
	acceptance_criteria?: string[];
}

/** Payload for TASK_ASSIGNED event */
export interface TaskAssignedPayload {
	task_id: string;
	assigned_to: AgentRole;
	session_id?: string;
}

/** Payload for TASK_STARTED event */
export interface TaskStartedPayload {
	task_id: string;
	session_id: string;
}

/** Payload for TASK_PROGRESS event */
export interface TaskProgressPayload {
	task_id: string;
	note: string;
	/** Progress percentage 0-100 */
	percentage?: number;
}

/** Payload for TASK_COMPLETED event */
export interface TaskCompletedPayload {
	task_id: string;
	summary?: string;
}

/** Payload for TASK_FAILED event */
export interface TaskFailedPayload {
	task_id: string;
	error_message: string;
}

/** Payload for TASK_REWORK_REQUESTED event */
export interface TaskReworkPayload {
	task_id: string;
	reason: string;
	/** Event ID of the review that triggered rework */
	review_event_id?: string;
}

/** Payload for TASK_ACCEPTED event */
export interface TaskAcceptedPayload {
	task_id: string;
	/** Event ID of the acceptance review */
	review_event_id?: string;
}

/** Payload for TASK_CANCELLED event */
export interface TaskCancelledPayload {
	task_id: string;
	reason?: string;
}
