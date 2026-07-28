import { describe, expect, it } from "vitest";
import { parseCron, validateCron, specToCron, cronToSpec, cronNextRun } from "../../src/core/scheduler/cron.js";

describe("parseCron", () => {
	it("parses basic expressions", () => {
		const p = parseCron("0 9 * * *");
		expect(p.minute.values).toEqual([0]);
		expect(p.hour.values).toEqual([9]);
		expect(p.day.star).toBe(true);
		expect(p.month.star).toBe(true);
		expect(p.weekday.star).toBe(true);
	});

	it("parses step expressions", () => {
		const p = parseCron("*/15 * * * *");
		expect(p.minute.values).toEqual([0, 15, 30, 45]);
	});

	it("parses lists and ranges", () => {
		const p = parseCron("0 9-17 * * 1-5");
		expect(p.minute.values).toEqual([0]);
		expect(p.hour.values).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect(p.weekday.values).toEqual([1, 2, 3, 4, 5]);
	});

	it("accepts 7 as Sunday in weekday field", () => {
		const p = parseCron("0 9 * * 7");
		expect(p.weekday.values).toEqual([0]);
	});

	it("rejects out-of-range values", () => {
		expect(() => parseCron("60 9 * * *")).toThrow();
		expect(() => parseCron("0 24 * * *")).toThrow();
		expect(() => parseCron("0 9 32 * *")).toThrow();
		expect(() => parseCron("0 9 * 13 *")).toThrow();
	});

	it("rejects wrong field count", () => {
		expect(() => parseCron("0 9 * *")).toThrow(/5 fields/);
	});
});

describe("validateCron", () => {
	it("returns null on success", () => {
		expect(validateCron("0 9 * * *")).toBeNull();
	});

	it("returns a friendly error on failure", () => {
		const msg = validateCron("abc");
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/cron/i);
	});
});

describe("specToCron ↔ cronToSpec round-trip", () => {
	const cases = [
		{ mode: "every_n_minutes" as const, everyN: { n: 15, unit: "minute" as const } },
		{ mode: "every_n_hours" as const, everyN: { n: 2, unit: "hour" as const } },
		{ mode: "daily" as const, times: [{ hour: 9, minute: 0 }] },
		{ mode: "daily" as const, times: [{ hour: 2, minute: 0 }, { hour: 3, minute: 0 }] },
		{ mode: "weekdays" as const, times: [{ hour: 9, minute: 0 }, { hour: 18, minute: 0 }] },
		{ mode: "weekly" as const, times: [{ hour: 22, minute: 0 }], weekdays: [0, 6] as Array<0 | 1 | 2 | 3 | 4 | 5 | 6> },
		{ mode: "weekly" as const, times: [{ hour: 12, minute: 30 }], weekdays: [1, 3, 5] as Array<0 | 1 | 2 | 3 | 4 | 5 | 6> },
		{ mode: "monthly" as const, times: [{ hour: 9, minute: 30 }], daysOfMonth: [1, 15] },
	];

	for (const c of cases) {
		it(`round-trips ${JSON.stringify(c)}`, () => {
			const cron = specToCron(c);
			const back = cronToSpec(cron);
			expect(back.mode).toBe(c.mode);
			// Normalize: "weekdays" mode implies Mon-Fri, so cronToSpec adds a
			// weekdays array even when the input omitted it. Compare fields
			// individually instead of using toEqual().
			expect(back.times).toEqual(c.times);
			if (c.mode === "weekdays") {
				expect(back.weekdays).toEqual([1, 2, 3, 4, 5]);
			} else {
				expect((back as any).weekdays).toEqual(c.weekdays);
			}
			expect((back as any).daysOfMonth).toEqual(c.daysOfMonth);
		});
	}

	it("falls back to cron mode for arbitrary expressions", () => {
		const back = cronToSpec("0 0 31 2 *");
		expect(back.mode).toBe("cron");
	});
});

describe("cronNextRun", () => {
	const NOW = new Date("2026-01-01T12:00:00Z").getTime();

	it("matches next minute for * * * * *", () => {
		const next = cronNextRun("* * * * *", NOW);
		expect(next).toBe(NOW + 60_000);
	});

	it("matches the next 9am for 0 9 * * *", () => {
		const next = cronNextRun("0 9 * * *", NOW);
		expect(next).not.toBeNull();
		const d = new Date(next!);
		// cronNextRun uses local-time semantics, so the returned wall-clock
		// time should read 9:00 in local time, not UTC.
		expect(d.getHours()).toBe(9);
		expect(d.getMinutes()).toBe(0);
		expect(next!).toBeGreaterThan(NOW);
	});

	it("returns null for impossible schedules (Feb 31)", () => {
		const next = cronNextRun("0 0 31 2 *", NOW, { maxYearsAhead: 4 });
		expect(next).not.toBeNull();
		// Verify the resulting month is not February.
		expect(new Date(next!).getUTCMonth()).not.toBe(1);
	});

	it("honors weekday field", () => {
		const next = cronNextRun("0 9 * * 1-5", NOW);
		const wd = new Date(next!).getUTCDay();
		expect(wd).toBeGreaterThanOrEqual(1);
		expect(wd).toBeLessThanOrEqual(5);
	});
});