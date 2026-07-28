import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerEngine, nextRunAt, nextNRuns, validateScheduleSpec, detectScheduleIntent } from "../../src/core/scheduler/index.js";
import type { ScheduledTask, SchedulerListener } from "../../src/core/scheduler/index.js";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
	originalHome = process.env.PIZZA_HOME;
	home = join(tmpdir(), `pizza-sched-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true });
	process.env.PIZZA_HOME = home;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.PIZZA_HOME;
	else process.env.PIZZA_HOME = originalHome;
	if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

describe("validateScheduleSpec", () => {
	it("accepts valid visual schedules", () => {
		expect(validateScheduleSpec({ mode: "daily", times: [{ hour: 9, minute: 0 }] })).toBeNull();
		expect(validateScheduleSpec({ mode: "weekdays", times: [{ hour: 9, minute: 0 }] })).toBeNull();
		expect(validateScheduleSpec({ mode: "every_n_minutes", everyN: { n: 15, unit: "minute" } })).toBeNull();
	});

	it("rejects empty time arrays", () => {
		expect(validateScheduleSpec({ mode: "daily", times: [] })).toMatch(/At least one time/);
	});

	it("rejects bad hours / minutes", () => {
		expect(validateScheduleSpec({ mode: "daily", times: [{ hour: 24, minute: 0 }] })).toMatch(/hour/);
		expect(validateScheduleSpec({ mode: "daily", times: [{ hour: 9, minute: 60 }] })).toMatch(/minute/);
	});

	it("rejects monthly with no days", () => {
		expect(validateScheduleSpec({ mode: "monthly", times: [{ hour: 9, minute: 0 }] })).toMatch(/at least one day/);
	});

	it("rejects invalid weekday", () => {
		expect(validateScheduleSpec({ mode: "weekly", times: [{ hour: 9, minute: 0 }], weekdays: [7] as Array<0 | 1 | 2 | 3 | 4 | 5 | 6> })).toMatch(/weekday/);
	});

	it("rejects bad intervals", () => {
		expect(validateScheduleSpec({ mode: "every_n_minutes", everyN: { n: 0, unit: "minute" } })).toMatch(/between/);
	});
});

describe("nextRunAt", () => {
	const base = new Date("2026-01-01T00:00:00Z").getTime();

	const t = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
		id: "t1",
		name: "test",
		prompt: "ping",
		scope: "main",
		schedule: { mode: "every_n_minutes", everyN: { n: 15, unit: "minute" } },
		enabled: true,
		createdAt: base,
		updatedAt: base,
		createdBy: "user",
		...overrides,
	});

	it("aligns every_n_minutes to boundaries", () => {
		const task = t({ schedule: { mode: "every_n_minutes", everyN: { n: 15, unit: "minute" } } });
		const next = nextRunAt(task, base + 1000)!;
		expect(next).toBe(base + 15 * 60_000);
	});

	it("aligns every_n_hours to the hour", () => {
		const task = t({ schedule: { mode: "every_n_hours", everyN: { n: 2, unit: "hour" } } });
		const next = nextRunAt(task, base + 1000)!;
		expect(next).toBe(base + 2 * 3600_000);
	});

	it("returns null when disabled", () => {
		const task = t({ enabled: false });
		expect(nextRunAt(task, base + 1000)).toBeNull();
	});

	it("returns null past endAt", () => {
		const task = t({ schedule: { mode: "every_n_minutes", everyN: { n: 15, unit: "minute" }, endAt: base } });
		// endAt at `from` is treated as expired; next fire would be at base
		// (== endAt), which is not strictly after endAt.
		expect(nextRunAt(task, base + 1)).toBeNull();
	});

	it("honors daily schedule", () => {
		const task = t({ schedule: { mode: "daily", times: [{ hour: 9, minute: 0 }] } });
		const next = nextRunAt(task, base + 1000)!;
		const d = new Date(next);
		expect(d.getHours()).toBe(9);
		expect(d.getMinutes()).toBe(0);
	});

	it("skips weekends for weekdays schedule", () => {
		// 2026-01-03 is a Saturday.
		const sat = new Date("2026-01-03T00:00:00").getTime();
		const task = t({ schedule: { mode: "weekdays", times: [{ hour: 9, minute: 0 }] } });
		const next = nextRunAt(task, sat)!;
		const d = new Date(next);
		expect([1, 2, 3, 4, 5]).toContain(d.getDay());
	});

	it("nextNRuns yields 3 valid times", () => {
		const task = t({ schedule: { mode: "every_n_minutes", everyN: { n: 15, unit: "minute" } } });
		const runs = nextNRuns(task, 3, base);
		expect(runs).toHaveLength(3);
		expect(runs[1]).toBe(runs[0]! + 15 * 60_000);
	});
});

describe("SchedulerEngine CRUD", () => {
	it("creates, lists, updates, and deletes tasks", () => {
		const events: SchedulerListener[] = [];
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({ eventId: "e1" }) },
		});
		engine.load();

		const r1 = engine.create({
			name: "Daily backup",
			prompt: "do backup",
			schedule: { mode: "daily", times: [{ hour: 2, minute: 0 }] },
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		const r2 = engine.create({
			name: "Hourly",
			prompt: "ping",
			schedule: { mode: "every_n_hours", everyN: { n: 1, unit: "hour" } },
		});
		expect(r2.ok).toBe(true);

		const list = engine.list();
		expect(list).toHaveLength(2);

		const upd = engine.update(r1.task.id, { name: "Daily backup v2" });
		expect(upd.ok).toBe(true);

		const del = engine.delete(r1.task.id);
		expect(del.ok).toBe(true);

		const after = engine.list();
		expect(after).toHaveLength(1);
		expect(after[0]!.name).toBe("Hourly");

		engine.dispose();
	});

	it("persists across reload", () => {
		const engine1 = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({}) },
		});
		engine1.load();
		engine1.create({
			name: "Persist me",
			prompt: "x",
			schedule: { mode: "every_n_minutes", everyN: { n: 30, unit: "minute" } },
		});
		engine1.dispose();

		const engine2 = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({}) },
		});
		engine2.load();
		const list = engine2.list();
		expect(list).toHaveLength(1);
		expect(list[0]!.name).toBe("Persist me");
		engine2.dispose();
	});

	it("rejects invalid schedules", () => {
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({}) },
		});
		engine.load();
		const r = engine.create({
			name: "bad",
			prompt: "x",
			schedule: { mode: "daily", times: [] },
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/At least one/);
		engine.dispose();
	});

	it("runNow invokes the dispatcher", async () => {
		const dispatch = vi.fn(async () => ({ eventId: "evt1" }));
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch },
		});
		engine.load();
		const r = engine.create({
			name: "manual",
			prompt: "hello",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
		});
		if (!r.ok) throw new Error("create failed");
		const run = await engine.runNow(r.task.id);
		expect(run.ok).toBe(true);
		// Wait briefly for the async dispatch to complete.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(dispatch).toHaveBeenCalledTimes(1);
		engine.dispose();
	});

	it("records runs in history", async () => {
		const engine = new SchedulerEngine({
			scope: "main",
			dispatcher: { dispatch: async () => ({ eventId: "evt1" }) },
		});
		engine.load();
		const r = engine.create({
			name: "track",
			prompt: "x",
			schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
		});
		if (!r.ok) throw new Error("create failed");
		await engine.runNow(r.task.id);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const history = engine.history(r.task.id);
		expect(history.length).toBeGreaterThan(0);
		expect(history[0]!.status).toBe("ok");
		engine.dispose();
	});
});

describe("detectScheduleIntent", () => {
	const NOW = new Date("2026-06-01T10:00:00Z"); // Monday

	it("detects 'X 分钟后'", () => {
		const i = detectScheduleIntent("15 分钟后提醒我喝水", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("every_n_minutes");
		expect(i!.prompt).toBe("我喝水");
	});

	it("detects '明天 HH:MM'", () => {
		const i = detectScheduleIntent("明天 8:00 提醒我开会", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("daily");
	});

	it("detects '每天 HH:MM'", () => {
		const i = detectScheduleIntent("每天 9:00 写日报", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("daily");
		expect(i!.prompt).toBe("写日报");
	});

	it("detects '工作日 HH:MM'", () => {
		const i = detectScheduleIntent("工作日 14:30 开站会", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("weekdays");
	});

	it("detects English 'every Monday'", () => {
		const i = detectScheduleIntent("every monday at 22:00 weekly review", NOW);
		expect(i).not.toBeNull();
		expect(i!.schedule.mode).toBe("weekly");
	});

	it("returns null when no schedule is detectable", () => {
		expect(detectScheduleIntent("你好吗", NOW)).toBeNull();
	});
});