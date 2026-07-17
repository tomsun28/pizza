import { NavLink, Outlet } from "react-router-dom";
import { MessageSquare, Settings as SettingsIcon, Square } from "lucide-react";
import { StatusDot, ThemeToggle } from "./ui";
import { BrandIcon } from "./BrandIcon";
import { cn } from "@/lib/utils";
import type { RpcSessionState } from "@/lib/types";

const NAV_KEYS = ["chat", "history", "settings"] as const;
const NAV_ICONS = {
	chat: MessageSquare,
	history: Square,
	settings: SettingsIcon,
};

export default function Layout({
	state,
	sidecarReady,
	sidecarExitCode,
}: {
	state: RpcSessionState | null;
	sidecarReady: boolean;
	sidecarExitCode: number | null;
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

				<nav className="flex-1 space-y-1 px-3 py-2">
					{NAV_KEYS.map((key) => {
						const Icon = NAV_ICONS[key];
						return (
							<NavLink
								key={key}
								to={key === "chat" ? "/" : `/${key}`}
								className={({ isActive }) =>
									cn(
										"flex items-center gap-3 rounded-md border px-3 py-2 font-mono text-sm uppercase tracking-wide transition-colors",
										isActive
											? "border-accent bg-accent/10 text-accent"
											: "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
									)
								}
							>
								<Icon className="h-4 w-4" />
								{key}
							</NavLink>
						);
					})}
				</nav>

				<div className="border-t border-border px-3 py-3">
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
