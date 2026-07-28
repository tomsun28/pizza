import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	PixelAlert,
	PixelBadge as PxlBadge,
	PixelButton as PxlButton,
	PixelEmptyState as PxlEmptyState,
	PixelModal as PxlModal,
	PixelSpinner as PxlSpinner,
	type Tone,
} from "@pxlkit/ui-kit";
import { cn } from "@/lib/utils";
import { toggleTheme, useTheme } from "@/lib/theme";

const toneMap: Record<string, Tone> = {
	neutral: "neutral",
	success: "green",
	warning: "gold",
	danger: "red",
	accent: "cyan",
};

export function Card({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"rounded-xl border border-border bg-surface px-5 py-4",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function PageHeader({
	title,
	description,
	actions,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
}) {
	return (
		<div className="mb-8 flex items-start justify-between gap-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-fg">
					{title}
				</h1>
				{description && (
					<p className="mt-1.5 text-sm text-muted">{description}</p>
				)}
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</div>
	);
}

export function Badge({
	children,
	tone = "neutral",
}: {
	children: ReactNode;
	tone?: keyof typeof toneMap;
}) {
	return (
		<PxlBadge tone={toneMap[tone]} size="sm">
			{children}
		</PxlBadge>
	);
}

export function Button({
	children,
	tone = "accent",
	variant,
	size = "md",
	iconLeft,
	iconRight,
	loading,
	fullWidth,
	disabled,
	onClick,
	type,
	title,
	className,
}: {
	children?: ReactNode;
	tone?: keyof typeof toneMap;
	variant?: "solid" | "soft" | "outline" | "ghost";
	size?: "sm" | "md" | "lg";
	iconLeft?: ReactNode;
	iconRight?: ReactNode;
	loading?: boolean;
	fullWidth?: boolean;
	disabled?: boolean;
	onClick?: () => void;
	type?: "button" | "submit" | "reset";
	title?: string;
	className?: string;
}) {
	return (
		<PxlButton
			tone={toneMap[tone]}
			variant={variant}
			size={size}
			iconLeft={iconLeft}
			iconRight={iconRight}
			loading={loading}
			fullWidth={fullWidth}
			disabled={disabled}
			onClick={onClick}
			type={type}
			title={title}
			className={className}
		>
			{children}
		</PxlButton>
	);
}

export function StatusDot({
	tone,
}: {
	tone: "success" | "warning" | "danger" | "neutral";
}) {
	const color = {
		success: "bg-success",
		warning: "bg-warning",
		danger: "bg-danger",
		neutral: "bg-muted",
	}[tone];
	return (
		<span className="relative inline-flex h-2 w-2">
			{tone === "success" && (
				<span
					className={cn(
						"absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
						color,
					)}
				/>
			)}
			<span className={cn("relative inline-block h-2 w-2 rounded-full", color)} />
		</span>
	);
}

export function Spinner() {
	return <PxlSpinner size="sm" decorative />;
}

export function Field({
	label,
	children,
	hint,
}: {
	label: string;
	children: ReactNode;
	hint?: string;
}) {
	return (
		<label className="block">
			<span className="label">{label}</span>
			{children}
			{hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
		</label>
	);
}

export function EmptyState({
	title,
	description,
	action,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<PxlEmptyState
			title={title}
			description={description ?? ""}
			action={action}
		/>
	);
}

export function ErrorBanner({ message }: { message: string }) {
	const { t } = useTranslation();
	return (
		<div className="mb-4">
			<PixelAlert tone="red" label={t("common.error")} message={message} />
		</div>
	);
}

export function Modal({
	open,
	onClose,
	title,
	children,
	footer,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<PxlModal open={open} onClose={onClose} title={title} footer={footer} size="lg">
			{children}
		</PxlModal>
	);
}

export function MiniSwitch({
	checked,
	onChange,
	disabled,
	tone = "green",
	"aria-label": ariaLabel,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	tone?: "green" | "accent";
	"aria-label"?: string;
}) {
	const onColor =
		tone === "accent"
			? "border-accent bg-accent/30"
			: "border-success bg-success/30";
	const onThumb = tone === "accent" ? "bg-accent" : "bg-success";
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
				checked ? onColor : "border-border bg-surface-2",
				disabled && "cursor-not-allowed opacity-50",
			)}
		>
			<span
				className={cn(
					"absolute h-3.5 w-3.5 rounded-full transition-transform",
					checked
						? `translate-x-4 ${onThumb}`
						: "translate-x-0.5 bg-muted",
				)}
			/>
		</button>
	);
}

