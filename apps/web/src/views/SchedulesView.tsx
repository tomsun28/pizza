import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Calendar, Pencil, Play, Plus, RefreshCw } from "lucide-react";
import type { ScheduledTaskSummary } from "@/lib/types";
import {
	deleteScheduledTask,
	getScheduledTaskHistory,
	listScheduledTasks,
	reloadScheduledTasks,
	runScheduledTaskNow,
	subscribeEvents,
	updateScheduledTask,
} from "@/lib/transport";
import { Badge, Button, EmptyState, ErrorBanner, PageHeader, Spinner } from "@/components/ui";
import {
	DeleteTaskButton,
	ScheduleDialog,
	formatDaysOfMonth,
	formatNextRun,
	formatTimes,
	formatWeekdays,
} from "@/components/ScheduleDialog";
import { specToCronText } from "@/lib/schedule-preview";
import { cn } from "@/lib/utils";

type Scope = "main" | "workspace";

export default function SchedulesView({
	scope,
	workspaceId,
}: {
	scope: Scope;
	workspaceId?: string;
}) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const [tasks, setTasks] = useState<ScheduledTaskSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingTask, setEditingTask] = useState<ScheduledTaskSummary | null>(null);
	const [history, setHistory] = useState<Awaited<ReturnType<typeof getScheduledTaskHistory>>>([]);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const list = await listScheduledTasks(scope, workspaceId);
			setTasks(list);
			if (list.length > 0 && !selectedId) setSelectedId(list[0]!.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [scope, workspaceId, selectedId]);

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scope, workspaceId]);

	// Live-update when a task fires or completes. The engine emits these
	// over the rpc_event stream; we re-fetch the list so the nextRunAt field
	// rolls forward and the history panel picks up the new run row.
	useEffect(() => {
		let cancelled = false;
		let unsubscribe: (() => void) | null = null;
		const onAny = () => {
			if (cancelled) return;
			void refresh();
		};
		(async () => {
			const unsub = await subscribeEvents((event) => {
				const type = (event as { type?: string }).type;
				if (type === "SCHEDULED_TASK_FIRED" || type === "SCHEDULED_TASK_COMPLETED") {
					onAny();
				}
			}).catch(() => { /* subscribe failed — rely on manual reload */ });
			if (cancelled) {
				unsub?.();
				return;
			}
			unsubscribe = unsub;
		})();
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scope, workspaceId]);

	const selected = tasks.find((t) => t.id === selectedId) ?? null;

	useEffect(() => {
		if (!selected) {
			setHistory([]);
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const runs = await getScheduledTaskHistory(selected.id, scope, workspaceId, 50);
				if (!cancelled) setHistory(runs);
			} catch (e) {
				if (!cancelled) {
					setHistory([]);
				}
				console.error("[schedules] history fetch failed:", e);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [selected, scope, workspaceId]);

	const handleSaved = (task: ScheduledTaskSummary) => {
		setTasks((prev) => {
			const idx = prev.findIndex((t) => t.id === task.id);
			if (idx >= 0) {
				const next = prev.slice();
				next[idx] = task;
				return next;
			}
			return [...prev, task];
		});
		setSelectedId(task.id);
		setDialogOpen(false);
		setEditingTask(null);
	};

	const handleDelete = async (task: ScheduledTaskSummary) => {
		if (!confirm(t("schedule.confirmDelete", { name: task.name }))) return;
		try {
			await deleteScheduledTask(task.id, scope, workspaceId);
			setTasks((prev) => prev.filter((t) => t.id !== task.id));
			if (selectedId === task.id) {
				const remaining = tasks.filter((t) => t.id !== task.id);
				setSelectedId(remaining[0]?.id ?? null);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleToggleEnabled = async (task: ScheduledTaskSummary) => {
		try {
			const updated = await updateScheduledTask(
				task.id,
				{ enabled: !task.enabled },
				scope,
				workspaceId,
			);
			setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleRunNow = async (task: ScheduledTaskSummary) => {
		try {
			await runScheduledTaskNow(task.id, scope, workspaceId);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleReload = async () => {
		try {
			await reloadScheduledTasks();
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div className="px-6 py-6">
			<PageHeader
				title={t("schedule.title")}
				description={t("schedule.subtitle", { scope: scope === "main" ? t("schedule.scopeMain") : t("schedule.scopeWorkspace") })}
				actions={
					<div className="flex items-center gap-2">
					<Button
						tone="neutral"
						variant="ghost"
						size="sm"
						iconLeft={<ArrowLeft className="h-3.5 w-3.5" />}
						onClick={() => navigate("/")}
					>
						{t("common.backToChat")}
					</Button>
					<Button
						tone="neutral"
						variant="ghost"
						size="sm"
						iconLeft={<RefreshCw className="h-3.5 w-3.5" />}
						onClick={handleReload}
					>
						{t("schedule.reload")}
					</Button>
						<Button
							tone="accent"
							iconLeft={<Plus className="h-3.5 w-3.5" />}
							onClick={() => {
								setEditingTask(null);
								setDialogOpen(true);
							}}
						>
							{t("schedule.new")}
						</Button>
					</div>
				}
			/>

			{error && <ErrorBanner message={error} />}

			{loading ? (
				<div className="flex items-center gap-2 text-sm text-muted">
					<Spinner />
					{t("common.loading")}
				</div>
			) : tasks.length === 0 ? (
				<EmptyState
					title={t("schedule.emptyTitle")}
					description={t("schedule.emptyDescription")}
					action={
						<Button
							tone="accent"
							iconLeft={<Plus className="h-3.5 w-3.5" />}
							onClick={() => setDialogOpen(true)}
						>
							{t("schedule.new")}
						</Button>
					}
				/>
			) : (
				<div className="grid grid-cols-[minmax(220px,300px)_1fr] gap-4">
					{/* Left: task list */}
					<div className="space-y-2">
						{tasks.map((task) => (
							<TaskListItem
								key={task.id}
								task={task}
								selected={task.id === selectedId}
								onSelect={() => setSelectedId(task.id)}
							/>
						))}
					</div>

					{/* Right: detail */}
					{selected ? (
						<TaskDetail
							task={selected}
							history={history}
							onEdit={() => {
								setEditingTask(selected);
								setDialogOpen(true);
							}}
							onDelete={() => handleDelete(selected)}
							onToggleEnabled={() => handleToggleEnabled(selected)}
							onRunNow={() => handleRunNow(selected)}
						/>
					) : (
						<div className="rounded-xl border border-dashed border-border bg-surface p-8 text-center text-sm text-muted">
							{t("schedule.selectOne")}
						</div>
					)}
				</div>
			)}

			<ScheduleDialog
				open={dialogOpen}
				onClose={() => {
					setDialogOpen(false);
					setEditingTask(null);
				}}
				scope={scope}
				workspaceId={workspaceId}
				existing={editingTask}
				onSaved={handleSaved}
			/>
		</div>
	);
}

function TaskListItem({
	task,
	selected,
	onSelect,
}: {
	task: ScheduledTaskSummary;
	selected: boolean;
	onSelect: () => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"w-full rounded-lg border px-3 py-2 text-left transition-colors",
				selected
					? "border-accent bg-accent/10"
					: "border-border bg-surface hover:bg-surface-2",
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="truncate text-sm font-medium text-fg">{task.name}</span>
				<Badge tone={task.enabled ? "success" : "neutral"}>
					{task.enabled ? t("schedule.enabled") : t("schedule.disabled")}
				</Badge>
			</div>
			<div className="mt-0.5 truncate font-mono text-[10px] text-muted">
				{describeSchedule(task)}
			</div>
			<div className="mt-1 truncate text-[10px] text-muted">
				{t("schedule.nextRun")}: {formatNextRun(task.nextRunAt)}
			</div>
		</button>
	);
}

function TaskDetail({
	task,
	history,
	onEdit,
	onDelete,
	onToggleEnabled,
	onRunNow,
}: {
	task: ScheduledTaskSummary;
	history: Awaited<ReturnType<typeof getScheduledTaskHistory>>;
	onEdit: () => void;
	onDelete: () => void;
	onToggleEnabled: () => void;
	onRunNow: () => void;
}) {
	const { t } = useTranslation();
	const cron = specToCronText(task.schedule);
	return (
		<div className="rounded-xl border border-border bg-surface p-4">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-base font-medium text-fg">{task.name}</h3>
					<div className="mt-0.5 text-xs text-muted">
						{t("schedule.createdBy")}: {task.createdBy === "intent" ? t("schedule.createdByIntent") : t("schedule.createdByUser")}
						{task.runCount !== undefined && task.runCount > 0 && (
							<>
								{" · "}
								{t("schedule.runCount", { count: task.runCount })}
							</>
						)}
					</div>
				</div>
				<div className="flex items-center gap-1">
					<Button tone="accent" size="sm" iconLeft={<Play className="h-3.5 w-3.5" />} onClick={onRunNow}>
						{t("schedule.runNow")}
					</Button>
					<Button tone="neutral" variant="ghost" size="sm" iconLeft={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit}>
						{t("schedule.edit")}
					</Button>
					<DeleteTaskButton onClick={onDelete} />
				</div>
			</div>

			<div className="mt-3 grid grid-cols-2 gap-3 text-xs">
				<Field2 label={t("schedule.mode")} value={t(`schedule.modes.${task.schedule.mode}`)} />
				<Field2 label={t("schedule.nextRun")} value={formatNextRun(task.nextRunAt)} />
				<Field2
					label={t("schedule.time")}
					value={formatTimes(task.schedule.times)}
				/>
				{task.schedule.mode === "weekly" && (
					<Field2
						label={t("schedule.weekdays")}
						value={formatWeekdays(task.schedule.weekdays)}
					/>
				)}
				{task.schedule.mode === "monthly" && (
					<Field2
						label={t("schedule.daysOfMonth")}
						value={formatDaysOfMonth(task.schedule.daysOfMonth)}
					/>
				)}
				{(task.schedule.mode === "every_n_minutes" || task.schedule.mode === "every_n_hours") && (
					<Field2
						label={t("schedule.n")}
						value={`${task.schedule.everyN?.n ?? "?"} ${
							task.schedule.everyN?.unit === "hour" ? t("schedule.hour") : t("schedule.minute")
						}`}
					/>
				)}
				<Field2
					label={t("schedule.enabled")}
					value={
						<button
							type="button"
							onClick={onToggleEnabled}
							className={cn(
								"rounded-full px-2 py-0.5 text-[10px]",
								task.enabled ? "bg-success/15 text-success" : "bg-surface-2 text-muted",
							)}
						>
							{task.enabled ? t("schedule.enabled") : t("schedule.disabled")}
						</button>
					}
				/>
			</div>

			{cron && (
				<div className="mt-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
					<span className="text-muted">{t("schedule.cronEquivalent")}: </span>
					<span className="font-mono text-fg">{cron}</span>
				</div>
			)}

			<div className="mt-3">
				<div className="mb-1 text-xs text-muted">{t("schedule.taskContent")}</div>
				<div className="whitespace-pre-wrap rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg">
					{task.prompt}
				</div>
			</div>

			<div className="mt-4">
				<div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
					<Calendar className="h-3.5 w-3.5" />
					{t("schedule.history")}
				</div>
				{history.length === 0 ? (
					<div className="rounded-md border border-dashed border-border bg-surface-2 px-3 py-2 text-xs text-muted">
						{t("schedule.historyEmpty")}
					</div>
				) : (
					<ul className="space-y-0.5 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
						{history.map((run, i) => (
							<li key={`${run.at}-${i}`} className="flex items-center gap-2 font-mono">
								<span
									className={cn(
										"inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
										run.status === "ok" ? "bg-success/15 text-success" : "bg-danger/15 text-danger",
									)}
								>
									{run.status === "ok" ? "✓" : "✗"}
								</span>
								<span className="text-fg">{new Date(run.at).toLocaleString()}</span>
								{run.reason && <span className="text-muted">— {run.reason}</span>}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function Field2({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div>
			<div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
			<div className="mt-0.5 text-fg">{value}</div>
		</div>
	);
}

function describeSchedule(task: ScheduledTaskSummary): string {
	switch (task.schedule.mode) {
		case "every_n_minutes":
			return `${task.schedule.everyN?.n ?? "?"} 分钟`;
		case "every_n_hours":
			return `${task.schedule.everyN?.n ?? "?"} 小时`;
		case "daily":
			return `每天 ${formatTimes(task.schedule.times)}`;
		case "weekdays":
			return `工作日 ${formatTimes(task.schedule.times)}`;
		case "weekly":
			return `${formatWeekdays(task.schedule.weekdays)} ${formatTimes(task.schedule.times)}`;
		case "monthly":
			return `每月 ${formatDaysOfMonth(task.schedule.daysOfMonth)} ${formatTimes(task.schedule.times)}`;
		case "cron":
			return task.schedule.cron?.expression ?? "";
	}
}