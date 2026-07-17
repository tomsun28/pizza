import { NavLink, Outlet } from "react-router-dom";
import { MessageSquare, Settings as SettingsIcon, Plus, FolderOpen, Folder } from "lucide-react";
import { StatusDot, ThemeToggle, Button } from "./ui";
import { BrandIcon } from "./BrandIcon";
import { cn } from "@/lib/utils";
import { newWorkspace } from "@/lib/transport";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function basename(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}

function timeAgo(ts: number): string {
	const diff = Date.now() - ts;
	const min = Math.floor(diff / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const days = Math.floor(hr / 24);
	return `${days}d ago`;
}

export default function Layout({
	state,
	sidecarReady,
	sidecarExitCode,
	workspace,
	workspaces,
	onSelectWorkspace,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
	workspace?: string | null;
	workspaces?: WorkspaceMeta[];
	onSelectWorkspace?: (cwd: string) => void;
}) {
	const online = sidecarReady && sidecarExitCode === null;

	return (
		<div className="flex h-full bg-bg">
			<aside className="flex w-64 flex-col border-r border-border bg-surface">
				<div
					data-tauri-drag-region
					className="flex items-center gap-3 px-5 pb-2 pt-10"
				>
					<BrandIcon size={28} className="shrink-0 text-accent" />
					<div className="leading-tight" data-tauri-drag-region>
						<div
							data-tauri-drag-region
							className="font-mono text-sm font-bold uppercase tracking-widest text-fg"
						>
							pizza
						</div>
						<div
							data-tauri-drag-region
							className="font-mono text-[10px] uppercase tracking-widest text-muted"
						>
							agent gui
						</div>
					</div>
				</div>

				{/* Workspaces section */}
				<div className="flex-1 overflow-y-auto px-3 py-2">
					<div className="mb-1 flex items-center justify-between px-2">
						<span className="font-mono text-[10px] uppercase tracking-widest text-muted">
							Workspaces
						</span>
						{isTauri() && (
							<button
								onClick={() => newWorkspace()}
								className="text-muted hover:text-accent transition-colors"
								title="New workspace"
							>
								<Plus className="h-3.5 w-3.5" />
							</button>
						)}
					</div>
					{workspaces && workspaces.length > 0 ? (
						<div className="space-y-0.5">
							{workspaces.map((ws) => {
								const isActive = workspace === ws.cwd;
								return (
									<button
										key={ws.workspace_id}
										onClick={() => onSelectWorkspace?.(ws.cwd)}
										className={cn(
											"flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
											isActive
												? "border-accent bg-accent/10"
												: "border-transparent hover:bg-surface-2",
										)}
										title={ws.cwd}
									>
										<Folder
											className={cn(
												"h-3.5 w-3.5 shrink-0",
												isActive ? "text-accent" : "text-muted",
											)}
										/>
										<div className="min-w-0 flex-1">
											<div
												className={cn(
													"truncate font-mono text-xs",
													isActive ? "text-accent" : "text-fg",
												)}
											>
												{basename(ws.cwd)}
											</div>
											<div className="truncate font-mono text-[10px] text-muted">
												{timeAgo(ws.last_accessed_at)}
											</div>
										</div>
										{isActive && online && (
											<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
										)}
									</button>
								);
							})}
						</div>
					) : (
						<div className="px-2 py-4 text-center">
							<p className="font-mono text-[10px] text-muted">No workspaces yet</p>
						</div>
					)}
				</div>

				{/* Nav: chat + settings */}
				<div className="space-y-1 px-3 py-1">
					<NavLink
						to="/"
						className={({ isActive }) =>
							cn(
								"flex items-center gap-3 rounded-md border px-3 py-2 font-mono text-sm uppercase tracking-wide transition-colors",
								isActive
									? "border-accent bg-accent/10 text-accent"
									: "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
							)
						}
					>
						<MessageSquare className="h-4 w-4" />
						chat
					</NavLink>
					<NavLink
						to="/settings"
						className={({ isActive }) =>
							cn(
								"flex items-center gap-3 rounded-md border px-3 py-2 font-mono text-sm uppercase tracking-wide transition-colors",
								isActive
									? "border-accent bg-accent/10 text-accent"
									: "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
							)
						}
					>
						<SettingsIcon className="h-4 w-4" />
						settings
					</NavLink>
				</div>

				<div className="border-t border-border px-3 py-3">
					{workspace && (
						<div className="mb-2 flex items-center gap-2 rounded-md px-2 py-1.5">
							<FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" />
							<span className="truncate font-mono text-xs text-muted" title={workspace}>
								{basename(workspace)}
							</span>
						</div>
					)}
					<div className="flex items-center justify-between rounded-md px-2 py-1.5">
						<div className="flex items-center gap-2 font-mono text-xs">
							<StatusDot tone={online ? "success" : "danger"} />
							<span className="uppercase tracking-wide text-fg">
								{online ? "online" : "offline"}
							</span>
						</div>
						<div className="flex items-center gap-1">
							<ThemeToggle />
						</div>
					</div>
					{state?.model && (
						<div className="mt-1 px-2 font-mono text-[10px] uppercase tracking-widest text-muted">
							{state.model.provider}/{state.model.id}
						</div>
					)}
				</div>
			</aside>

			<main className="flex-1 overflow-y-auto">
				<Outlet />
			</main>
		</div>
	);
}
