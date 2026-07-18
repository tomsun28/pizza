import { cn } from "@/lib/utils";

export interface TimelineItem {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	title: string;
	text: string;
	status: string;
	streaming?: boolean;
	toolName?: string;
	toolArgs?: string;
	toolResult?: string;
	isError?: boolean;
	/** Attached images as data URLs (for user messages). */
	images?: string[];
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
								? cn("border-border bg-surface-2/50", item.isError && "border-danger/30")
								: "border-border bg-surface",
					)}
				>
					<div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
						<span className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wide text-fg">
							{item.title}
						</span>
						<span className={cn("font-mono text-[10px] uppercase tracking-widest", item.isError ? "text-danger" : "text-muted")}>
							{item.status}
						</span>
					</div>
					{item.role === "tool" ? (
						<div className="px-4 py-3 text-sm leading-relaxed">
							{item.toolArgs && (
								<div className="mb-2 rounded-md bg-bg/50 px-3 py-2 font-mono text-xs text-muted whitespace-pre-wrap break-words">
									{item.toolArgs}
								</div>
							)}
							{item.toolResult && (
								<div className={cn("rounded-md px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words", item.isError ? "bg-danger/5 text-danger" : "bg-bg/50 text-muted")}>
									{item.toolResult}
								</div>
							)}
							{item.streaming && !item.toolResult && (
								<span className="text-accent animate-pulse">running...</span>
							)}
						</div>
					) : (
						<div className="px-4 py-3">
							{item.images && item.images.length > 0 && (
								<div className="mb-2 flex flex-wrap gap-2">
									{item.images.map((src, i) => (
										<img
											key={i}
											src={src}
											alt="attachment"
											className="max-h-48 rounded-md border border-border object-contain"
										/>
									))}
								</div>
							)}
							{(item.text || item.streaming) && (
								<div
									className={cn(
										"text-sm leading-relaxed whitespace-pre-wrap break-words",
										item.streaming && "after:content-['▋'] after:ml-0.5 after:text-accent after:animate-pulse",
									)}
								>
									{item.text}
								</div>
							)}
						</div>
					)}
				</div>
			))}
		</div>
	);
}
