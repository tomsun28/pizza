import type { ReactNode } from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PanelRight, PanelBottom } from "lucide-react";
import { usePersistedState } from "@/lib/usePersistedState";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";
import { ResizeHandle } from "./ResizeHandle";
import RightDock from "./RightDock";
import BottomDock from "./BottomDock";

const RIGHT_MIN = 320;
const RIGHT_MAX_RATIO = 0.6;
const BOTTOM_MIN = 120;
const BOTTOM_MAX = 640;

/**
 * Wraps the routed main view (Chat) with a collapsible right dock
 * (History / Timeline) and a collapsible bottom dock (Terminal), plus the
 * top-right toggle buttons. All docks are scoped to the active workspace.
 */
export default function WorkspacePane({
	workspace,
	ptyPort,
	children,
}: {
	workspace?: string | null;
	ptyPort?: number;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	const [rightOpen, setRightOpen] = usePersistedState<boolean>("right-dock-open", true);
	const [rightWidth, setRightWidth] = usePersistedState<number>("right-dock-width", 420);
	const [bottomOpen, setBottomOpen] = usePersistedState<boolean>("bottom-dock-open", false);
	const [bottomHeight, setBottomHeight] = usePersistedState<number>("bottom-dock-height", 240);

	const clampRight = useCallback((next: number) => {
		const max = Math.max(RIGHT_MIN, window.innerWidth * RIGHT_MAX_RATIO);
		setRightWidth(Math.min(max, Math.max(RIGHT_MIN, next)));
	}, [setRightWidth]);

	const clampBottom = useCallback((next: number) => {
		setBottomHeight(Math.min(BOTTOM_MAX, Math.max(BOTTOM_MIN, next)));
	}, [setBottomHeight]);

	return (
		<div className="flex h-full flex-col">
			{/* Main row: routed view + right dock. */}
			<div className="flex min-h-0 flex-1">
				{/* The toggles float over the MAIN view's top-right corner (not the
				    whole pane) so they never overlap the right dock's tab strip. */}
				<div className="relative min-w-0 flex-1 overflow-hidden">
					<div className={cn("absolute right-2 top-2 flex items-center gap-1", Z.chrome)}>
						<button
							onClick={() => setBottomOpen((v) => !v)}
							className={cn(
								"flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-surface-2",
								bottomOpen ? "text-accent" : "text-muted/60 hover:text-muted",
							)}
							title={t("terminal.toggle")}
						>
							<PanelBottom className="h-4 w-4" />
						</button>
						<button
							onClick={() => setRightOpen((v) => !v)}
							className={cn(
								"flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-surface-2",
								rightOpen ? "text-accent" : "text-muted/60 hover:text-muted",
							)}
							title={t("dock.toggleRight")}
						>
							<PanelRight className="h-4 w-4" />
						</button>
					</div>
					{children}
				</div>
				{rightOpen && (
					<>
						<ResizeHandle
							orientation="vertical"
							invert
							getSize={() => rightWidth}
							onResize={clampRight}
						/>
						<div className="shrink-0" style={{ width: rightWidth }}>
							<RightDock workspace={workspace} />
						</div>
					</>
				)}
			</div>

			{/* Bottom row: terminal dock (hidden when closed). */}
			{bottomOpen && (
				<>
					<ResizeHandle
						orientation="horizontal"
						invert
						getSize={() => bottomHeight}
						onResize={clampBottom}
					/>
					<div className="shrink-0" style={{ height: bottomHeight }}>
						<BottomDock workspace={workspace} ptyPort={ptyPort} onCollapse={() => setBottomOpen(false)} />
					</div>
				</>
			)}
		</div>
	);
}
