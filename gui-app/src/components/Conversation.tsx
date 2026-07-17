import { cn } from "@/lib/utils";

export interface TimelineItem {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	title: string;
	text: string;
	status: string;
	streaming?: boolean;
}

export function Conversation({
	items,
	sidecarReady,
	sidecarExitCode,
}: {
	items: TimelineItem[];
	sidecarReady: boolean;
	sidecarExitCode: number | null;
}) {
	if (items.length === 0) {
		return (
			<div className="flex min-h-[calc(100vh-200px)] flex-col items-center justify-center gap-4 text-center text-muted">
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-3xl space-y-3 px-6 pb-32 pt-6">
			{items.map((item) => (
				<div
					key={item.id}
					className={cn(
						"rounded-lg border overflow-hidden",
						item.role === "user"
							? "border-accent/30 bg-accent/5"
							: item.role === "tool"
								? "border-border bg-surface-2/50"
								: "border-border bg-surface",
					)}
				>
					<div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
						<span className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wide text-fg">
							{item.title}
						</span>
						<span className="font-mono text-[10px] uppercase tracking-widest text-muted">
							{item.status}
						</span>
					</div>
					<div
						className={cn(
							"px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words",
							item.streaming && "after:content-['▋'] after:ml-0.5 after:text-accent after:animate-pulse",
						)}
					>
						{item.text || (item.streaming ? "" : "")}
					</div>
				</div>
			))}
		</div>
	);
}
