import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation, useOutletContext } from "react-router-dom";
import { Save } from "lucide-react";
import { PageHeader, Card, Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PixelSelect, PixelCombobox } from "@pxlkit/ui-kit";
import { listProviders, setProviderApiKey, removeProviderApiKey, type ProviderInfo } from "@/lib/transport";
import type { RpcSessionState } from "@/lib/types";
import { sendCommandAwait } from "@/lib/transport";
import { Key, Trash2, Eye, EyeOff, Plus, ArrowLeft, ArrowRight } from "lucide-react";
import type { LayoutOutletContext } from "@/components/Layout";
import {
	SUPPORTED_LANGUAGES,
	DEFAULT_LANGUAGE,
	setStoredLanguage,
	type AppLanguage,
} from "@/i18n";

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center justify-between border-b border-border/60 py-3 last:border-0">
			<span className="text-sm text-fg">{label}</span>
			<span className="text-sm text-muted">{children}</span>
		</div>
	);
}

function providerLabel(provider: { id: string; name?: string }): string {
	return provider.name ?? provider.id;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const THINKING_OPTIONS = THINKING_LEVELS.map((level) => ({ value: level, label: level }));

function GeneralTab({ state }: { state: RpcSessionState | null }) {
	const { t, i18n } = useTranslation();
	const [thinkingLevel, setThinkingLevel] = useState<string>(state?.thinkingLevel ?? "off");
	// Scheduler defaults — applied to new tasks. Loaded once on mount.
	const [schedulerPolicy, setSchedulerPolicyState] = useState<import("@/lib/types").SchedulerPolicy>({
		concurrency: "skip",
		timeoutMinutes: 0,
		defaultSessionTarget: { kind: "pinned" },
	});
	useEffect(() => {
		import("@/lib/transport").then(({ getSchedulerPolicy }) => {
			getSchedulerPolicy()
				.then((policy) => setSchedulerPolicyState({
					...policy,
					defaultSessionTarget: policy.defaultSessionTarget.kind === "current"
						? { kind: "pinned" }
						: policy.defaultSessionTarget,
				}))
				.catch(() => {});
		});
	}, []);
	const [language, setLanguage] = useState<AppLanguage>(
		(SUPPORTED_LANGUAGES.includes(i18n.language as AppLanguage) ? i18n.language : DEFAULT_LANGUAGE) as AppLanguage,
	);

	const handleThinkingChange = useCallback(async (level: string) => {
		setThinkingLevel(level);
		try {
			await sendCommandAwait({ type: "set_thinking_level", level: level as RpcSessionState["thinkingLevel"] });
		} catch (e) {
			console.error("[settings] set_thinking_level failed:", e);
		}
	}, []);

	const handleLanguageChange = useCallback((value: string) => {
		const lang = (SUPPORTED_LANGUAGES.includes(value as AppLanguage) ? value : DEFAULT_LANGUAGE) as AppLanguage;
		setLanguage(lang);
		setStoredLanguage(lang);
		void i18n.changeLanguage(lang);
	}, [i18n]);

	const languageOptions = SUPPORTED_LANGUAGES.map((lang) => ({
		value: lang,
		label: t(`language.${lang}`),
	}));

	return (
		<div className="space-y-6">
			<Card>
				<div className="mb-2 text-sm font-medium text-fg">{t("settings.general.model")}</div>
				<Row label={t("settings.general.currentProvider")}>
					<span className="font-mono">{state?.model?.provider ?? "—"}</span>
				</Row>
				<Row label={t("settings.general.currentModel")}>
					<span className="font-mono">{state?.model?.id ?? "—"}</span>
				</Row>
				<Row label={t("settings.general.thinkingLevel")}>
					<div className="w-32">
						<PixelSelect
							value={thinkingLevel}
							options={THINKING_OPTIONS}
							onChange={handleThinkingChange}
							size="sm"
							tone="cyan"
						/>
					</div>
				</Row>
			</Card>

			<Card>
				<div className="mb-2 text-sm font-medium text-fg">{t("settings.general.language")}</div>
				<Row label={t("settings.general.languageDescription")}>
					<div className="w-40">
						<PixelSelect
							value={language}
							options={languageOptions}
							onChange={handleLanguageChange}
							size="sm"
							tone="cyan"
						/>
					</div>
				</Row>
			</Card>

			<Card>
				<div className="mb-2 flex items-center justify-between">
					<span className="text-sm font-medium text-fg">{t("settings.scheduler.title")}</span>
					<Button
						size="sm"
						tone="accent"
						iconLeft={<Save className="h-3.5 w-3.5" />}
						onClick={async () => {
							const { setSchedulerPolicy } = await import("@/lib/transport");
							const saved = await setSchedulerPolicy(schedulerPolicy);
							setSchedulerPolicyState(saved);
						}}
					>
						{t("common.save")}
					</Button>
				</div>
				<div className="mb-1 text-xs text-muted">{t("settings.scheduler.subtitle")}</div>
				<div className="space-y-3">
					<div>
						<div className="mb-1 text-xs text-muted">{t("settings.scheduler.defaultSessionTarget")}</div>
						<div className="grid gap-1.5">
							{(["pinned", "new"] as const).map((k) => (
								<button
									key={k}
									type="button"
									onClick={() => setSchedulerPolicyState({
										...schedulerPolicy,
										defaultSessionTarget: k === "pinned"
											? { kind: "pinned" }
											: { kind: "new", purpose: schedulerPolicy.defaultSessionTarget.kind === "new" ? schedulerPolicy.defaultSessionTarget.purpose : "" },
									})}
									className={cn(
										"flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
										schedulerPolicy.defaultSessionTarget.kind === k
											? "border-accent bg-accent/10 text-fg"
											: "border-border bg-surface-2 text-muted hover:bg-surface hover:text-fg",
									)}
								>
									<span>{t(`schedule.session${k === "pinned" ? "Pinned" : "New"}`)}</span>
								</button>
							))}
						</div>
					</div>
					<div>
						<div className="mb-1 text-xs text-muted">{t("settings.scheduler.defaultConcurrency")}</div>
						<div className="grid gap-1.5">
							{(["skip", "queue", "preempt"] as const).map((p) => (
								<button
									key={p}
									type="button"
									onClick={() => setSchedulerPolicyState({ ...schedulerPolicy, concurrency: p })}
									className={cn(
										"flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
										schedulerPolicy.concurrency === p
											? "border-accent bg-accent/10 text-fg"
											: "border-border bg-surface-2 text-muted hover:bg-surface hover:text-fg",
									)}
								>
									<span>{t(`schedule.concurrency_${p}`)}</span>
								</button>
							))}
						</div>
					</div>
					<div>
						<div className="mb-1 text-xs text-muted">{t("settings.scheduler.defaultTimeout")}</div>
						<div className="flex items-center gap-2">
							<input
								type="number"
								min={0}
								max={1440}
								value={schedulerPolicy.timeoutMinutes}
								onChange={(e) => setSchedulerPolicyState({ ...schedulerPolicy, timeoutMinutes: Math.max(0, Number(e.target.value || 0)) })}
								className="h-8 w-24 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
							/>
							<span className="text-xs text-muted">{t("schedule.minute")} (0 = {t("schedule.timeoutNoLimit")})</span>
						</div>
					</div>
				</div>
			</Card>
		</div>
	);
}

function ProviderRow({ provider, onRefresh }: { provider: ProviderInfo; onRefresh: () => void }) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [keyValue, setKeyValue] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	const handleSave = useCallback(async () => {
		if (!keyValue.trim()) {
			setError(t("settings.provider.keyEmpty"));
			return;
		}
		setSaving(true);
		setError("");
		try {
			await setProviderApiKey(provider.id, keyValue.trim());
			setEditing(false);
			setKeyValue("");
			setShowKey(false);
			onRefresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [keyValue, provider.id, onRefresh, t]);

	const handleRemove = useCallback(async () => {
		if (!confirm(t("settings.provider.confirmRemove", { label: providerLabel(provider) }))) return;
		try {
			await removeProviderApiKey(provider.id);
			onRefresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [provider, onRefresh, t]);

	const label = providerLabel(provider);

	return (
		<div className="border-b border-border/60 py-3 last:border-0">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<Key className={cn("h-4 w-4", provider.has_api_key ? "text-success" : "text-muted")} />
					<span className="text-sm font-medium text-fg">{label}</span>
					{provider.has_api_key ? (
						<Badge tone={provider.auth_type === "oauth" ? "accent" : "success"}>
							{provider.auth_type === "oauth" ? t("settings.provider.oauth") : t("settings.provider.apiKey")}
						</Badge>
					) : (
						<Badge tone="neutral">{t("settings.provider.notConfigured")}</Badge>
					)}
				</div>
				<div className="flex items-center gap-2">
					{!editing && provider.auth_type !== "oauth" && (
						<Button size="sm" tone="neutral" onClick={() => setEditing(true)}>
							{provider.has_api_key ? t("settings.provider.update") : t("settings.provider.configure")}
						</Button>
					)}
					{provider.has_api_key && provider.auth_type !== "oauth" && !editing && (
						<button
							onClick={handleRemove}
							className="text-muted hover:text-danger transition-colors"
							title={t("settings.provider.remove")}
						>
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					)}
				</div>
			</div>
			{editing && (
				<div className="mt-3 space-y-2">
					<div className="flex items-center gap-2">
						<input
							type={showKey ? "text" : "password"}
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
							placeholder={t("settings.provider.enterKey", { label })}
							className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							onKeyDown={(e) => e.key === "Enter" && handleSave()}
						/>
						<button
							onClick={() => setShowKey(!showKey)}
							className="text-muted hover:text-fg transition-colors"
							title={showKey ? t("settings.provider.hide") : t("settings.provider.show")}
						>
							{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
						</button>
					</div>
					{error && <p className="font-mono text-[10px] text-danger">{error}</p>}
					<div className="flex items-center gap-2">
						<Button size="sm" tone="accent" onClick={handleSave} disabled={saving}>
							{saving ? t("settings.provider.saving") : t("settings.provider.save")}
						</Button>
						<Button size="sm" tone="neutral" onClick={() => { setEditing(false); setKeyValue(""); setShowKey(false); setError(""); }}>
							{t("settings.provider.cancel")}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function AddProviderInline({
	available,
	onSaved,
	onCancel,
}: {
	available: ProviderInfo[];
	onSaved: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [selected, setSelected] = useState("");
	const [keyValue, setKeyValue] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	const providerOptions = available.map((p) => ({
		value: p.id,
		label: providerLabel(p),
	}));

	const selectedProvider = available.find((p) => p.id === selected);
	const label = selectedProvider ? providerLabel(selectedProvider) : "";

	const handleSave = useCallback(async () => {
		if (!selected) {
			setError(t("settings.provider.selectProvider"));
			return;
		}
		if (!keyValue.trim()) {
			setError(t("settings.provider.keyEmpty"));
			return;
		}
		setSaving(true);
		setError("");
		try {
			await setProviderApiKey(selected, keyValue.trim());
			onSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [selected, keyValue, onSaved, t]);

	return (
		<div className="border-b border-border/60 py-3">
			<div className="mb-2 text-xs font-medium text-fg">{t("settings.provider.addNew")}</div>
			<div className="flex items-center gap-2">
				<div className="flex-1">
					<PixelCombobox
						value={selected}
						options={providerOptions}
						onChange={(v) => { setSelected(v); setError(""); }}
						placeholder={t("settings.provider.selectProviderPlaceholder")}
						size="sm"
						emptyMessage={t("settings.provider.noMatch")}
					/>
				</div>
				{!selected && (
					<Button size="sm" tone="neutral" onClick={onCancel}>{t("settings.provider.cancel")}</Button>
				)}
			</div>
			{selected && (
				<div className="mt-3 space-y-2">
					<div className="flex items-center gap-2">
						<input
							type={showKey ? "text" : "password"}
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
							placeholder={t("settings.provider.enterKey", { label })}
							autoFocus
							className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							onKeyDown={(e) => e.key === "Enter" && handleSave()}
						/>
						<button
							onClick={() => setShowKey(!showKey)}
							className="text-muted hover:text-fg transition-colors"
							title={showKey ? t("settings.provider.hide") : t("settings.provider.show")}
						>
							{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
						</button>
					</div>
					{error && <p className="font-mono text-[10px] text-danger">{error}</p>}
					<div className="flex items-center gap-2">
						<Button size="sm" tone="accent" onClick={handleSave} disabled={saving}>
							{saving ? t("settings.provider.saving") : t("settings.provider.save")}
						</Button>
						<Button size="sm" tone="neutral" onClick={onCancel}>{t("settings.provider.cancel")}</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function ProviderTab({
	isSetupMode = false,
	onConfigured,
}: {
	isSetupMode?: boolean;
	onConfigured?: () => void | Promise<void>;
}) {
	const { t } = useTranslation();
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [showAddInline, setShowAddInline] = useState(isSetupMode);

	const refresh = useCallback(async () => {
		try {
			const list = await listProviders();
			setProviders(list);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	if (loading) {
		return (
			<Card>
				<div className="text-sm text-muted">{t("settings.provider.loading")}</div>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<div className="text-sm text-danger">{t("settings.provider.error", { error })}</div>
			</Card>
		);
	}

	const configured = providers.filter((p) => p.has_api_key);
	const available = providers.filter((p) => !p.has_api_key);

	return (
		<div className="space-y-6">
			<Card>
				<div className="mb-3 flex items-center justify-between">
					<div className="text-sm font-medium text-fg">{t("settings.provider.title")}</div>
					{!isSetupMode && (
						<Button size="sm" tone="accent" iconLeft={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowAddInline(true)}>
							{t("settings.provider.addProvider")}
						</Button>
					)}
				</div>

				{showAddInline && (
					<AddProviderInline
						available={available}
						onSaved={() => {
							setShowAddInline(false);
							refresh();
							if (onConfigured) void onConfigured();
						}}
						onCancel={() => setShowAddInline(false)}
					/>
				)}

				{configured.length === 0 && !showAddInline && (
					<div className="py-6 text-center">
						<p className="font-mono text-xs text-muted">{t("settings.provider.noProviders")}</p>
						<p className="mt-1 font-mono text-[10px] text-muted">{t("settings.provider.noProvidersHint")}</p>
					</div>
				)}

				{configured.map((p) => (
					<ProviderRow
						key={p.id}
						provider={p}
						onRefresh={() => {
							refresh();
							if (onConfigured) void onConfigured();
						}}
					/>
				))}
			</Card>
		</div>
	);
}

function SetupBanner({ state }: { state: RpcSessionState | null }) {
	const { t } = useTranslation();
	const isSetup = !state || state.model === undefined;
	if (!isSetup) return null;
	return (
		<Card className="border-accent/40 bg-accent/5">
			<div className="flex items-start gap-3">
				<Key className="mt-0.5 h-5 w-5 text-accent" />
				<div className="flex-1 space-y-1">
					<div className="text-sm font-medium text-fg">{t("settings.setup.bannerTitle")}</div>
					<div className="font-mono text-xs text-muted">{t("settings.setup.bannerBody")}</div>
				</div>
			</div>
		</Card>
	);
}

export default function SettingsView({
	state,
	onRestartSidecar,
}: {
	state: RpcSessionState | null;
	onRestartSidecar?: () => Promise<void> | void;
}) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	// First-run / unconfigured-key setup mode is signaled by ?setup=true in the
	// URL. App.tsx redirects there when the sidecar reports state.model === undefined.
	const isSetupMode = new URLSearchParams(location.search).get("setup") === "true";
	const [tab, setTab] = useState<"general" | "provider">(isSetupMode ? "provider" : "general");
	const [restarting, setRestarting] = useState(false);
	const [restartError, setRestartError] = useState("");
	const handleConfigured = useCallback(async () => {
		// Prefer the sidecar-restart path (re-scans modelRegistry with the new key).
		// Fall back to "just go back to chat" if no restart callback was provided
		// (e.g. web/preview builds without Tauri).
		if (onRestartSidecar) {
			setRestarting(true);
			setRestartError("");
			try {
				await onRestartSidecar();
				navigate("/", { replace: true });
			} catch (e) {
				setRestartError(e instanceof Error ? e.message : String(e));
			} finally {
				setRestarting(false);
			}
		} else {
			navigate("/", { replace: true });
		}
	}, [onRestartSidecar, navigate]);

	// Track browser history position so we can enable/disable back/forward.
	// react-router v6 stores { idx, usr, key } on window.history.state.
	const histIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
	const maxIdxRef = useRef(histIdx);
	if (histIdx > maxIdxRef.current) maxIdxRef.current = histIdx;
	// Reset the forward ceiling whenever location changes to a fresh entry.
	useEffect(() => {
		if (histIdx > maxIdxRef.current) maxIdxRef.current = histIdx;
	}, [histIdx, location.key]);
	const canBack = histIdx > 0;
	const canForward = histIdx < maxIdxRef.current;

	return (
		<div className="flex h-full flex-col">
			{/* Top bar — sits next to the sidebar collapse button; holds back/forward nav */}
			<div
				data-tauri-drag-region
				className={cn(
					"flex h-11 shrink-0 items-center gap-1 border-b border-border bg-surface/80 pr-6 backdrop-blur transition-[padding] duration-150",
					sidebarCollapsed ? "pl-[120px]" : "pl-6",
				)}
			>
				<button
					data-no-drag
					type="button"
					onClick={() => navigate(-1)}
					disabled={!canBack}
					className={cn(
						"flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
						canBack ? "text-muted hover:bg-surface-2 hover:text-fg" : "text-muted/30",
					)}
					title={t("common.back")}
				>
					<ArrowLeft className="h-4 w-4" />
				</button>
				<button
					data-no-drag
					type="button"
					onClick={() => navigate(1)}
					disabled={!canForward}
					className={cn(
						"flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
						canForward ? "text-muted hover:bg-surface-2 hover:text-fg" : "text-muted/30",
					)}
					title={t("common.forward")}
				>
					<ArrowRight className="h-4 w-4" />
				</button>
			</div>

			{/* Scrollable content — scrollbar hidden, but still scrollable */}
			<div className="scrollbar-hide flex-1 overflow-y-auto">
				<div className="mx-auto max-w-5xl px-10 pb-10 pt-10">
					<PageHeader title={isSetupMode ? t("settings.setup.title") : t("settings.title")} />

					{isSetupMode && (
						<div className="mb-6">
							<SetupBanner state={state} />
							{restarting && (
								<p className="mt-2 font-mono text-xs text-muted">
									{t("settings.setup.restarting")}
								</p>
							)}
							{restartError && (
								<p className="mt-2 font-mono text-xs text-danger">{restartError}</p>
							)}
						</div>
					)}

					<div className="mb-6 flex gap-1 border-b border-border">
						<button
							onClick={() => setTab("general")}
							className={cn(
								"px-4 py-2 text-sm font-medium transition-colors",
								tab === "general"
									? "border-b-2 border-accent text-accent"
									: "text-muted hover:text-fg",
							)}
						>
							{t("settings.tabs.general")}
						</button>
						<button
							onClick={() => setTab("provider")}
							className={cn(
								"px-4 py-2 text-sm font-medium transition-colors",
								tab === "provider"
									? "border-b-2 border-accent text-accent"
									: "text-muted hover:text-fg",
							)}
						>
							{t("settings.tabs.provider")}
						</button>
					</div>

					{tab === "general" ? (
						<GeneralTab state={state} />
					) : (
						<ProviderTab isSetupMode={isSetupMode} onConfigured={handleConfigured} />
					)}
				</div>
			</div>
		</div>
	);
}
