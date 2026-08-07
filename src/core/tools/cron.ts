/**
 * `_cron` built-in CLI command — manage scheduled/cron jobs.
 *
 * Routed internally by the `cli` tool (alongside read/write/edit/session_split/
 * history_tree/tell/skill), wired up only in RPC/desktop/web mode
 * where a SchedulerEngine is running. TUI mode has no scheduler, so the tool
 * is not registered there.
 *
 * Six actions:
 *  - list:    show all tasks (id, name, schedule, enabled, next fire).
 *  - create:  schedule a recurring prompt (--schedule shorthand or --cron-expr,
 *             plus --prompt; optional --name, --once, --new-session).
 *  - pause:   disable a task (enabled = false).
 *  - resume:  re-enable a task (enabled = true).
 *  - delete:  remove a task.
 *  - run:     fire a task immediately, regardless of its schedule.
 *
 * Dependency injection: the SchedulerEngine is created AFTER the tool
 * (in rpc-mode.ts), so the tool receives a lazy `getEngine()` getter that
 * resolves at execute time. When the engine is not yet ready (or has been
 * disposed), the tool degrades gracefully instead of throwing.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ScheduledTaskSummary } from "@pizza/protocol";
import type { SchedulerEngine } from "../scheduler/engine.js";
import { parseScheduleShorthand } from "../scheduler/shorthand.js";
import { defineTool, type ToolDefinition } from "../extensions/types.js";

/** Supported `_cron` subcommands. */
export const CRON_ACTIONS = ["list", "create", "pause", "resume", "delete", "run"] as const;
export type CronAction = (typeof CRON_ACTIONS)[number];

/**
 * Dependencies injected at tool construction time.
 *
 * `getEngine` is a lazy getter: the SchedulerEngine is instantiated after the
 * tool (in rpc-mode.ts), so we cannot capture it directly. The getter reads a
 * mutable slot that rpc-mode fills in once the engine is ready.
 */
export interface CronToolOptions {
	/** Resolve the engine at execute time. Returns undefined when not running. */
	getEngine: () => SchedulerEngine | undefined;
	/** Scope this sidecar owns ("main" for the persistent agent, else "workspace"). */
	scope: "main" | "workspace";
	/** Resolve the current active session id (for the default pinned target). */
	getActiveSessionId?: () => string | undefined;
}

const cronSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("create"),
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("delete"),
			Type.Literal("run"),
		],
		{
			description:
				"list shows all tasks; create schedules a recurring prompt; " +
				"pause/resume toggle a task on/off; delete removes it; run fires it now.",
		},
	),
	taskId: Type.Optional(
		Type.String({
			description: "Task id (st_xxx). Required for pause/resume/delete/run.",
		}),
	),
	schedule: Type.Optional(
		Type.String({
			description:
				'Shorthand interval for create, e.g. "30m", "every 2h", or a cron expr "0 9 * * 1-5". Required for create unless cronExpr is set.',
		}),
	),
	cronExpr: Type.Optional(
		Type.String({ description: "Explicit 5-field cron expression (alternative to schedule)." }),
	),
	prompt: Type.Optional(
		Type.String({
			description:
				"Task instruction dispatched on each fire. Required for create. " +
				"Use --content or a <<EOF heredoc if it contains spaces/newlines.",
		}),
	),
	name: Type.Optional(Type.String({ description: "Optional task name (defaults to a prompt prefix)." })),
	once: Type.Optional(
		Type.Boolean({ description: "Run exactly once then auto-disable (sets endAt to the first fire)." }),
	),
	newSession: Type.Optional(
		Type.Boolean({
			description:
				"Dispatch each fire into a fresh session instead of the current one. Default: pinned to the current session.",
		}),
	),
});

export type CronToolInput = Static<typeof cronSchema>;

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

function errResult(message: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return textResult(message);
}

function fmtTime(ms: number | null | undefined): string {
	if (ms == null) return "—";
	try {
		return new Date(ms).toLocaleString();
	} catch {
		return String(ms);
	}
}

function fmtSchedule(t: ScheduledTaskSummary): string {
	const s = t.schedule;
	switch (s.mode) {
		case "every_n_minutes":
			return `every ${s.everyN?.n ?? "?"} min`;
		case "every_n_hours":
			return `every ${s.everyN?.n ?? "?"} h`;
		case "cron":
			return `cron ${s.cron?.expression ?? "?"}`;
		case "daily":
		case "weekdays":
		case "weekly":
		case "monthly":
			return s.mode;
		default:
			return s.mode;
	}
}

