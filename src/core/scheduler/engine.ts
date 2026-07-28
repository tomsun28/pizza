/**
 * Scheduler engine — computes nextRunAt for any ScheduleSpec, owns the
 * in-memory task cache, and runs a setTimeout-based dispatcher per scope.
 *
 * Architecture:
 *   - One SchedulerEngine instance per scope (main, each workspace).
 *   - On start: load tasks.json, for each enabled task compute nextRunAt,
 *     schedule a setTimeout for the soonest fire, and re-schedule on tick.
 *   - On tick: lock the task (avoid re-entry), emit SCHEDULED_TASK_FIRED,
 *     dispatch to the facade (facade.prompt), wait for completion, persist
 *     the run record, and (if recurring) compute nextRunAt and schedule
 *     again. If endAt has passed, mark the task disabled.
 *   - API: load / reload / create / update / delete / runNow — all mutate
 *     in-memory cache and atomically rewrite tasks.json.
 *
 * Concurrency model:
 *   - Single Node.js process ⇒ setTimeout + JS event loop, so there's no
 *     thread-safety hazard per se. But we guard each task with a `running`
 *     flag so an overlap (e.g. clock skew, manual run-now during scheduled
 *     fire) can't double-dispatch.
 *
 * Event emission:
 *   - All events are written to stdout by the RPC layer (engine doesn't
 *     know about stdout). The engine returns an event emitter-like object
 *     that callers (rpc-mode.ts) can subscribe to.
 */

import { EventEmitter } from "node:events";
import type { ScheduledTask, ScheduledTaskSummary, ScheduledTaskRun } from "@pizza/protocol";
import { cronNextRun } from "./cron.js";
import { defaultTaskName, generateTaskId, validateScheduleSpec } from "./types.js";
import { appendRun, readRuns, readTasks, writeTasks } from "./store.js";

// --- nextRunAt: the heart of the engine -------------------------------------

/**
 * Compute the next fire time for a task at or after `from` (epoch ms).
 * Returns null if the schedule can no longer fire (endAt passed, disabled,
 * or no future match within reason).
 */
export function nextRunAt(task: ScheduledTask, from: number = Date.now()): number | null {
	if (!task.enabled) return null;
	const endAt = task.schedule.endAt;
	if (typeof endAt === "number" && endAt <= from) return null;

	const startAt = task.schedule.startAt ?? task.createdAt;
	const base = Math.max(from, startAt);

	const spec = task.schedule;
	switch (spec.mode) {
		case "every_n_minutes": {
			if (!spec.everyN) return null;
			const n = Math.max(1, spec.everyN.n);
			// Align to N-minute boundaries in UTC.
			const intervalMs = n * 60_000;
			const next = Math.ceil(base / intervalMs) * intervalMs;
			if (typeof endAt === "number" && next > endAt) return null;
			return next;
		}
		case "every_n_hours": {
			if (!spec.everyN) return null;
			const n = Math.max(1, spec.everyN.n);
			const intervalMs = n * 3600_000;
			const next = Math.ceil(base / intervalMs) * intervalMs;
			if (typeof endAt === "number" && next > endAt) return null;
			return next;
		}
		case "daily":
		case "weekdays":
		case "weekly":
		case "monthly": {
			const times = (spec.times ?? []).slice().sort((a, b) => a.hour - b.hour || a.minute - b.minute);
			if (times.length === 0) return null;
			return nextForDateAnchoredSchedule(spec.mode, times, spec.weekdays ?? null, spec.daysOfMonth ?? null, base, endAt);
		}
		case "cron": {
			if (!spec.cron?.expression) return null;
			const next = cronNextRun(spec.cron.expression, base);
			if (next === null) return null;
			if (typeof endAt === "number" && next > endAt) return null;
			return next;
		}
		default:
			return null;
	}
}

