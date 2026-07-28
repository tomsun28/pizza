import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { DayOfMonth, ScheduleSpec, ScheduledTaskSummary, TimeOfDay, Weekday } from "@/lib/types";
import { Button, ErrorBanner, Field, Modal, Spinner } from "@/components/ui";
import { ScheduleModePicker } from "@/components/ScheduleModePicker";
import { TimePointChips, formatTimeOfDay } from "@/components/TimePointChips";
import { SchedulePreview } from "@/components/SchedulePreview";
import { createScheduledTask, updateScheduledTask } from "@/lib/transport";
import { cn } from "@/lib/utils";

type Scope = "main" | "workspace";

interface ScheduleDialogProps {
	open: boolean;
	onClose: () => void;
	scope: Scope;
	workspaceId?: string;
	/** When editing, the existing task. When creating, undefined. */
	existing?: ScheduledTaskSummary | null;
	onSaved: (task: ScheduledTaskSummary) => void;
}

/** Build an empty visual schedule for "create" mode. */
function blankSpec(): ScheduleSpec {
	return {
		mode: "daily",
		times: [{ hour: 9, minute: 0 }],
	};
}

const WEEKDAY_LABELS_ZH = ["日", "一", "二", "三", "四", "五", "六"];

export function ScheduleDialog(props: ScheduleDialogProps) {
	const { t } = useTranslation();
	const { open, onClose, scope, workspaceId, existing, onSaved } = props;
	const isEdit = !!existing;

	const [name, setName] = useState(existing?.name ?? "");
	const [prompt, setPrompt] = useState(existing?.prompt ?? "");
	const [spec, setSpec] = useState<ScheduleSpec>(existing?.schedule ?? blankSpec());
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	// Local draft input for the monthly day-of-month picker. Kept here so it
	// survives re-renders of `renderModeFields` (which is a plain function,
	// not a component, so it can't call hooks itself).
	const [daysOfMonthDraft, setDaysOfMonthDraft] = useState("");

	// Reset whenever the dialog opens with a different existing task.
	useEffect(() => {
		if (!open) return;
		setName(existing?.name ?? "");
		setPrompt(existing?.prompt ?? "");
		setSpec(existing?.schedule ?? blankSpec());
		setEnabled(existing?.enabled ?? true);
		setError(null);
		setSaving(false);
	}, [open, existing]);

	const canSave = useMemo(() => {
		if (!name.trim()) return false;
		if (!prompt.trim()) return false;
		if (spec.mode === "daily" || spec.mode === "weekdays") {
			return (spec.times?.length ?? 0) > 0;
		}
		if (spec.mode === "weekly") {
			return (spec.times?.length ?? 0) > 0 && (spec.weekdays?.length ?? 0) > 0;
		}
		if (spec.mode === "monthly") {
			return (spec.times?.length ?? 0) > 0 && (spec.daysOfMonth?.length ?? 0) > 0;
		}
		if (spec.mode === "cron") {
			return !!spec.cron?.expression?.trim();
		}
		if (spec.mode === "every_n_minutes" || spec.mode === "every_n_hours") {
			return (spec.everyN?.n ?? 0) >= 1;
		}
		return false;
	}, [name, prompt, spec]);

	const handleSave = async () => {
		if (!canSave || saving) return;
		setError(null);
		setSaving(true);
		try {
			if (isEdit && existing) {
				const updated = await updateScheduledTask(
					existing.id,
					{ name, prompt, schedule: spec, enabled },
					scope,
					workspaceId,
				);
				onSaved(updated);
			} else {
				const created = await createScheduledTask({
					name,
					prompt,
					scope,
					workspaceId,
					schedule: spec,
					enabled,
					createdBy: "user",
				});
				onSaved(created);
			}
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	// ---- Per-mode field renderers -----

	const renderModeFields = () => {
		switch (spec.mode) {
			case "every_n_minutes":
			case "every_n_hours":
				return (
					<div className="flex items-center gap-2">
						<span className="text-xs text-muted">{t("schedule.n")}</span>
						<input
							type="number"
							min={1}
							max={spec.mode === "every_n_hours" ? 23 : 59}
							value={spec.everyN?.n ?? 1}
							onChange={(e) => {
								const n = Math.max(1, Number(e.target.value || 1));
								setSpec({
									...spec,
									everyN: {
										n,
										unit: spec.mode === "every_n_hours" ? "hour" : "minute",
									},
								});
							}}
							className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent"
						/>
						<span className="text-xs text-muted">
							{spec.mode === "every_n_hours" ? t("schedule.hour") : t("schedule.minute")}
						</span>
					</div>
				);
			case "daily":
				return (
					<Field label={t("schedule.time")}>
						<TimePointChips
							value={spec.times ?? []}
							onChange={(times) => setSpec({ ...spec, times })}
						/>
					</Field>
				);
			case "weekdays":
				return (
					<Field label={t("schedule.time")}>
						<TimePointChips
							value={spec.times ?? []}
							onChange={(times) => setSpec({ ...spec, times })}
						/>
					</Field>
				);
			case "weekly": {
				const selected = spec.weekdays ?? [];
				const toggle = (d: Weekday) => {
					const next = selected.includes(d)
						? selected.filter((x) => x !== d)
						: [...selected, d].sort();
					setSpec({ ...spec, weekdays: next });
				};
				return (
					<div className="space-y-3">
						<Field label={t("schedule.weekdays")}>
							<div className="flex flex-wrap gap-1.5">
								{WEEKDAY_LABELS_ZH.map((label, idx) => {
									const d = idx as Weekday;
									const on = selected.includes(d);
									return (
										<button
											key={d}
											type="button"
											onClick={() => toggle(d)}
											className={cn(
												"h-8 w-8 rounded-full border text-xs transition-colors",
												on
													? "border-accent bg-accent text-accent-fg"
													: "border-border bg-surface-2 text-muted hover:bg-surface hover:text-fg",
											)}
											title={`周${label}`}
										>
											{label}
										</button>
									);
								})}
							</div>
						</Field>
						<Field label={t("schedule.time")}>
							<TimePointChips
								value={spec.times ?? []}
								onChange={(times) => setSpec({ ...spec, times })}
							/>
						</Field>
					</div>
				);
			}
			case "monthly": {
				const days = spec.daysOfMonth ?? [];
				const addDay = (n: number) => {
					if (n < 1 || n > 31) return;
					const next = Array.from(new Set([...days, n])).sort((a, b) => a - b);
					setSpec({ ...spec, daysOfMonth: next });
				};
				const removeDay = (n: number) => {
					setSpec({ ...spec, daysOfMonth: days.filter((x) => x !== n) });
				};
				const draft = daysOfMonthDraft;
				const setDraft = setDaysOfMonthDraft;
				return (
					<div className="space-y-3">
						<Field label={t("schedule.daysOfMonth")}>
							<div className="space-y-1.5">
								<div className="flex flex-wrap gap-1.5">
									{days.map((d) => (
										<span
											key={d}
											className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-fg"
										>
											<span className="font-mono">{d}</span>
											<button
												type="button"
												onClick={() => removeDay(d)}
												className="ml-0.5 text-muted hover:text-danger"
											>
												×
											</button>
										</span>
									))}
								</div>
								<div className="flex items-center gap-1">
									<input
										type="number"
										min={1}
										max={31}
										value={draft}
										placeholder="1-31"
										onChange={(e) => setDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												const n = Number(draft);
												if (!Number.isNaN(n)) addDay(n);
												setDraft("");
											}
										}}
										className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-accent"
									/>
									<button
										type="button"
										onClick={() => {
											const n = Number(draft);
											if (!Number.isNaN(n)) addDay(n);
											setDraft("");
										}}
										className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
									>
										+
									</button>
								</div>
							</div>
						</Field>
						<Field label={t("schedule.time")}>
							<TimePointChips
								value={spec.times ?? []}
								onChange={(times) => setSpec({ ...spec, times })}
							/>
						</Field>
					</div>
				);
			}
			case "cron":
				return (
					<Field label={t("schedule.expression")} hint="min hour day month weekday">
						<input
							type="text"
							value={spec.cron?.expression ?? ""}
							placeholder="0 9 * * *"
							onChange={(e) => setSpec({ ...spec, cron: { expression: e.target.value, tz: spec.cron?.tz } })}
							className="h-9 w-full rounded-md border border-border bg-surface px-3 font-mono text-sm text-fg outline-none focus:border-accent"
						/>
						{spec.cron?.tz !== undefined && (
							<input
								type="text"
								value={spec.cron.tz ?? ""}
								placeholder="Asia/Shanghai (optional)"
								onChange={(e) => setSpec({ ...spec, cron: { expression: spec.cron?.expression ?? "", tz: e.target.value } })}
								className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-3 text-xs text-fg outline-none focus:border-accent"
							/>
						)}
					</Field>
				);
		}
	};

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={isEdit ? t("schedule.editTitle") : t("schedule.createTitle")}
			footer={
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 text-xs text-muted">
						<label className="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								checked={enabled}
								onChange={(e) => setEnabled(e.target.checked)}
								className="accent-accent"
							/>
							{t("schedule.enabled")}
						</label>
					</div>
					<div className="flex items-center gap-2">
						<Button tone="neutral" variant="ghost" onClick={onClose} disabled={saving}>
							{t("schedule.cancel")}
						</Button>
						<Button tone="accent" onClick={handleSave} disabled={!canSave || saving}>
							{saving ? <Spinner /> : null}
							{t("schedule.save")}
						</Button>
					</div>
				</div>
			}
		>
			<div className="space-y-4">
				{error && <ErrorBanner message={error} />}

				<Field label={t("schedule.name")}>
					<input
						type="text"
						value={name}
						placeholder={t("schedule.namePlaceholder")}
						onChange={(e) => setName(e.target.value)}
						className="w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm text-fg outline-none focus:border-accent"
					/>
				</Field>

				<div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[180px_1fr] sm:items-center">
					<span className="text-xs font-medium uppercase tracking-wider text-muted">{t("schedule.mode")}</span>
					<ScheduleModePicker
						value={spec.mode}
						onChange={(mode) => {
							// Switching mode resets the mode-specific fields so canSave()
							// never gets stuck because the previous mode left an unrelated
							// field undefined. Drop everyN / times / weekdays / daysOfMonth
							// / cron first, then layer on sensible defaults for the new mode.
							const base: ScheduleSpec = {
								...spec,
								mode,
								everyN: undefined,
								times: undefined,
								weekdays: undefined,
								daysOfMonth: undefined,
								cron: undefined,
							};
							let next: ScheduleSpec = base;
							if (mode === "every_n_minutes") {
								next = { ...base, everyN: { n: 15, unit: "minute" } };
							} else if (mode === "every_n_hours") {
								next = { ...base, everyN: { n: 1, unit: "hour" } };
							} else if (mode === "daily" || mode === "weekdays" || mode === "weekly" || mode === "monthly") {
								next = { ...base, times: [{ hour: 9, minute: 0 }] };
								if (mode === "weekdays") next = { ...next, weekdays: [1, 2, 3, 4, 5] };
								if (mode === "weekly") next = { ...next, weekdays: [1, 3, 5] };
								if (mode === "monthly") next = { ...next, daysOfMonth: [1] };
							} else if (mode === "cron") {
								next = { ...base, cron: { expression: "0 9 * * *" } };
							}
							setSpec(next);
						}}
					/>
					<span className="self-start text-xs font-medium uppercase tracking-wider text-muted">{t("schedule.details")}</span>
					<div>{renderModeFields()}</div>
				</div>

				<Field label={t("schedule.taskContent")} hint={t("schedule.taskContentHint")}>
					<textarea
						value={prompt}
						placeholder={t("schedule.taskContentPlaceholder")}
						onChange={(e) => setPrompt(e.target.value)}
						rows={3}
						className="w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm text-fg outline-none focus:border-accent"
					/>
				</Field>

				<SchedulePreview spec={spec} />

				<div className="flex items-center gap-2 text-xs text-muted">
					<span>{t("schedule.scope")}:</span>
					<span
						className={cn(
							"rounded-full px-2 py-0.5 text-[11px]",
							scope === "main" ? "bg-accent/15 text-accent" : "bg-surface-2 text-fg",
						)}
					>
						{scope === "main" ? t("schedule.scopeMain") : t("schedule.scopeWorkspace")}
					</span>
				</div>
			</div>
		</Modal>
	);
}

/**
 * Small inline delete-confirm helper used by SchedulesPanel.
 */
export function DeleteTaskButton({
	onClick,
	loading,
}: {
	onClick: () => void;
	loading?: boolean;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={loading}
			className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-muted hover:border-danger hover:text-danger disabled:opacity-50"
			title={t("schedule.delete")}
		>
			<Trash2 className="h-3 w-3" />
			{t("schedule.delete")}
		</button>
	);
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
export function formatTimes(times: TimeOfDay[] | undefined): string {
	if (!times || times.length === 0) return "—";
	return times.map(formatTimeOfDay).join(", ");
}

/** Format days of month list. */
export function formatDaysOfMonth(days: DayOfMonth[] | undefined): string {
	if (!days || days.length === 0) return "—";
	return days.join(", ");
}

/** Format weekdays list. */
export function formatWeekdays(weekdays: Weekday[] | undefined): string {
	if (!weekdays || weekdays.length === 0) return "—";
	return weekdays.map((d) => `周${WEEKDAY_LABELS_ZH[d]}`).join(", ");
}