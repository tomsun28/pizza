import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Search, RefreshCw, GitFork, CornerUpRight, Pencil, Copy } from "lucide-react";
import {
	historyTreeList,
	historyTreeFork,
	historyTreeJump,
	historyTreeRename,
	subscribeEvents,
} from "@/lib/transport";
import type { RpcHistoryTreeNode } from "@/lib/types";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ContextMenu, type ContextMenuItem } from "@/components/ui";

interface ContextMenuState {
	node: RpcHistoryTreeNode;
	x: number;
	y: number;
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 12) : id;
}

function formatTime(ts: number): string {
	try {
		return new Date(ts).toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return "";
	}
}

/**
 * Branch Tree Explorer — git-graph style visualization of the session tree
 * for the active workspace. Data comes from the sidecar `history_tree` RPC.
 * Scoped to `workspace`: reloads on workspace change and on SESSION_* events.
 */
export default function BranchTreeExplorer({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [nodes, setNodes] = useState<RpcHistoryTreeNode[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const queryRef = useRef(query);
	queryRef.current = query;

	const load = useCallback(async (q?: string) => {
		try {
			setError("");
			const list = await historyTreeList(q ?? (queryRef.current || undefined));
			setNodes(list);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	// Reload on workspace change (data is workspace-scoped).
	useEffect(() => {
		setLoading(true);
		setNodes([]);
		setSelected(null);
		void load();
	}, [workspace, load]);

	// Auto-refresh when the session tree changes.
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const unlistenP = subscribeEvents((event) => {
			const typed = event as { type?: string; _cwd?: string };
			if (typed._cwd && workspace && typed._cwd !== workspace) return;
			if (
				typed.type === "SESSION_CREATED" ||
				typed.type === "SESSION_FORKED" ||
				typed.type === "SESSION_JUMPED"
			) {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => { if (!cancelled) void load(); }, 250);
			}
		});
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			unlistenP.then((fn) => fn()).catch(() => {});
		};
	}, [workspace, load]);

	// Debounced search.
	useEffect(() => {
		const timer = setTimeout(() => void load(query || undefined), 200);
		return () => clearTimeout(timer);
	}, [query, load]);

	// Dismiss context menu on any outside click / escape.
	useEffect(() => {
		if (!menu) return;
		const onDown = () => setMenu(null);
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	const onFork = useCallback(async (node: RpcHistoryTreeNode) => {
		setMenu(null);
		try { await historyTreeFork(node.session_id); await load(); }
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	}, [load]);

	const onJump = useCallback(async (node: RpcHistoryTreeNode) => {
		setMenu(null);
		try { await historyTreeJump(node.session_id); await load(); }
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	}, [load]);

	const onRename = useCallback(async (node: RpcHistoryTreeNode) => {
		setMenu(null);
		const name = window.prompt(t("history.renamePrompt"), node.name ?? "");
		if (name == null) return;
		try { await historyTreeRename(node.session_id, name); await load(); }
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	}, [load, t]);

	const activeNode = nodes.find((n) => n.is_active);

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("history.search")}
						className="w-full rounded-md border border-border bg-bg py-1 pl-7 pr-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
				</div>
				<button
					onClick={() => void load()}
					className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
					title={t("history.refresh")}
				>
					<RefreshCw className="h-3.5 w-3.5" />
				</button>
			</div>

			{error && <div className="px-3 pt-2"><ErrorBanner message={error} /></div>}

			{/* Tree */}
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{loading ? (
					<div className="flex h-full items-center justify-center"><Spinner /></div>
				) : nodes.length === 0 ? (
					<div className="p-4">
						<EmptyState
							title={t("history.emptyTitle")}
							description={query ? t("history.noMatch") : t("history.emptyDescription")}
						/>
					</div>
				) : (
					<ul className="font-mono text-xs">
						{nodes.map((node) => (
							<TreeRow
								key={node.session_id}
								node={node}
								selected={selected === node.session_id}
								onSelect={() => setSelected(node.session_id)}
								onContextMenu={(x, y) => setMenu({ node, x, y })}
							/>
						))}
					</ul>
				)}
			</div>

			{/* Breadcrumb */}
			{activeNode && (
				<div className="shrink-0 border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted">
					{t("history.position")}: {activeNode.name || shortId(activeNode.session_id)}
					{activeNode.depth > 0 ? ` · ${t("history.depth")} ${activeNode.depth}` : ` · ${t("history.root")}`}
				</div>
			)}

			{/* Context menu */}
			{menu && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					onDismiss={() => setMenu(null)}
					items={buildHistoryMenuItems(menu.node, t, {
						onJump: () => void onJump(menu.node),
						onFork: () => void onFork(menu.node),
						onRename: () => void onRename(menu.node),
						onCopyId: () => {
							void navigator.clipboard?.writeText(menu.node.session_id);
						},
					})}
				/>
			)}
		</div>
	);
}

