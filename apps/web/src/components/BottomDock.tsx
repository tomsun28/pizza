import { useTranslation } from "react-i18next";
import { TerminalSquare, ChevronDown } from "lucide-react";
import Terminal from "./Terminal";

/**
 * The bottom dock hosting the Terminal, scoped to the active workspace.
 * Collapsing is owned by the parent (WorkspacePane); this renders the
 * expanded body with a header that can request collapse.
 */
export default function BottomDock({
	workspace,
	ptyPort,
	onCollapse,
}: {
	workspace?: string | null;
	ptyPort?: number;
	onCollapse: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex h-full flex-col border-t border-border bg-bg">
			<div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-3">
				<div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-muted">
					<TerminalSquare className="h-3.5 w-3.5" />
					<span>{t("terminal.title")}</span>
				</div>
				<button
					onClick={onCollapse}
					className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg"
					title={t("terminal.collapse")}
				>
					<ChevronDown className="h-3.5 w-3.5" />
				</button>
			</div>
			<div className="min-h-0 flex-1">
				<Terminal workspace={workspace} ptyPort={ptyPort} />
			</div>
		</div>
	);
}
