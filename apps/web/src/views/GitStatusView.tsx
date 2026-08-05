import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	GitBranch,
	GitCommitHorizontal,
	ArrowUp,
	ArrowDown,
	RefreshCw,
	X,
	Copy,
	ExternalLink,
	WrapText,
	ChevronDown,
	ChevronRight,
	FilePen,
	FilePlus,
	FileMinus,
	FileQuestion,
	FileSymlink,
} from "lucide-react";
import {
	gitStatus,
	gitDiff,
	openInEditor,
	type GitStatusSummary,
	type GitStatusEntry,
	type GitDiffMode,
} from "@/lib/transport";
import { EmptyState, ErrorBanner, Spinner, IconButton } from "@/components/ui";
import { DiffViewer } from "@/components/DiffViewer";
import { ResizeHandle } from "@/components/ResizeHandle";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";

/** Bounds for the draggable status-list / diff split, in px. */
const DIFF_MIN = 140;
const DIFF_MAX = 900;

/** A status entry paired with the diff mode its group implies. */
interface Selection {
	path: string;
	mode: GitDiffMode;
}

/**
 * Git view for the right-dock "Git" tab. The header shows the branch, upstream
 * tracking state and HEAD commit; below it the working tree is grouped into
 * Staged / Changes / Untracked, and selecting a file opens its diff in a
 * resizable pane. Scoped to `workspace` (cwd) — reloads on workspace change.
 */