function buildHistoryMenuItems(
	node: RpcHistoryTreeNode,
	t: (k: string) => string,
	handlers: { onJump: () => void; onFork: () => void; onRename: () => void; onCopyId: () => void },
): ContextMenuItem[] {
	return [
		{
			icon: CornerUpRight,
			label: t("history.jumpHere"),
			hint: node.is_active
				? undefined
				: node.closed
					? t("history.jumpClosedHint")
					: t("history.jumpOpenHint"),
			disabled: node.is_active,
			onClick: handlers.onJump,
		},
		{
			icon: GitFork,
			label: t("history.forkFromHere"),
			hint: t("history.forkHint"),
			onClick: handlers.onFork,
		},
		{
			icon: Pencil,
			label: t("history.rename"),
			onClick: handlers.onRename,
		},
		{
			icon: Copy,
			label: t("history.copyId"),
			onClick: handlers.onCopyId,
		},
	];
}

function TreeRow({
	node,
	selected,
	onSelect,
	onContextMenu,
}: {
	node: RpcHistoryTreeNode;
	selected: boolean;
	onSelect: () => void;
	onContextMenu: (x: number, y: number) => void;
}) {
	const indent = node.depth * 14;
	return (
		<li>
			<div
				onClick={onSelect}
				onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY); }}
				title={node.snippet}
				className={cn(
					"group flex cursor-pointer items-start gap-2 px-3 py-1.5 transition-colors",
					selected ? "bg-accent/10" : "hover:bg-surface-2",
				)}
				style={{ paddingLeft: 12 + indent }}
			>
				{/* Graph dot */}
				<span className="mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
					<span
						className={cn(
							"inline-block h-2 w-2 rounded-full",
							node.is_active
								? "bg-accent ring-2 ring-accent/30"
								: node.closed
									? "border border-muted bg-transparent"
									: "bg-muted",
						)}
					/>
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className={cn("truncate", node.is_active ? "font-bold text-accent" : "text-fg")}>
							{node.name || shortId(node.session_id)}
						</span>
						{node.is_active && (
							<span className="shrink-0 rounded bg-accent/15 px-1 text-[9px] uppercase tracking-wide text-accent">
								active
							</span>
						)}
						{!node.is_active && !node.closed && (
							<span className="shrink-0 rounded bg-success/15 px-1 text-[9px] uppercase tracking-wide text-success">
								open
							</span>
						)}
						{node.child_count > 0 && (
							<span className="shrink-0 text-[10px] text-muted">
								<GitBranch className="mr-0.5 inline h-2.5 w-2.5" />
								{node.child_count}
							</span>
						)}
						<span className="ml-auto shrink-0 text-[10px] text-muted">{formatTime(node.created_at)}</span>
					</div>
					{node.snippet && (
						<div className="truncate text-[10px] text-muted">↳ {node.snippet}</div>
					)}
				</div>
			</div>
		</li>
	);
}