function nextForDateAnchoredSchedule(
	mode: "daily" | "weekdays" | "weekly" | "monthly",
	times: Array<{ hour: number; minute: number }>,
	weekdays: number[] | null,
	daysOfMonth: number[] | null,
	base: number,
	endAt: number | undefined,
): number | null {
	// We scan forward at most 366 days.
	const horizon = base + 366 * 24 * 3600_000;
	const baseDate = new Date(base);

	// Start scanning from the beginning of the base minute.
	let candidate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), baseDate.getHours(), baseDate.getMinutes(), 0, 0).getTime();
	// Always look strictly AFTER `base`, so bump by 1 minute if equal.
	if (candidate <= base) candidate += 60_000;

	while (candidate <= horizon) {
		if (typeof endAt === "number" && candidate > endAt) return null;
		const d = new Date(candidate);
		if (matchesDateMode(mode, d, weekdays, daysOfMonth)) {
			for (const t of times) {
				if (t.hour === d.getHours() && t.minute === d.getMinutes()) {
					return candidate;
				}
			}
		}
		candidate += 60_000; // 1-minute step is fine: max 366*24*60 = ~530k iterations
	}
	return null;
}

function matchesDateMode(
	mode: "daily" | "weekdays" | "weekly" | "monthly",
	d: Date,
	weekdays: number[] | null,
	daysOfMonth: number[] | null,
): boolean {
	const day = d.getDay(); // 0=Sun..6=Sat
	const date = d.getDate();
	switch (mode) {
		case "daily":
			return true;
		case "weekdays":
			return day >= 1 && day <= 5;
		case "weekly":
			return weekdays?.includes(day) ?? false;
		case "monthly":
			return daysOfMonth?.includes(date) ?? false;
	}
}

/**
 * Compute the next N fire times for preview / display purposes. Stops early
 * if endAt is set. Pure function — does not touch task state.
 */
export function nextNRuns(task: ScheduledTask, n: number, from: number = Date.now()): number[] {
	const out: number[] = [];
	let cursor = from;
	for (let i = 0; i < n; i++) {
		const next = nextRunAt({ ...task, lastRunAt: cursor }, cursor);
		if (next === null) break;
		out.push(next);
		cursor = next + 60_000;
	}
	return out;
}

// --- SchedulerEngine -------------------------------------------------------

export interface SchedulerEngineEvents {
	"task.fired": (taskId: string, eventId: string | undefined) => void;
	"task.completed": (run: ScheduledTaskRun) => void;
}

export type SchedulerListener = (event: { type: keyof SchedulerEngineEvents; payload: unknown }) => void;

export interface Dispatcher {
	/**
	 * Dispatch the task's prompt to the agent. Implementations typically
	 * call `facade.prompt(prompt)`. The returned promise resolves when the
	 * turn is complete (or rejects on error). The eventId of the produced
	 * USER_MESSAGE event (if any) should be returned via the second arg.
	 */
	dispatch(task: ScheduledTask): Promise<{ eventId?: string; error?: string }>;
}

export interface SchedulerEngineOptions {
	scope: "main" | "workspace";
	workspaceId?: string;
	dispatcher: Dispatcher;
	listener?: SchedulerListener;
	/** For tests: deterministic clock. Defaults to Date.now. */
	now?: () => number;
}

export class SchedulerEngine {
	private readonly scope: "main" | "workspace";
	private readonly workspaceId: string | undefined;
	private readonly dispatcher: Dispatcher;
	private readonly listener: SchedulerListener | undefined;
	private readonly now: () => number;
	private tasks: Map<string, ScheduledTask> = new Map();
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private running: Set<string> = new Set();
	private emitter = new EventEmitter();
	private stopped = false;
	/** Tracks whether the engine has been disposed. */
	private disposed = false;

	constructor(opts: SchedulerEngineOptions) {
		this.scope = opts.scope;
		this.workspaceId = opts.workspaceId;
		this.dispatcher = opts.dispatcher;
		this.listener = opts.listener;
		this.now = opts.now ?? Date.now;
	}

	// --- lifecycle ---

	/** Load tasks from disk and schedule all enabled ones. */
	load(): void {
		if (this.disposed) return;
		const stored = readTasks(this.scope, this.workspaceId);
		this.tasks.clear();
		for (const t of stored) this.tasks.set(t.id, t);
		this.scheduleAll();
	}