export default function GitStatusView({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [summary, setSummary] = useState<GitStatusSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [selection, setSelection] = useState<Selection | null>(null);
	const [diff, setDiff] = useState("");
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState("");
	const [diffHeight, setDiffHeight] = usePersistedState<number>("git-diff-height", 340);
	const [wrap, setWrap] = usePersistedState<boolean>("git-diff-wrap", false);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	const cwd = workspace ?? "";

	const clampDiff = useCallback((next: number) => {
		const max = Math.min(DIFF_MAX, Math.max(DIFF_MIN, window.innerHeight - 200));
		setDiffHeight(Math.min(max, Math.max(DIFF_MIN, next)));
	}, [setDiffHeight]);

	const load = useCallback(async () => {
		if (!cwd) {
			setSummary(null);
			setLoading(false);
			return;
		}
		try {
			setError("");
			setSummary(await gitStatus(cwd));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		setLoading(true);
		setSummary(null);
		setSelection(null);
		setDiff("");
		void load();
	}, [cwd, load]);

	const openDiff = useCallback(
		async (path: string, mode: GitDiffMode) => {
			if (!cwd) return;
			setSelection({ path, mode });
			setDiff("");
			setDiffError("");
			setDiffLoading(true);
			try {
				setDiff(await gitDiff(cwd, path, mode));
			} catch (e) {
				setDiffError(e instanceof Error ? e.message : String(e));
			} finally {
				setDiffLoading(false);
			}
		},
		[cwd],
	);

	// Re-fetch the open diff after a refresh so it never shows stale content.
	const refresh = useCallback(async () => {
		await load();
		if (selection) await openDiff(selection.path, selection.mode);
	}, [load, selection, openDiff]);

	// Group into staged / unstaged / untracked. An entry can appear in both the
	// staged and unstaged groups (e.g. "MM" — staged edit plus further edits).
	const groups = useMemo(() => {
		const staged: GitStatusEntry[] = [];
		const unstaged: GitStatusEntry[] = [];
		const untracked: GitStatusEntry[] = [];
		for (const e of summary?.entries ?? []) {
			if (e.xy === "??") {
				untracked.push(e);
				continue;
			}
			const [x, y] = [e.xy.charCodeAt(0), e.xy.charCodeAt(1)];
			if (x !== 32 && x !== 63) staged.push(e); // X is not ' ' or '?'
			if (y !== 32 && y !== 63) unstaged.push(e); // Y is not ' ' or '?'
		}
		return [
			{ key: "staged", label: t("git.staged"), mode: "staged" as GitDiffMode, entries: staged },
			{ key: "unstaged", label: t("git.unstaged"), mode: "worktree" as GitDiffMode, entries: unstaged },
			{ key: "untracked", label: t("git.untracked"), mode: "untracked" as GitDiffMode, entries: untracked },
		].filter((g) => g.entries.length > 0);
	}, [summary, t]);

	// Repo-wide totals for the header stat badge.
	const totals = useMemo(() => {
		let added = 0;
		let removed = 0;
		for (const e of summary?.entries ?? []) {
			added += e.additions ?? 0;
			removed += e.deletions ?? 0;
		}
		return { added, removed };
	}, [summary]);

	const toggleGroup = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const clean = !!summary && summary.entries.length === 0;

	return (
		<div className="flex h-full flex-col">
			{/* Branch bar */}
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
				<GitBranch className="h-3.5 w-3.5 shrink-0 text-accent" />
				<span className="min-w-0 truncate font-mono text-xs text-fg" title={summary?.branch || undefined}>
					{summary?.branch || t("git.detached")}
				</span>
				{summary?.ahead ? (
					<span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-accent" title={t("git.ahead")}>
						<ArrowUp className="h-3 w-3" />
						{summary.ahead}
					</span>
				) : null}
				{summary?.behind ? (
					<span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-warning" title={t("git.behind")}>
						<ArrowDown className="h-3 w-3" />
						{summary.behind}
					</span>
				) : null}
				{summary?.upstream && (
					<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted" title={summary.upstream}>
						{summary.upstream}
					</span>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					<DiffStatBadge added={totals.added} removed={totals.removed} />
					<IconButton onClick={() => void refresh()} title={t("git.refresh")}>
						<RefreshCw className="h-3.5 w-3.5" />
					</IconButton>
				</div>
			</div>

			{/* HEAD commit */}
			{summary?.head && (
				<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2/40 px-3 py-1.5 font-mono text-[10px] text-muted">
					<GitCommitHorizontal className="h-3 w-3 shrink-0" />
					<span className="shrink-0 text-fg">{summary.head}</span>
					<span className="min-w-0 truncate" title={summary.head_subject}>{summary.head_subject}</span>
				</div>
			)}

			{error && <div className="px-3 pt-2"><ErrorBanner message={error} /></div>}

			{/* Status list */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<div className="flex h-full items-center justify-center"><Spinner /></div>
				) : clean ? (
					<div className="p-4">
						<EmptyState title={t("git.cleanTitle")} description={t("git.cleanDescription")} />
					</div>
				) : (
					groups.map((group) => (
						<StatusGroup
							key={group.key}
							label={group.label}
							count={group.entries.length}
							entries={group.entries}
							collapsed={collapsed.has(group.key)}
							onToggle={() => toggleGroup(group.key)}
							selection={selection}
							mode={group.mode}
							onSelect={(path) => void openDiff(path, group.mode)}
						/>
					))
				)}
			</div>

			{/* Diff pane — draggable split against the list above. */}
			{selection && (
				<>
					<ResizeHandle
						orientation="horizontal"
						invert
						getSize={() => diffHeight}
						onResize={clampDiff}
						className="border-t border-border"
					/>
					<div className="flex shrink-0 flex-col" style={{ height: diffHeight }}>
						<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2/40 px-2 py-1.5">
							<span className="min-w-0 truncate font-mono text-[11px] text-fg" title={selection.path}>
								{selection.path.split("/").pop()}
							</span>
							<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
								{selection.path.includes("/") ? selection.path.slice(0, selection.path.lastIndexOf("/")) : ""}
							</span>
							<span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted">
								{t(`git.mode.${selection.mode}`)}
							</span>
							<IconButton onClick={() => setWrap((v) => !v)} title={t("files.toggleWrap")} active={wrap}>
								<WrapText className="h-3.5 w-3.5" />
							</IconButton>
							<IconButton onClick={() => void navigator.clipboard?.writeText(diff)} title={t("common.copy")}>
								<Copy className="h-3.5 w-3.5" />
							</IconButton>
							<IconButton
								onClick={() => openInEditor(cwd, selection.path).catch((e) => console.error("openInEditor failed:", e))}
								title={t("files.openInEditor")}
							>
								<ExternalLink className="h-3.5 w-3.5" />
							</IconButton>
							<IconButton onClick={() => { setSelection(null); setDiff(""); setDiffError(""); }} title={t("git.closeDiff")}>
								<X className="h-3.5 w-3.5" />
							</IconButton>
						</div>
						<div className="min-h-0 flex-1">
							{diffLoading ? (
								<div className="flex h-full items-center justify-center bg-bg"><Spinner /></div>
							) : diffError ? (
								<div className="bg-bg p-3"><ErrorBanner message={diffError} /></div>
							) : diff ? (
								<DiffViewer text={diff} wrap={wrap} />
							) : (
								<div className="h-full bg-bg p-3 font-mono text-[11px] text-muted">{t("git.noDiff")}</div>
							)}
						</div>
					</div>
				</>
			)}
		</div>
	);
}

/** Compact "+N −M" badge; renders nothing when there is no change to show. */
function DiffStatBadge({ added, removed }: { added: number; removed: number }) {
	if (added === 0 && removed === 0) return null;
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
			{added > 0 && <span className="text-success">+{added}</span>}
			{removed > 0 && <span className="text-danger">−{removed}</span>}
		</span>
	);
}

function StatusGroup({
	label,
	count,
	entries,
	collapsed,
	onToggle,
	selection,
	mode,
	onSelect,
}: {
	label: string;
	count: number;
	entries: GitStatusEntry[];
	collapsed: boolean;
	onToggle: () => void;
	selection: Selection | null;
	mode: GitDiffMode;
	onSelect: (path: string) => void;
}) {
	return (
		<div>
			{/* Sticky group header so the section stays identifiable while scrolling. */}
			<button
				onClick={onToggle}
				className="sticky top-0 z-10 flex w-full items-center gap-1 bg-surface px-2 py-1 text-left font-mono text-[10px] uppercase tracking-wide text-muted transition-colors hover:text-fg"
			>
				{collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
				<span>{label}</span>
				<span className="rounded bg-surface-2 px-1 text-[9px] normal-case">{count}</span>
			</button>
			{!collapsed && (
				<ul>
					{entries.map((e) => (
						<StatusRow
							key={`${mode}-${e.path}`}
							entry={e}
							selected={selection?.path === e.path && selection.mode === mode}
							onSelect={() => onSelect(e.path)}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function StatusRow({
	entry,
	selected,
	onSelect,
}: {
	entry: GitStatusEntry;
	selected: boolean;
	onSelect: () => void;
}) {
	const { Icon, color, code } = describeStatus(entry.xy);
	const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
	const name = entry.path.split("/").pop() ?? entry.path;
	return (
		<li
			onClick={onSelect}
			className={cn(
				"flex cursor-pointer items-center gap-1.5 px-2 py-1 font-mono text-xs transition-colors hover:bg-surface-2",
				selected && "bg-accent/10",
			)}
			title={entry.orig_path ? `${entry.orig_path} → ${entry.path}` : entry.path}
		>
			<Icon className={cn("h-3.5 w-3.5 shrink-0", color)} />
			{/* Filename gets priority; the directory is de-emphasised and is the
			    first thing to be truncated in a narrow dock (full path in title). */}
			<span className="shrink-0 text-fg">{name}</span>
			<span className="min-w-0 flex-1 truncate text-[10px] text-muted">{dir}</span>
			<DiffStatBadge added={entry.additions ?? 0} removed={entry.deletions ?? 0} />
			<span className={cn("w-4 shrink-0 text-right text-[10px]", color)}>{code}</span>
		</li>
	);
}

/**
 * Map a porcelain status code to an icon, color and single-letter label.
 * The letter is shown alongside the icon so status is never conveyed by
 * color alone.
 */
function describeStatus(xy: string): { Icon: typeof FilePen; color: string; code: string } {
	if (xy === "??") return { Icon: FileQuestion, color: "text-muted", code: "U" };
	// The interesting code is whichever of X/Y is not a space.
	const code = xy[0] !== " " ? xy[0]! : xy[1]!;
	switch (code) {
		case "A": return { Icon: FilePlus, color: "text-success", code: "A" };
		case "D": return { Icon: FileMinus, color: "text-danger", code: "D" };
		case "R": return { Icon: FileSymlink, color: "text-accent", code: "R" };
		case "C": return { Icon: FileSymlink, color: "text-accent", code: "C" };
		case "U": return { Icon: FileQuestion, color: "text-warning", code: "!" };
		default: return { Icon: FilePen, color: "text-warning", code: "M" };
	}
}
