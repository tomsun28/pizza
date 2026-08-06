/**
 * Mention popup — shown when the user types `@` in the composer textarea.
 * Lists categorised items (files, branches, workspaces, skills, scheduled
 * tasks) that can be inserted as references into the message.
 *
 * The Composer owns the data fetching and the `@` detection; this component
 * is purely presentational: it renders a filtered, keyboard-navigable list
 * and calls `onSelect` when the user picks an item.
 */
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	File as FileIcon,
	GitBranch,
	FolderOpen,
	Sparkles,
	Clock,
	Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type MentionCategory = "file" | "branch" | "workspace" | "skill" | "schedule";

export interface MentionItem {
	category: MentionCategory;
	/** Primary display label. */
	label: string;
	/** Secondary text (path, description, etc.). */
	description?: string;
	/** Value inserted into the textarea on selection. */
	insertText: string;
	/** For file mentions: the absolute path to attach as a file reference. */
	absolutePath?: string;
}

interface MentionMenuProps {
	/** All items gathered by the Composer, across every category. */
	items: MentionItem[];
	/** The active filter query (text after `@`). */
	query: string;
	/** Currently selected index (controlled). */
	selectedIndex: number;
	/** Called when the user picks an item (click or Enter). */
	onSelect: (item: MentionItem) => void;
	/** Called when the user navigates with arrow keys. */
	onNavigate: (index: number) => void;
	/** Called when the user dismisses the menu (Escape / outside click). */
	onClose: () => void;
}

const CATEGORY_ICON: Record<MentionCategory, typeof FileIcon> = {
	file: FileIcon,
	branch: GitBranch,
	workspace: FolderOpen,
	skill: Sparkles,
	schedule: Clock,
};

const CATEGORY_KEY: Record<MentionCategory, string> = {
	file: "mention.files",
	branch: "mention.branches",
	workspace: "mention.workspaces",
	skill: "mention.skills",
	schedule: "mention.schedules",
};

export function MentionMenu({
	items,
	query,
	selectedIndex,
	onSelect,
	onNavigate,
	onClose,
}: MentionMenuProps) {
	const { t } = useTranslation();
	const listRef = useRef<HTMLDivElement>(null);

	// Filter items by the query (case-insensitive substring on label + description).
	const filtered = useMemo(() => {
		const q = query.toLowerCase().trim();
		if (!q) return items;
		return items.filter(
			(item) =>
				item.label.toLowerCase().includes(q) ||
				(item.description?.toLowerCase().includes(q) ?? false),
		);
	}, [items, query]);

	// Clamp the selected index whenever the filtered list changes.
	const clampedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

	// Scroll the selected item into view.
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const el = list.children[clampedIndex] as HTMLElement | undefined;
		el?.scrollIntoView({ block: "nearest" });
	}, [clampedIndex]);

	// Group items by category, preserving filtered order.
	const grouped = useMemo(() => {
		const map = new Map<MentionCategory, MentionItem[]>();
		for (const item of filtered) {
			const arr = map.get(item.category) ?? [];
			arr.push(item);
			map.set(item.category, arr);
		}
		return map;
	}, [filtered]);

	// Flat index → item map for keyboard navigation.
	const flatItems = filtered;

	// Handle keyboard events at the menu level (the Composer also forwards
	// arrow/enter/escape from the textarea, but this is a safety net for
	// when the menu itself has focus).
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				onNavigate(Math.min(clampedIndex + 1, flatItems.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				onNavigate(Math.max(clampedIndex - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				const item = flatItems[clampedIndex];
				if (item) onSelect(item);
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [clampedIndex, flatItems, onNavigate, onSelect, onClose]);

	if (flatItems.length === 0) {
		return (
			<div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl border border-border bg-surface p-3 shadow-xl">
				<div className="flex items-center gap-2 text-xs text-muted">
					<Search className="h-3.5 w-3.5" />
					<span>{t("mention.noResults")}</span>
				</div>
			</div>
		);
	}

	// Build a flat render list with category headers, tracking the running
	// flat index so we can highlight the selected item.
	let runningIndex = 0;

	return (
		<div
			ref={listRef}
			className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-80 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-xl"
		>
			{Array.from(grouped.entries()).map(([category, categoryItems]) => (
				<div key={category}>
					<div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted">
						{t(CATEGORY_KEY[category])}
					</div>
					{categoryItems.map((item) => {
						const idx = runningIndex++;
						const Icon = CATEGORY_ICON[item.category];
						const isSelected = idx === clampedIndex;
						return (
							<button
								key={`${item.category}:${item.label}`}
								type="button"
								onClick={() => onSelect(item)}
								onMouseEnter={() => onNavigate(idx)}
								className={cn(
									"flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
									isSelected ? "bg-surface-2" : "hover:bg-surface-2",
								)}
							>
								<Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-fg">{item.label}</span>
									{item.description && (
										<span className="block truncate text-[10px] text-muted">
											{item.description}
										</span>
									)}
								</span>
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}
