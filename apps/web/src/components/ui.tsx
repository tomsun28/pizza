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
