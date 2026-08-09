/**
 * Pure-JS port of the server-side schedule math, used by the UI to render
 * "next 3 fire times" and the equivalent cron expression without a
 * round-trip to the sidecar.
 *
 * Keep this in sync with src/core/scheduler/{engine.ts,cron.ts}. If they
 * diverge the preview will look right but the actual fire time won't.
 */

import type { ScheduleSpec, TimeOfDay } from "@/lib/types";

// ----- Cron expression generation (visual -> cron) -----

function __pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function fmtRange(values: number[]): string {
	if (values.length === 0) return "*";
	if (values.length === 1) return String(values[0]);
	const isContiguous = values.every((v, i) => i === 0 || v === values[i - 1]! + 1);
	if (isContiguous) return `${values[0]}-${values[values.length - 1]}`;
	return values.join(",");
}

function uniqueSorted<T extends number>(arr: readonly T[]): T[] {
	return Array.from(new Set(arr)).sort((a, b) => a - b) as T[];
}

export function specToCronText(spec: ScheduleSpec): string {
	switch (spec.mode) {
		case "every_n_minutes": {
			const n = spec.everyN?.n ?? 1;
			if (spec.everyN?.unit === "hour") {
				if (n < 1 || n > 23) return "";
				return `0 */${n} * * *`;
			}
			if (n < 1 || n > 59) return "";
			return n === 1 ? `* * * * *` : `*/${n} * * * *`;
		}
		case "every_n_hours": {
			const n = spec.everyN?.n ?? 1;
			if (n < 1 || n > 23) return "";
			return `0 */${n} * * *`;
		}
		case "daily": {
			const times = (spec.times ?? []).slice();
			if (times.length === 0) return "";
			const minutes = uniqueSorted(times.map((t: TimeOfDay) => t.minute));
			const hours = uniqueSorted(times.map((t: TimeOfDay) => t.hour));
			return `${fmtRange(minutes)} ${fmtRange(hours)} * * *`;
		}
		case "weekdays": {
			const times = (spec.times ?? []).slice();
			if (times.length === 0) return "";
			const minutes = uniqueSorted(times.map((t: TimeOfDay) => t.minute));
			const hours = uniqueSorted(times.map((t: TimeOfDay) => t.hour));
			return `${fmtRange(minutes)} ${fmtRange(hours)} * * 1-5`;
		}
		case "weekly": {
			const times = (spec.times ?? []).slice();
			const weekdays = (spec.weekdays ?? []).slice();
			if (times.length === 0 || weekdays.length === 0) return "";
			const minutes = uniqueSorted(times.map((t: TimeOfDay) => t.minute));
			const hours = uniqueSorted(times.map((t: TimeOfDay) => t.hour));
			const wd = uniqueSorted(weekdays).map((d) => (d === 0 ? 7 : d));
			return `${fmtRange(minutes)} ${fmtRange(hours)} * * ${fmtRange(wd)}`;
		}
		case "monthly": {
			const times = (spec.times ?? []).slice();
			const days = (spec.daysOfMonth ?? []).slice();
			if (times.length === 0 || days.length === 0) return "";
			const minutes = uniqueSorted(times.map((t: TimeOfDay) => t.minute));
			const hours = uniqueSorted(times.map((t: TimeOfDay) => t.hour));
			return `${fmtRange(minutes)} ${fmtRange(hours)} ${fmtRange(uniqueSorted(days))} * *`;
		}
		case "cron": {
			return spec.cron?.expression ?? "";
		}
		default:
			return "";
	}
}

// ----- Next-N-fires computation -----

function matchesDateMode(
	mode: "daily" | "weekdays" | "weekly" | "monthly",
	d: Date,
	weekdays: number[] | null,
	daysOfMonth: number[] | null,
): boolean {
	const day = d.getDay();
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

function nextForDateAnchored(
	mode: "daily" | "weekdays" | "weekly" | "monthly",
	times: Array<{ hour: number; minute: number }>,
	weekdays: number[] | null,
	daysOfMonth: number[] | null,
	from: number,
	endAt: number | undefined,
): number | null {
	const base = new Date(from);
	let candidate = new Date(
		base.getFullYear(),
		base.getMonth(),
		base.getDate(),
		base.getHours(),
		base.getMinutes(),
		0,
		0,
	).getTime();
	if (candidate <= from) candidate += 60_000;
	const horizon = from + 366 * 24 * 3600_000;
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
		candidate += 60_000;
	}
	return null;
}

export function nextRunsFromSpec(spec: ScheduleSpec, n: number, from: number = Date.now()): number[] {
	const out: number[] = [];
	let cursor = Math.max(from, spec.startAt ?? 0);
	for (let i = 0; i < n; i++) {
		let next: number | null = null;
		switch (spec.mode) {
			case "every_n_minutes": {
				const nMin = spec.everyN?.n ?? 1;
				const interval = (spec.everyN?.unit === "hour" ? nMin * 60 : nMin) * 60_000;
				const c = Math.ceil(cursor / interval) * interval;
				next = c >= cursor ? c : c + interval;
				if (typeof spec.endAt === "number" && next > spec.endAt) next = null;
				break;
			}
			case "every_n_hours": {
				const nH = spec.everyN?.n ?? 1;
				const interval = nH * 3600_000;
				const c = Math.ceil(cursor / interval) * interval;
				next = c >= cursor ? c : c + interval;
				if (typeof spec.endAt === "number" && next > spec.endAt) next = null;
				break;
			}
			case "daily":
			case "weekdays":
			case "weekly":
			case "monthly": {
				next = nextForDateAnchored(
					spec.mode,
					spec.times ?? [],
					spec.weekdays ?? null,
					spec.daysOfMonth ?? null,
					cursor,
					spec.endAt,
				);
				break;
			}
			case "cron":
				// Lightweight preview: skip cron (would need the full parser).
				return out;
		}
		if (next === null) break;
		out.push(next);
		cursor = next + 60_000;
	}
	return out;
}