function formatList(tasks: ScheduledTaskSummary[]): string {
	if (tasks.length === 0) return "No scheduled tasks. Use `_cron create` to add one.";
	const rows = tasks.map((t) => {
		const status = t.enabled ? "on " : "off";
		const next = t.nextRunAt == null ? "—" : fmtTime(t.nextRunAt);
		const last = t.lastRunStatus ? ` [last: ${t.lastRunStatus}]` : "";
		return `- ${t.id}  "${t.name}"  ${fmtSchedule(t)}  ${status}  next: ${next}${last}`;
	});
	return `${tasks.length} task(s):\n${rows.join("\n")}`;
}

export function createCronToolDefinition(
	options: CronToolOptions,
): ToolDefinition<typeof cronSchema, undefined> {
	return defineTool({
		name: "cron",
		label: "cron",
		description:
			"Manage scheduled/cron jobs. list shows all tasks; create schedules a recurring prompt; " +
			"pause/resume toggle a task; delete removes it; run fires it immediately. " +
			"Schedules fire by dispatching the prompt to the agent in its target session.",
		parameters: cronSchema,
		renderShell: "self",
		async execute(_toolCallId, params) {
			const engine = options.getEngine();
			if (!engine) {
				return errResult(
					"_cron is not available: the scheduler is not running " +
						"(this happens in TUI mode or before the engine is initialized).",
				);
			}

			switch (params.action) {
				case "list": {
					return textResult(formatList(engine.list()));
				}

				case "create": {
					if (!params.prompt) return errResult("_cron create: --prompt is required.");
					const expr = params.cronExpr ?? params.schedule;
					if (!expr) {
						return errResult(
							"_cron create: --schedule (shorthand) or --cron-expr is required. " +
								'Examples: "30m", "every 2h", "0 9 * * 1-5".',
						);
					}
					const parsed = parseScheduleShorthand(expr);
					if (!parsed.ok) return errResult(`_cron create: ${parsed.error}`);

					const sessionTarget = params.newSession
						? { kind: "new" as const, purpose: params.name ?? "scheduled task" }
						: {
								kind: "pinned" as const,
								sessionId: options.getActiveSessionId?.(),
							};

					const created = engine.create({
						name: params.name ?? "",
						prompt: params.prompt,
						schedule: parsed.spec,
						createdBy: "intent",
						sourceText: expr,
						sessionTarget,
					});
					if (!created.ok) return errResult(`_cron create: ${created.error}`);

					// --once: clamp endAt to just past the first fire so the engine
					// disables the task after it runs once.
					if (params.once) {
						const next = created.task.nextRunAt;
						if (next != null) {
							const onceUpdate = engine.update(created.task.id, { endAt: next + 1 });
							if (!onceUpdate.ok) {
								return errResult(
									`Task created as ${created.task.id} but --once could not be applied: ${onceUpdate.error}`,
								);
							}
							return textResult(
								`Created one-shot task ${onceUpdate.task.id} "${onceUpdate.task.name}". ` +
									`Fires once at ${fmtTime(onceUpdate.task.nextRunAt)}, then auto-disables.`,
							);
						}
						return textResult(
							`Created task ${created.task.id} "${created.task.name}", but --once could not be applied ` +
								"(no next fire time). It will run on its normal schedule.",
						);
					}

					return textResult(
						`Created task ${created.task.id} "${created.task.name}" (${fmtSchedule(created.task)}). ` +
							`Next fire: ${fmtTime(created.task.nextRunAt)}.`,
					);
				}

				case "pause":
				case "resume": {
					if (!params.taskId) return errResult(`_cron ${params.action}: taskId is required.`);
					const enabled = params.action === "resume";
					const r = engine.update(params.taskId, { enabled });
					if (!r.ok) return errResult(`_cron ${params.action}: ${r.error}`);
					return textResult(
						`${enabled ? "Resumed" : "Paused"} task ${r.task.id} "${r.task.name}". ` +
							`Next fire: ${fmtTime(r.task.nextRunAt)}.`,
					);
				}

				case "delete": {
					if (!params.taskId) return errResult("_cron delete: taskId is required.");
					const r = engine.delete(params.taskId);
					if (!r.ok) return errResult(`_cron delete: ${r.error}`);
					return textResult(`Deleted task ${r.id}.`);
				}

				case "run": {
					if (!params.taskId) return errResult("_cron run: taskId is required.");
					// runNow is fire-and-forget: it resolves once the task is queued,
					// not when the agent turn completes.
					const r = await engine.runNow(params.taskId);
					if (!r.ok) return errResult(`_cron run: ${r.error}`);
					return textResult(`Fired task ${r.taskId} at ${fmtTime(r.at)} (running in the background).`);
				}

				default:
					return errResult(`_cron: unknown action. Valid actions: ${CRON_ACTIONS.join(", ")}`);
			}
		},
	});
}
