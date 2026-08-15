import type { DayOfMonth, ScheduleSpec, TimeOfDay, Weekday } from "@/lib/types";

const WEEKDAY_LABELS_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** Format an HH:MM time for display. */
export function formatTimeOfDay(t: TimeOfDay): string {
	return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/** Format nextRunAt for display. */
export function formatNextRun(at: number | null | undefined): string {
	if (!at) return "—";
	const d = new Date(at);
	const now = Date.now();
	const diff = at - now;
	const time = d.toLocaleString();
	if (diff < 0) return `${time} (已过期)`;
	const minutes = Math.round(diff / 60_000);
	if (minutes < 60) return `${time} (${minutes} 分钟后)`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${time} (${hours} 小时后)`;
	const days = Math.round(hours / 24);
	return `${time} (${days} 天后)`;
}

/** Format a list of times for display (e.g. "09:00, 18:00"). */
function formatTimes(times: TimeOfDay[] | undefined): string {
	if (!times || times.length === 0) return "—";
	return times.map(formatTimeOfDay).join(", ");
}

/** Format days of month list. */
function formatDaysOfMonth(days: DayOfMonth[] | undefined): string {
	if (!days || days.length === 0) return "—";
	return days.join(", ");
}

/** Format weekdays list. */
function formatWeekdays(weekdays: Weekday[] | undefined): string {
	if (!weekdays || weekdays.length === 0) return "—";
	return weekdays.map((d) => `周${WEEKDAY_LABELS_ZH[d]}`).join(", ");
}

/** One-line human summary of a task's trigger, for dense list rows. */
export function describeSchedule(schedule: ScheduleSpec): string {
	switch (schedule.mode) {
		case "every_n_minutes":
			return `每 ${schedule.everyN?.n ?? "?"} 分钟`;
		case "every_n_hours":
			return `每 ${schedule.everyN?.n ?? "?"} 小时`;
		case "daily":
			return `每天 ${formatTimes(schedule.times)}`;
		case "weekdays":
			return `工作日 ${formatTimes(schedule.times)}`;
		case "weekly":
			return `${formatWeekdays(schedule.weekdays)} ${formatTimes(schedule.times)}`;
		case "monthly":
			return `每月 ${formatDaysOfMonth(schedule.daysOfMonth)} ${formatTimes(schedule.times)}`;
		case "cron":
			return schedule.cron?.expression ?? "";
		default:
			return "";
	}
}
