import { describe, expect, it } from "vitest";
import { parseScheduleShorthand } from "../../src/core/scheduler/shorthand.js";

describe("parseScheduleShorthand", () => {
	describe("cron expressions", () => {
		it("parses a cron expression with metacharacters", () => {
			const r = parseScheduleShorthand("0 9 * * *");
			expect(r.ok).toBe(true);
		});

		it("parses a step cron expression", () => {
			const r = parseScheduleShorthand("*/15 * * * *");
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.spec.mode).toBe("every_n_minutes");
		});

		it("parses a weekday range cron expression", () => {
			const r = parseScheduleShorthand("0 9 * * 1-5");
			expect(r.ok).toBe(true);
		});

		it("parses an ALL-NUMERIC 5-field cron expression (regression)", () => {
			// "0 9 1 1 1" = 9am every Jan 1. No metacharacter, but it is a valid
			// cron expression and must NOT be rejected as "unrecognized".
			const r = parseScheduleShorthand("0 9 1 1 1");
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.spec.mode).toBe("cron");
				expect((r.spec as any).cron.expression).toBe("0 9 1 1 1");
			}
		});

		it("parses another all-numeric cron expression", () => {
			// "30 14 15 6 3" = 2:30pm on June 15 (weekday 3). All numeric.
			const r = parseScheduleShorthand("30 14 15 6 3");
			expect(r.ok).toBe(true);
			if (r.ok) expect((r.spec as any).cron.expression).toBe("30 14 15 6 3");
		});

		it("rejects an out-of-range cron expression", () => {
			const r = parseScheduleShorthand("60 9 * * *");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/cron/i);
		});
	});

	describe("interval shorthand", () => {
		it("parses a bare minute interval", () => {
			const r = parseScheduleShorthand("30m");
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.spec.mode).toBe("every_n_minutes");
				expect((r.spec as any).everyN.n).toBe(30);
			}
		});

		it("parses a bare hour interval", () => {
			const r = parseScheduleShorthand("2h");
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.spec.mode).toBe("every_n_hours");
				expect((r.spec as any).everyN.n).toBe(2);
			}
		});

		it("parses an 'every N <unit>' phrase", () => {
			const r = parseScheduleShorthand("every 2h");
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.spec.mode).toBe("every_n_hours");
		});

		it("parses 'every N minutes'", () => {
			const r = parseScheduleShorthand("every 30 minutes");
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.spec.mode).toBe("every_n_minutes");
		});

		it("rejects an interval N that is out of bounds", () => {
			const r = parseScheduleShorthand("999999m");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/interval/i);
		});
	});

	describe("error handling", () => {
		it("rejects an empty string", () => {
			const r = parseScheduleShorthand("");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/empty/i);
		});

		it("rejects whitespace-only input", () => {
			const r = parseScheduleShorthand("   ");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/empty/i);
		});

		it("rejects unrecognized free text", () => {
			const r = parseScheduleShorthand("every 2h from now");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/unrecognized/i);
		});

		it("rejects a bare number with no unit and not 5 fields", () => {
			const r = parseScheduleShorthand("30");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/unrecognized/i);
		});
	});
});