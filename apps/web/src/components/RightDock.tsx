import { useTranslation } from "react-i18next";
import { GitBranch, Activity, FolderTree } from "lucide-react";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";
import BranchTreeExplorer from "@/views/BranchTreeExplorer";
import EventTimeline from "@/views/EventTimeline";
import FileExplorer from "@/views/FileExplorer";

export type RightDockTab = "files" | "history" | "timeline";

/**
 * The right-hand dock hosting the History (branch tree) and Timeline (event
 * stream) tabs. Scoped to the active workspace — its children refetch/reset
 * when `workspace` changes.
 */
export default function RightDock({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [tab, setTab] = usePersistedState<RightDockTab>("right-dock-tab", "files");

	const tabs: Array<{ id: RightDockTab; label: string; icon: typeof GitBranch }> = [
		{ id: "files", label: t("files.title"), icon: FolderTree },
		{ id: "history", label: t("history.title"), icon: GitBranch },
		{ id: "timeline", label: t("timeline.title"), icon: Activity },
	];

	return (
		<div className="flex h-full flex-col border-l border-border bg-surface">
			{/* Tab strip. Left-padded so it clears the floating dock toggle buttons. */}
			<div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2 pr-24">
				{tabs.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						onClick={() => setTab(id)}
						className={cn(
							"flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors",
							tab === id
								? "bg-accent/10 text-accent"
								: "text-muted hover:bg-surface-2 hover:text-fg",
						)}
						title={label}
					>
						<Icon className="h-3.5 w-3.5" />
						<span>{label}</span>
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1">
				{tab === "files" ? (
					<FileExplorer workspace={workspace} />
				) : tab === "history" ? (
					<BranchTreeExplorer workspace={workspace} />
				) : (
					<EventTimeline workspace={workspace} />
				)}
			</div>
		</div>
	);
}
