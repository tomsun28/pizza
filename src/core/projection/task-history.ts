import type { EventType } from "../event-store/types.js";
import type { TaskDescriptor, TaskStatus } from "../goal/types.js";
import type { GoalProjection } from "./goal-projection.js";

export const TASK_HISTORY_EVENT_TYPES: EventType[] = [
	"TASK_CREATED",
	"TASK_ASSIGNED",
	"TASK_STARTED",
	"TASK_PROGRESS",
	"TASK_COMPLETED",
	"TASK_FAILED",
	"TASK_REWORK_REQUESTED",
	"TASK_ACCEPTED",
	"TASK_CANCELLED",
];

export interface TaskHistoryItem {
	task_id: string;
	status: TaskStatus;
	title: string;
	summary: string;
	updated_at: number;
}

export function buildRecentTaskHistory(
	projection: Pick<GoalProjection, "listTasks">,
	limit = 3,
): TaskHistoryItem[] {
	return projection
		.listTasks()
		.sort((a, b) => b.updated_at - a.updated_at)
		.slice(0, Math.max(0, limit))
		.map((task) => ({
			task_id: task.task_id,
			status: task.status,
			title: cleanText(task.title),
			summary: summarizeTask(task),
			updated_at: task.updated_at,
		}));
}

export function summarizeTask(task: TaskDescriptor): string {
	const title = cleanText(task.title);
	const latestProgress = cleanText(task.progress_notes.at(-1));
	const summary = cleanText(task.summary);
	const failure = cleanText(task.failure_message);
	const rework = cleanText(task.rework_reason);
	const cancelled = cleanText(task.cancel_reason);
	const description = cleanText(task.description);

	switch (task.status) {
		case "accepted":
			return summary || title;
		case "completed":
			return summary || `Completed ${lowercaseFirst(title)}`;
		case "failed":
			return failure ? `Failed: ${failure}` : `Failed ${lowercaseFirst(title)}`;
		case "rework":
			return rework ? `Rework: ${rework}` : `Rework needed for ${lowercaseFirst(title)}`;
		case "cancelled":
			return cancelled ? `Cancelled: ${cancelled}` : `Cancelled ${lowercaseFirst(title)}`;
		case "in_progress":
			return latestProgress || `Working on ${lowercaseFirst(title)}`;
		case "started":
			return `Started ${lowercaseFirst(title)}`;
		case "assigned":
			return task.assigned_to ? `Assigned to ${task.assigned_to}: ${title}` : `Assigned ${lowercaseFirst(title)}`;
		case "created":
			return description || title;
	}
}

function cleanText(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function lowercaseFirst(value: string): string {
	if (!value) return "task";
	return value.charAt(0).toLowerCase() + value.slice(1);
}
