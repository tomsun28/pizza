import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { ScheduleMode } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The 6 visual schedule modes (plus an "advanced (cron)" entry). Matches
 * the screenshot the user shared:
 *
 *   - 每隔 N 分钟 / Every N minutes
 *   - 每隔 N 小时 / Every N hours
 *   - 每天固定时间 / Every day at fixed times
 *   - 工作日固定时间 / Weekdays at fixed times
 *   - 每周几固定时间 / Weekly on chosen weekdays at fixed times
 *   - 每月固定时间 / Monthly on chosen days at fixed times
 *   - Cron 表达式 / Cron expression (advanced)
 */
const VISUAL_MODES: ScheduleMode[] = [
	"every_n_minutes",
	"every_n_hours",
	"daily",
	"weekdays",
	"weekly",
	"monthly",
];

export const ALL_MODES: ScheduleMode[] = [...VISUAL_MODES, "cron"];

export function ScheduleModePicker({
	value,
	onChange,
}: {
	value: ScheduleMode;
	onChange: (next: ScheduleMode) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="grid gap-1.5">
			{VISUAL_MODES.map((mode) => {
				const selected = value === mode;
				return (
					<button
						key={mode}
						type="button"
						onClick={() => onChange(mode)}
						className={cn(
							"flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
							selected
								? "border-accent bg-accent/10 text-fg"
								: "border-border bg-surface-2 text-muted hover:bg-surface hover:text-fg",
						)}
					>
						<span>{t(`schedule.modes.${mode}`)}</span>
						{selected && <Check className="h-3.5 w-3.5 text-accent" />}
					</button>
				);
			})}
			<div className="my-1 border-t border-border/60" />
			<button
				type="button"
				onClick={() => onChange("cron")}
				className={cn(
					"flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
					value === "cron"
						? "border-accent bg-accent/10 text-fg"
						: "border-border bg-surface-2 text-muted hover:bg-surface hover:text-fg",
				)}
			>
				<span>{t("schedule.modes.cron")}</span>
				{value === "cron" && <Check className="h-3.5 w-3.5 text-accent" />}
			</button>
		</div>
	);
}