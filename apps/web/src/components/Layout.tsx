import { NavLink, Outlet } from "react-router-dom";
import { Settings as SettingsIcon, Plus, Folder, MessageSquare, MoreHorizontal, Pin, FolderOpen, Trash2 } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { StatusDot, ThemeToggle, Button } from "./ui";
import { BrandIcon } from "./BrandIcon";
import { cn } from "@/lib/utils";
import { deleteWorkspace, revealWorkspace } from "@/lib/transport";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";

const PINNED_KEY = "pizza:pinned-workspaces";

function getPinnedWorkspaces(): Set<string> {
	try {
		const raw = localStorage.getItem(PINNED_KEY);
		if (raw) return new Set(JSON.parse(raw) as string[]);
	} catch { /* ignore */ }
	return new Set();
}

function setPinnedWorkspaces(ids: Set<string>): void {
	try {
		localStorage.setItem(PINNED_KEY, JSON.stringify([...ids]));
	} catch { /* ignore */ }
}

function WorkspaceMenu({ ws, isActive, onPin, isPinned, onDelete, onClose }: {
	ws: WorkspaceMeta;
	isActive: boolean;
	onPin: () => void;
	isPinned: boolean;
	onDelete: () => void;
	onClose: () => void;
}) {
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleClickOutside(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [onClose]);

	return (
		<div
			ref={menuRef}
			className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-surface-2 shadow-lg"
			onClick={(e) => e.stopPropagation()}
		>
			<button
				onClick={() => { onPin(); onClose(); }}
				className="flex w-full items-center gap-2 rounded-t-md px-3 py-2 text-left font-mono text-xs text-fg hover:bg-accent/10 hover:text-accent transition-colors"
			>
				<Pin className={cn("h-3.5 w-3.5 shrink-0", isPinned ? "text-accent" : "text-muted")} />
				<span>{isPinned ? "Unpin" : "Pin to top"}</span>
			</button>
			<button
				onClick={() => { void revealWorkspace(ws.cwd); onClose(); }}
				className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs text-fg hover:bg-accent/10 hover:text-accent transition-colors"
			>
				<FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted" />
				<span>Reveal in files</span>
			</button>
			<button
				onClick={() => { onDelete(); onClose(); }}
				className="flex w-full items-center gap-2 rounded-b-md px-3 py-2 text-left font-mono text-xs text-danger hover:bg-danger/10 transition-colors"
			>
				<Trash2 className="h-3.5 w-3.5 shrink-0" />
				<span>Delete</span>
			</button>
		</div>
	);
}

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

const MAIN_CHAT_CWD = "~/.pizza/main";

function isMainChatCwd(cwd: string | null | undefined): boolean {
	if (!cwd) return false;
	if (cwd === MAIN_CHAT_CWD) return true;
	// Match expanded path like /Users/tom/.pizza/main
	return cwd.endsWith("/.pizza/main");
}