export function ThemeToggle() {
	const { t } = useTranslation();
	const theme = useTheme();
	const isDark = theme === "dark";
	return (
		<PxlButton
			tone="neutral"
			variant="ghost"
			size="sm"
			onClick={toggleTheme}
			title={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
			aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
			iconLeft={<span className="text-xs">{isDark ? "☀" : "☾"}</span>}
		/>
	);
}

/**
 * A single menu entry. Either an action item (icon + label + click handler)
 * or a visual divider. Use the union shape to make dividers type-safe.
 */
export type ContextMenuItem =
	| {
			divider?: never;
			icon: typeof import("lucide-react").Folder;
			label: string;
			hint?: string;
			disabled?: boolean;
			danger?: boolean;
			onClick: () => void;
	  }
	| { divider: true };

export interface ContextMenuProps {
	/** Position in viewport coordinates (typically `e.clientX/Y`). */
	x: number;
	y: number;
	items: ContextMenuItem[];
	onDismiss: () => void;
}

/**
 * Floating context menu rendered as a `position: fixed` div with viewport
 * coordinates. Dismisses on outside mousedown or Escape (handled by the
 * caller via `onDismiss` — typically a window-level listener installed in
 * a `useEffect` while the menu is open).
 */
export function ContextMenu({ x, y, items, onDismiss }: ContextMenuProps) {
	// Clamp the menu inside the viewport so it doesn't overflow right/bottom
	// edges. Width/height are estimates (item widths vary); we re-measure
	// after mount via `useEffect` for an exact fit, but a simple upfront
	// clamp already keeps it usable on narrow right docks.
	const minWidth = 208; // matches the min-w-52 class below
	const maxHeight = 360;
	const clampedX = Math.max(8, Math.min(x, window.innerWidth - minWidth - 8));
	const clampedY = Math.max(8, Math.min(y, window.innerHeight - maxHeight - 8));

	return (
		<div
			className="fixed z-50 min-w-52 rounded-md border border-border bg-surface-2 py-1 shadow-lg"
			style={{ left: clampedX, top: clampedY }}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{items.map((item, i) => (
				item.divider ? (
					<div key={i} className="my-1 h-px bg-border" />
				) : (
					<ContextMenuRow
						key={i}
						item={item}
						onClick={() => {
							if (item.disabled) return;
							onDismiss();
							item.onClick();
						}}
					/>
				)
			))}
		</div>
	);
}

function ContextMenuRow({
	item,
	onClick,
}: {
	item: Exclude<ContextMenuItem, { divider: true }>;
	onClick: () => void;
}) {
	const Icon = item.icon;
	return (
		<button
			type="button"
			disabled={item.disabled}
			onClick={onClick}
			title={item.hint}
			className={cn(
				"flex w-full items-start gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors",
				item.disabled
					? "cursor-not-allowed text-muted/40"
					: item.danger
						? "text-danger hover:bg-danger/10 hover:text-danger"
						: "text-fg hover:bg-accent/10 hover:text-accent",
			)}
		>
			<Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="truncate">{item.label}</span>
				{item.hint && (
					<span className="truncate text-[10px] font-normal text-muted">{item.hint}</span>
				)}
			</span>
		</button>
	);
}
