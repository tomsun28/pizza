import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TimeOfDay } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Editable list of HH:MM time points. Used by all visual schedule modes
 * (daily / weekdays / weekly / monthly) where a task can fire at multiple
 * specific times each day.
 *
 * - Empty input + Enter / Add button creates a new chip at 09:00 by default.
 * - Each chip has an inline X to remove.
 * - Validation: hour 0-23, minute 0-59; duplicates are auto-deduplicated
 *   (kept in insertion order).
 */
export function TimePointChips({
	value,
	onChange,
	placeholder = "09:00",
	className,
}: {
	value: TimeOfDay[];
	onChange: (next: TimeOfDay[]) => void;
	placeholder?: string;
	className?: string;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState("");

	const addFromDraft = () => {
		const m = /^(\d{1,2}):(\d{2})$/.exec(draft.trim());
		if (!m) return;
		const hour = Number(m[1]);
		const minute = Number(m[2]);
		if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;
		const next: TimeOfDay = { hour, minute };
		const exists = value.some((t) => t.hour === hour && t.minute === minute);
		if (exists) {
			setDraft("");
			return;
		}
		onChange([...value, next].sort((a, b) => a.hour - b.hour || a.minute - b.minute));
		setDraft("");
	};

	const remove = (idx: number) => {
		onChange(value.filter((_, i) => i !== idx));
	};

	return (
		<div className={cn("flex flex-wrap items-center gap-1.5", className)}>
			{value.map((time, i) => (
				<span
					key={`${time.hour}-${time.minute}-${i}`}
					className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-fg"
				>
					<span className="font-mono">
						{String(time.hour).padStart(2, "0")}:{String(time.minute).padStart(2, "0")}
					</span>
					<button
						type="button"
						onClick={() => remove(i)}
						className="ml-0.5 text-muted hover:text-danger"
						title={t("common.remove")}
					>
						<X className="h-3 w-3" />
					</button>
				</span>
			))}
			<div className="inline-flex items-center gap-1">
				<input
					type="text"
					value={draft}
					placeholder={placeholder}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							addFromDraft();
						}
					}}
					className="w-20 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
				/>
				<button
					type="button"
					onClick={addFromDraft}
					className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-muted hover:bg-surface-2 hover:text-fg"
					title={t("schedule.addTime")}
				>
					<Plus className="h-3 w-3" />
				</button>
			</div>
		</div>
	);
}