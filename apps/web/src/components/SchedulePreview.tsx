import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import type { ScheduleSpec } from "@/lib/types";
import { specToCronText, nextRunsFromSpec } from "@/lib/schedule-preview";

/**
 * Live preview of the next 3 fire times for a given schedule. Uses a pure
 * JS port of the engine's nextRunAt so the preview matches what the
 * backend will actually compute (no LLM / network round-trip needed).
 *
 * Also displays the equivalent cron expression as a sanity check.
 */
export function SchedulePreview({ spec }: { spec: ScheduleSpec }) {
	const { t } = useTranslation();
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const i = setInterval(() => setTick((n) => n + 1), 30_000);
		return () => clearInterval(i);
	}, []);

	const cron = specToCronText(spec);
	const runs = nextRunsFromSpec(spec, 3);

	return (
		<div className="rounded-lg border border-border bg-surface-2 p-3 text-xs text-muted">
			<div className="mb-1 flex items-center gap-1.5 text-fg">
				<Clock className="h-3.5 w-3.5 text-accent" />
				<span className="font-medium">{t("schedule.previewNext")}</span>
			</div>
			{cron && (
				<div className="mb-2 font-mono text-[11px] text-muted">
					cron: <span className="text-fg">{cron}</span>
				</div>
			)}
			{runs.length === 0 ? (
				<div>{t("schedule.previewNone")}</div>
			) : (
				<ul className="space-y-0.5">
					{runs.map((r, i) => (
						<li key={`${r}-${i}-${tick}`} className="font-mono">
							<span className="mr-1 text-muted">#{i + 1}</span>
							{new Date(r).toLocaleString()}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}