export default function Layout({
	state,
	sidecarReady,
	sidecarExitCode,
	workspace,
	workspaces,
	onSelectWorkspace,
	onNewWorkspace,
	onDeleteWorkspace,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
	workspace?: string | null;
	workspaces?: WorkspaceMeta[];
	onSelectWorkspace?: (cwd: string) => void;
	onNewWorkspace?: () => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
}) {
	const online = sidecarReady && sidecarExitCode === null;
	const isMainChat = isMainChatCwd(workspace);
	const [pinned, setPinned] = useState<Set<string>>(getPinnedWorkspaces);
	const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

	const togglePin = useCallback((ws: WorkspaceMeta) => {
		setPinned((prev) => {
			const next = new Set(prev);
			if (next.has(ws.workspace_id)) {
				next.delete(ws.workspace_id);
			} else {
				next.add(ws.workspace_id);
			}
			setPinnedWorkspaces(next);
			return next;
		});
	}, []);

	const handleDelete = useCallback(async (ws: WorkspaceMeta) => {
		const name = basename(ws.cwd);
		if (!confirm(`Delete workspace "${name}"?\nThis removes the workspace metadata. The project files are not affected.`)) return;
		try {
			await deleteWorkspace(ws.workspace_id);
			onDeleteWorkspace?.(ws.workspace_id);
		} catch (e) {
			console.error("[workspace] delete error:", e);
			alert(`Failed to delete workspace: ${e}`);
		}
	}, [onDeleteWorkspace]);

	const sortedWorkspaces = workspaces
		? [...workspaces].sort((a, b) => {
			const aPinned = pinned.has(a.workspace_id);
			const bPinned = pinned.has(b.workspace_id);
			if (aPinned !== bPinned) return aPinned ? -1 : 1;
			return b.last_accessed_at - a.last_accessed_at;
		})
		: [];

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
							Create together.
						</div>
					</div>
				</div>

				{/* Main chat — persistent agent */}
				<div className="px-3 pt-2 pb-1">
					<button
						onClick={() => onSelectWorkspace?.(MAIN_CHAT_CWD)}
						className={cn(
							"flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors",
							isMainChat
								? "border-accent bg-accent/10"
								: "border-transparent hover:bg-surface-2",
						)}
						title="Persistent agent at ~/.pizza/main"
					>
						<MessageSquare
							className={cn(
								"h-4 w-4 shrink-0",
								isMainChat ? "text-accent" : "text-muted",
							)}
						/>
						<div className="min-w-0 flex-1">
							<div
								className={cn(
									"truncate font-mono text-xs font-bold uppercase tracking-wide",
									isMainChat ? "text-accent" : "text-fg",
								)}
							>
								Chat
							</div>
							<div className="truncate font-mono text-[10px] text-muted">
								always-on assistant
							</div>
						</div>
						{isMainChat && online && (
							<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
						)}
					</button>
				</div>

				{/* Workspaces section */}
				<div className="flex-1 overflow-y-auto px-3 py-2">
					<div className="mb-1 flex items-center justify-between px-2">
						<span className="font-mono text-[10px] uppercase tracking-widest text-muted">
							Workspaces
						</span>
						{isTauri() && (
							<button
								onClick={() => onNewWorkspace?.()}
								className="text-muted hover:text-accent transition-colors"
								title="New workspace"
							>
								<Plus className="h-3.5 w-3.5" />
							</button>
						)}
					</div>
					{sortedWorkspaces.length > 0 ? (
						<div className="space-y-0.5">
							{sortedWorkspaces.map((ws) => {
								const isActive = workspace === ws.cwd;
								const isPinned = pinned.has(ws.workspace_id);
								const isMenuOpen = menuOpenId === ws.workspace_id;
								return (
									<div key={ws.workspace_id} className="group relative">
										<div
											onClick={() => onSelectWorkspace?.(ws.cwd)}
											className={cn(
												"flex w-full cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
												isActive
													? "border-accent bg-accent/10"
													: "border-transparent hover:bg-surface-2",
											)}
											title={ws.cwd}
										>
											{isPinned ? (
												<Pin className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-accent" : "text-muted")} />
											) : (
												<Folder className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-accent" : "text-muted")} />
											)}
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
											<button
												onClick={(e) => {
													e.stopPropagation();
													setMenuOpenId(isMenuOpen ? null : ws.workspace_id);
												}}
												className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:text-fg hover:bg-surface-3 group-hover:opacity-100"
												title="More actions"
											>
												<MoreHorizontal className="h-3.5 w-3.5" />
											</button>
										</div>
										{isMenuOpen && (
											<WorkspaceMenu
												ws={ws}
												isActive={isActive}
												onPin={() => togglePin(ws)}
												isPinned={isPinned}
												onDelete={() => void handleDelete(ws)}
												onClose={() => setMenuOpenId(null)}
											/>
										)}
									</div>
								);
							})}
						</div>
					) : (
						<div className="px-2 py-4 text-center">
							<p className="font-mono text-[10px] text-muted">No workspaces yet</p>
						</div>
					)}
				</div>

				{isTauri() && (
					<div className="mb-2 px-1">
						<Button tone="neutral" size="sm" iconLeft={<Plus className="h-3.5 w-3.5" />} onClick={() => onNewWorkspace?.()} className="w-full">New Workspace</Button>
					</div>
				)}

				<div className="border-t border-border px-3 py-3">

					<div className="flex items-center justify-between rounded-md px-2 py-1.5">
						<div className="flex items-center gap-2 font-mono text-xs">
							{online && state?.isStreaming ? (
								<span className="h-2 w-2 shrink-0 rounded-full bg-accent animate-pulse" />
							) : (
								<StatusDot tone={online ? "success" : "danger"} />
							)}
							<span className="uppercase tracking-wide text-fg">
								{online ? (state?.isStreaming ? "running" : "online") : "offline"}
							</span>
						</div>
						<div className="flex items-center gap-1">
							<NavLink to="/settings" className={({ isActive }) => cn("flex items-center justify-center rounded-md p-1.5 transition-colors", isActive ? "text-accent" : "text-muted hover:text-fg")} title="Settings"><SettingsIcon className="h-4 w-4" /></NavLink>
							<ThemeToggle />
						</div>
					</div>
				</div>
			</aside>

			<main className="flex-1 overflow-y-auto">
				<Outlet />
			</main>
		</div>
	);
}