	/** Stop all timers; safe to call multiple times. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopped = true;
		for (const [, t] of this.timers) clearTimeout(t);
		this.timers.clear();
		this.emitter.removeAllListeners();
	}

	/** Force re-read from disk (e.g. after an external edit). */
	reload(): number {
		this.load();
		return this.tasks.size;
	}

	// --- task CRUD ---

	list(): ScheduledTaskSummary[] {
		const now = this.now();
		return Array.from(this.tasks.values())
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((t) => this.summarize(t, now));
	}

	get(id: string): ScheduledTaskSummary | null {
		const t = this.tasks.get(id);
		if (!t) return null;
		return this.summarize(t, this.now());
	}

	create(input: {
		name: string;
		prompt: string;
		schedule: ScheduledTask["schedule"];
		enabled?: boolean;
		createdBy?: "user" | "intent";
		sourceText?: string;
		startAt?: number;
		endAt?: number;
	}): { ok: true; task: ScheduledTaskSummary } | { ok: false; error: string } {
		const validation = validateScheduleSpec(input.schedule);
		if (validation) return { ok: false, error: validation };

		const now = this.now();
		const task: ScheduledTask = {
			id: generateTaskId(),
			name: input.name.trim() || defaultTaskName(input.prompt),
			prompt: input.prompt,
			scope: this.scope,
			workspaceId: this.workspaceId,
			schedule: input.schedule,
			enabled: input.enabled ?? true,
			createdAt: now,
			updatedAt: now,
			createdBy: input.createdBy ?? "user",
			sourceText: input.sourceText,
			runCount: 0,
		};
		// Persist schedule.endAt / startAt into the embedded schedule so the
		// nextRunAt helper reads a consistent shape.
		task.schedule = {
			...task.schedule,
			startAt: input.startAt,
			endAt: input.endAt,
		};

		this.tasks.set(task.id, task);
		this.persist();
		this.scheduleOne(task);
		return { ok: true, task: this.summarize(task, now) };
	}

	update(
		id: string,
		patch: {
			name?: string;
			prompt?: string;
			schedule?: ScheduledTask["schedule"];
			enabled?: boolean;
			startAt?: number | null;
			endAt?: number | null;
		},
	): { ok: true; task: ScheduledTaskSummary } | { ok: false; error: string } {
		const existing = this.tasks.get(id);
		if (!existing) return { ok: false, error: `Task not found: ${id}` };

		if (patch.schedule) {
			const validation = validateScheduleSpec(patch.schedule);
			if (validation) return { ok: false, error: validation };
		}

		const next: ScheduledTask = {
			...existing,
			...patch,
			schedule: patch.schedule ?? existing.schedule,
			updatedAt: this.now(),
		};
		if (patch.startAt === null) delete next.schedule.startAt;
		else if (typeof patch.startAt === "number") next.schedule.startAt = patch.startAt;
		if (patch.endAt === null) delete next.schedule.endAt;
		else if (typeof patch.endAt === "number") next.schedule.endAt = patch.endAt;

		this.tasks.set(id, next);
		this.persist();
		// Cancel and reschedule so changes take effect immediately.
		this.cancelTimer(id);
		if (next.enabled) this.scheduleOne(next);
		return { ok: true, task: this.summarize(next, this.now()) };
	}

	delete(id: string): { ok: true; id: string } | { ok: false; error: string } {
		if (!this.tasks.has(id)) return { ok: false, error: `Task not found: ${id}` };
		this.cancelTimer(id);
		this.tasks.delete(id);
		this.persist();
		return { ok: true, id };
	}

	/** Fire a task immediately, regardless of its schedule. */
	async runNow(id: string): Promise<{ ok: true; taskId: string; at: number } | { ok: false; error: string }> {
		const task = this.tasks.get(id);
		if (!task) return { ok: false, error: `Task not found: ${id}` };
		if (this.running.has(id)) return { ok: false, error: `Task ${id} is already running` };
		const at = this.now();
		// Fire-and-forget — actual completion is signaled via events.
		void this.fireTask(task, at, /*manual*/ true);
		return { ok: true, taskId: id, at };
	}

	history(id: string, limit = 50): ScheduledTaskRun[] {
		return readRuns(this.scope, this.workspaceId, id, limit);
	}

	// --- internals ---

