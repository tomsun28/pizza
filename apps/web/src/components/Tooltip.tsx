import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";

/**
 * Minimal zero-dependency tooltip: a styled label that appears under the
 * wrapped element on hover (CSS group-hover, no delay — unlike native
 * `title` on macOS which lags ~1s and is easy to miss). Positioned above
 * by default; pass `side="bottom"` when the trigger sits near the viewport
 * top edge.
 *
 * Usage: <Tooltip label="Do a thing"><button>…</button></Tooltip>
 */
export function Tooltip({
	label,
	children,
	side = "bottom",
	className,
}: {
	label: string;
	children: ReactNode;
	/** Which side of the trigger the bubble appears on. */
	side?: "top" | "bottom";
	/** Extra classes for the outer wrapper. */
	className?: string;
}) {
	return (
		<span className={cn("group/tt relative inline-flex", className)}>
			{children}
			<span
				role="tooltip"
				className={cn(
					"pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-fg opacity-0 shadow-md transition-opacity duration-100",
					Z.menu,
					"group-hover/tt:opacity-100",
					side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
				)}
			>
				{label}
			</span>
		</span>
	);
}