	private summarize(task: ScheduledTask, now: number): ScheduledTaskSummary {
		return {
			...task,
			nextRunAt: task.enabled ? nextRunAt(task, now) : null,
		};
	}

	private persist(): void {
		const list = Array.from(this.tasks.values());
		writeTasks(this.scope, this.workspaceId, list);
	}

	private cancelTimer(id: string): void {
		const t = this.timers.get(id);
		if (t) {
			clearTimeout(t);
			this.timers.delete(id);
		}
	}

	private scheduleAll(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		for (const t of this.tasks.values()) this.scheduleOne(t);
	}

	private scheduleOne(task: ScheduledTask): void {
		if (!task.enabled || this.disposed) return;
		const next = nextRunAt(task, this.now());
		if (next === null) return;
		const delay = Math.max(0, next - this.now());
		const timer = setTimeout(() => {
			this.timers.delete(task.id);
			void this.fireTask(task, next, /*manual*/ false);
		}, delay);
		// Don't keep the event loop alive solely for a scheduled fire.
		if (typeof (timer as { unref?: () => void }).unref === "function") {
			(timer as { unref: () => void }).unref();
		}
		this.timers.set(task.id, timer);
	}

	private async fireTask(task: ScheduledTask, at: number, manual: boolean): Promise<void> {
		if (this.running.has(task.id) || this.disposed) return;
		this.running.add(task.id);
		const startedAt = this.now();
		const current = this.tasks.get(task.id) ?? task;
		let eventId: string | undefined;
		let status: "ok" | "failed" | "skipped" = "ok";
		let reason: string | undefined;
		try {
			// Emit the FIRED event BEFORE dispatching so the UI can immediately
			// show the "⏰ 已触发" notice. Completion is signaled separately.
			this.emit({ type: "task.fired", payload: { taskId: task.id, at } });
			const result = await this.dispatcher.dispatch(current);
			eventId = result.eventId;
			if (result.error) {
				status = "failed";
				reason = result.error;
			}
		} catch (e) {
			status = "failed";
			reason = e instanceof Error ? e.message : String(e);
		} finally {
			this.running.delete(task.id);
			const finishedAt = this.now();
			const run: ScheduledTaskRun = {
				taskId: task.id,
				at,
				status,
				eventId,
				reason,
			};
			appendRun(this.scope, this.workspaceId, run);

			// Update the task's lastRun fields.
			const updated: ScheduledTask = {
				...current,
				lastRunAt: at,
				lastRunStatus: status,
				lastRunEventId: eventId,
				runCount: (current.runCount ?? 0) + 1,
				updatedAt: finishedAt,
			};
			this.tasks.set(task.id, updated);
			this.persist();

			this.emit({ type: "task.completed", payload: run });

			// Re-arm if the task is still enabled and recurring.
			if (updated.enabled && !this.disposed) {
				const stillValid = !updated.schedule.endAt || updated.schedule.endAt > finishedAt;
				if (stillValid) this.scheduleOne(updated);
				else if (manual === false) {
					// Auto-disable after endAt so the list view reflects reality.
					this.tasks.set(task.id, { ...updated, enabled: false });
					this.persist();
				}
			}

			// Sanity: startedAt should be ~ at. If we drifted, log a warning.
			if (Math.abs(startedAt - at) > 5_000) {
				console.warn(
					`[scheduler] fire drift for ${task.id}: expected at ${at}, started at ${startedAt}`,
				);
			}
		}
	}

	private emit(event: { type: keyof SchedulerEngineEvents; payload: unknown }): void {
		this.listener?.(event);
		this.emitter.emit(event.type, ...(Array.isArray(event.payload) ? event.payload : [event.payload]));
	}

	/** Subscribe to engine events (returns an unsubscribe function). */
	subscribe(listener: SchedulerListener): () => void {
		const wrapped = (e: { type: keyof SchedulerEngineEvents; payload: unknown }) => listener(e);
		this.emitter.on("task.fired", wrapped as never);
		this.emitter.on("task.completed", wrapped as never);
		return () => {
			this.emitter.off("task.fired", wrapped as never);
			this.emitter.off("task.completed", wrapped as never);
		};
	}
}