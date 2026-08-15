import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation, useOutletContext } from "react-router-dom";
import { PageHeader, Card, Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PixelSelect, PixelCombobox } from "@pxlkit/ui-kit";
import {
	listProviders,
	setProviderApiKey,
	type AuthLoginEvent,
	type AuthLoginOption,
	listAuthLoginOptions,
	oauthLogin,
	oauthLoginAnswer,
	oauthLoginCancel,
	onAuthLoginEvent,
	removeProviderApiKey,
	saveCustomProvider,
	testCustomProvider,
	removeCustomProvider,
	getSchedulerPolicy,
	setSchedulerPolicy,
	type CustomProviderInput,
	type CustomProviderTestResult,
	type ProviderInfo,
} from "@/lib/transport";
import type { RpcSessionState } from "@/lib/types";
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

function slugifyProviderStem(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "provider";
}

function randomProviderSuffix(): string {
	const bytes = new Uint8Array(3);
	if (globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
		return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

function generateCustomProviderId(name: string, existingIds: Set<string>): string {
	const stem = slugifyProviderStem(name);
	for (let attempt = 0; attempt < 12; attempt++) {
		const id = `custom-${stem}-${randomProviderSuffix()}`;
		if (!existingIds.has(id)) return id;
	}
	return `custom-${stem}-${Date.now().toString(36)}`;
}

type CustomProviderTestState =
	| { status: "idle" }
	| { status: "running"; model: string }
	| { status: "success"; result: CustomProviderTestResult }
	| { status: "error"; result?: CustomProviderTestResult; error?: string };

function GeneralTab() {
	const { t, i18n } = useTranslation();
	// Scheduler defaults — applied to new tasks. Loaded once on mount.
	const [schedulerPolicy, setSchedulerPolicyState] = useState<import("@/lib/types").SchedulerPolicy>({
		concurrency: "skip",
		timeoutMinutes: 0,
		defaultSessionTarget: { kind: "pinned" },
	});
	const schedulerLoadedRef = useRef(false);
	useEffect(() => {
		getSchedulerPolicy()
			.then((policy) => {
				setSchedulerPolicyState({
					...policy,
					defaultSessionTarget: policy.defaultSessionTarget.kind === "current"
						? { kind: "pinned" }
						: policy.defaultSessionTarget,
				});
				schedulerLoadedRef.current = true;
			})
			.catch(() => {});
	}, []);

	// Auto-save scheduler policy on every change (consistent with thinking/language
	// which also apply immediately). Skips the initial load to avoid clobbering
	// server-side defaults before we've fetched them.
	const updateScheduler = useCallback(async (next: import("@/lib/types").SchedulerPolicy) => {
		setSchedulerPolicyState(next);
		if (!schedulerLoadedRef.current) return;
		try {
			const saved = await setSchedulerPolicy(next);
			setSchedulerPolicyState(saved);
		} catch (e) {
			console.error("[settings] setSchedulerPolicy failed:", e);
		}
	}, []);

	const [language, setLanguage] = useState<AppLanguage>(
		(SUPPORTED_LANGUAGES.includes(i18n.language as AppLanguage) ? i18n.language : DEFAULT_LANGUAGE) as AppLanguage,
	);

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
				<div className="mb-2 text-sm font-medium text-fg">{t("settings.scheduler.title")}</div>
				<div className="mb-1 text-xs text-muted">{t("settings.scheduler.subtitle")}</div>
				<div className="space-y-3">
					<div>
						<div className="mb-1 text-xs text-muted">{t("settings.scheduler.defaultSessionTarget")}</div>
						<div className="grid gap-1.5">
							{(["pinned", "new"] as const).map((k) => (
								<button
									key={k}
									type="button"
									onClick={() => updateScheduler({
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
									onClick={() => updateScheduler({ ...schedulerPolicy, concurrency: p })}
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
								onChange={(e) => updateScheduler({ ...schedulerPolicy, timeoutMinutes: Math.max(0, Number(e.target.value || 0)) })}
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

/**
 * "Sign in with an account" dialog — drives the CLI OAuth flow
 * (`pizza auth login --mode jsonl`) via bridge events.
 */
function AccountLoginDialog({
	provider,
	providerName,
	onDone,
	onCancel,
}: {
	provider: string;
	providerName: string;
	onDone: (ok: boolean, message?: string) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [status, setStatus] = useState("");
	const [authUrl, setAuthUrl] = useState("");
	const [instructions, setInstructions] = useState("");
	const [prompt, setPrompt] = useState<AuthLoginEvent | null>(null);
	const [answer, setAnswer] = useState("");
	const [busy, setBusy] = useState(true);

	useEffect(() => {
		const dispose = onAuthLoginEvent((event) => {
			if (event.type === "prompt") {
				setPrompt(event);
				setAnswer("");
				setBusy(false);
			} else if (event.type === "event") {
				const e = event.event;
				if (e.type === "auth_url" && e.url) {
					setAuthUrl(e.url);
					if (e.instructions) setInstructions(e.instructions);
				} else if (e.type === "device_code" && e.verificationUri) {
					setAuthUrl(e.verificationUri);
					setInstructions(`Enter code: ${e.userCode ?? ""}`);
				} else if (e.message) {
					setStatus(e.message);
				}
			} else if (event.type === "done") {
				setBusy(false);
				onDone(event.ok, event.error);
			}
		});
		void oauthLogin(provider).catch((e) => {
			setBusy(false);
			onDone(false, e instanceof Error ? e.message : String(e));
		});
		return dispose;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [provider]);

	const submitAnswer = useCallback(async () => {
		if (!prompt || prompt.type !== "prompt") return;
		const value = answer.trim();
		if (!value) return;
		setBusy(true);
		setPrompt(null);
		try {
			await oauthLoginAnswer(value);
		} catch (e) {
			setBusy(false);
			onDone(false, e instanceof Error ? e.message : String(e));
		}
	}, [answer, prompt, onDone]);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
			<Card className="w-full max-w-lg">
				<div className="mb-3 text-sm font-medium text-fg">
					{t("settings.provider.accountLoginTitle", { name: providerName })}
				</div>
				{authUrl && (
					<div className="mb-3 space-y-1">
						<a href={authUrl} target="_blank" rel="noreferrer" className="break-all text-xs text-accent underline">
							{authUrl}
						</a>
						{instructions && <p className="font-mono text-[10px] text-muted">{instructions}</p>}
					</div>
				)}
				{status && <p className="mb-3 font-mono text-[10px] text-muted">{status}</p>}
				{prompt?.type === "prompt" ? (
					<div className="space-y-2">
						{prompt.prompt.options ? (
							<div className="space-y-1">
								{prompt.prompt.options.map((o) => (
									<button
										key={o.id}
										onClick={() => {
											setAnswer(o.id);
											setTimeout(() => void submitAnswer(), 0);
										}}
										className="block w-full rounded-md border border-border bg-surface px-3 py-1.5 text-left text-xs text-fg hover:border-accent"
									>
										{o.label}
									</button>
								))}
							</div>
						) : (
							<div className="flex items-center gap-2">
								<input
									autoFocus
									value={answer}
									onChange={(e) => setAnswer(e.target.value)}
									placeholder={prompt.prompt.placeholder ?? prompt.prompt.message}
									className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
									onKeyDown={(e) => e.key === "Enter" && void submitAnswer()}
								/>
								<Button size="sm" tone="accent" onClick={() => void submitAnswer()} disabled={busy}>
									{t("common.continue")}
								</Button>
							</div>
						)}
					</div>
				) : (
					<p className="font-mono text-[10px] text-muted">
						{busy ? t("settings.provider.loginWaiting") : t("settings.provider.loginIdle")}
					</p>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<Button
						size="sm"
						tone="neutral"
						onClick={() => {
							void oauthLoginCancel().catch(() => {});
							onCancel();
						}}
					>
						{t("common.cancel")}
					</Button>
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
			if (provider.is_custom) {
				await removeCustomProvider(provider.id);
			} else {
				await removeProviderApiKey(provider.id);
			}
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
					{provider.is_custom && (
						<Badge tone="accent">
							{provider.protocol === "anthropic"
								? t("settings.provider.protocolAnthropic")
								: t("settings.provider.protocolOpenAI")}
						</Badge>
					)}
					{provider.is_custom && provider.model_count ? (
						<span className="font-mono text-[10px] text-muted">
							{t("settings.provider.modelCount", { count: provider.model_count })}
						</span>
					) : null}
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
	existingIds,
	onSaved,
	onCancel,
}: {
	available: ProviderInfo[];
	existingIds: Set<string>;
	onSaved: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [mode, setMode] = useState<"builtin" | "custom">("builtin");
	const [selected, setSelected] = useState("");
	const [keyValue, setKeyValue] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [customName, setCustomName] = useState("");
	const [customProtocol, setCustomProtocol] = useState<"openai" | "anthropic">("openai");
	const [customBaseUrl, setCustomBaseUrl] = useState("");
	const [customModels, setCustomModels] = useState("");
	const [testState, setTestState] = useState<CustomProviderTestState>({ status: "idle" });

	const providerOptions = available.map((p) => ({
		value: p.id,
		label: providerLabel(p),
	}));

	const selectedProvider = available.find((p) => p.id === selected);
	const label = selectedProvider ? providerLabel(selectedProvider) : "";

	const protocolOptions = [
		{ value: "openai", label: t("settings.provider.protocolOpenAI") },
		{ value: "anthropic", label: t("settings.provider.protocolAnthropic") },
	];

	const buildCustomProviderInput = useCallback((): CustomProviderInput | null => {
		const name = customName.trim();
		const models = customModels
			.split(/[\n,]/)
			.map((value) => value.trim())
			.filter(Boolean)
			.map((id) => ({ id, name: id }));
		if (!name) {
			setError(t("settings.provider.customNameEmpty"));
			return null;
		}
		if (!customBaseUrl.trim()) {
			setError(t("settings.provider.baseUrlEmpty"));
			return null;
		}
		if (!keyValue.trim()) {
			setError(t("settings.provider.keyEmpty"));
			return null;
		}
		if (models.length === 0) {
			setError(t("settings.provider.modelsEmpty"));
			return null;
		}
		setError("");
		return {
			id: generateCustomProviderId(name, existingIds),
			name,
			protocol: customProtocol,
			base_url: customBaseUrl.trim(),
			api_key: keyValue.trim(),
			models,
		};
	}, [customName, customModels, customBaseUrl, keyValue, t, existingIds, customProtocol]);

	const handleTest = useCallback(async () => {
		const input = buildCustomProviderInput();
		if (!input) return;
		setTestState({ status: "running", model: input.models[0]?.id ?? "" });
		try {
			const result = await testCustomProvider(input);
			setTestState(result.ok ? { status: "success", result } : { status: "error", result });
		} catch (e) {
			setTestState({ status: "error", error: e instanceof Error ? e.message : String(e) });
		}
	}, [buildCustomProviderInput]);

	const handleSave = useCallback(async () => {
		if (mode === "custom") {
			const input = buildCustomProviderInput();
			if (!input) return;
			setSaving(true);
			setError("");
			try {
				await saveCustomProvider(input);
				onSaved();
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setSaving(false);
			}
			return;
		}

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
	}, [mode, selected, keyValue, onSaved, t, buildCustomProviderInput]);

	return (
		<div className="border-b border-border/60 py-3">
			<div className="mb-2 flex items-center justify-between gap-3">
				<div className="text-xs font-medium text-fg">{t("settings.provider.addNew")}</div>
				<div className="flex items-center gap-1">
					<Button size="sm" tone={mode === "builtin" ? "accent" : "neutral"} onClick={() => { setMode("builtin"); setError(""); }}>
						{t("settings.provider.builtinProvider")}
					</Button>
					<Button size="sm" tone={mode === "custom" ? "accent" : "neutral"} onClick={() => { setMode("custom"); setError(""); }}>
						{t("settings.provider.customProvider")}
					</Button>
				</div>
			</div>

			{mode === "builtin" ? (
				<>
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
				</>
			) : (
				<div className="mt-3 space-y-2">
					<input
						value={customName}
						onChange={(e) => { setCustomName(e.target.value); setTestState({ status: "idle" }); }}
						placeholder={t("settings.provider.customNamePlaceholder")}
						autoFocus
						className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
					<div className="grid gap-2 md:grid-cols-[180px_1fr]">
						<PixelSelect
							value={customProtocol}
							options={protocolOptions}
							onChange={(v) => { setCustomProtocol(v as "openai" | "anthropic"); setTestState({ status: "idle" }); }}
							size="sm"
							tone="cyan"
						/>
						<input
							value={customBaseUrl}
							onChange={(e) => { setCustomBaseUrl(e.target.value); setTestState({ status: "idle" }); }}
							placeholder={customProtocol === "anthropic" ? t("settings.provider.anthropicBaseUrlPlaceholder") : t("settings.provider.openAIBaseUrlPlaceholder")}
							className="rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</div>
					<div className="flex items-center gap-2">
						<input
							type={showKey ? "text" : "password"}
							value={keyValue}
							onChange={(e) => { setKeyValue(e.target.value); setTestState({ status: "idle" }); }}
							placeholder={t("settings.provider.enterKey", { label: customName || t("settings.provider.customProvider") })}
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
					<textarea
						value={customModels}
						onChange={(e) => { setCustomModels(e.target.value); setTestState({ status: "idle" }); }}
						placeholder={t("settings.provider.modelsPlaceholder")}
						rows={3}
						className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
					{error && <p className="font-mono text-[10px] text-danger">{error}</p>}
					{testState.status !== "idle" && (
						<div className="rounded-md border border-border bg-[#0f1725] px-3 py-2 font-mono text-xs leading-6">
							<div className="text-sky-300">{t("settings.provider.testStart", { name: customName.trim() || t("settings.provider.customProvider") })}</div>
							<div className="text-slate-300">{t("settings.provider.testAuthType")}</div>
							<div className={testState.status === "error" ? "text-danger" : "text-success"}>
								{testState.status === "running"
									? t("settings.provider.testConnecting")
									: testState.status === "success"
										? t("settings.provider.testConnected")
										: t("settings.provider.testFailed")}
							</div>
							<div className="text-cyan-300">
								{t("settings.provider.testModel", {
									model: testState.status === "running" ? testState.model : testState.result?.model ?? "",
								})}
							</div>
							<div className="text-slate-400">{t("settings.provider.testMessage")}</div>
							{testState.status !== "running" && testState.result?.response && (
								<>
									<div className="text-yellow-300">{t("settings.provider.testResponse")}</div>
									<div className="whitespace-pre-wrap text-green-200">{testState.result.response}</div>
								</>
							)}
							<div className="mt-2 border-t border-slate-600 pt-2">
								<span className={testState.status === "success" ? "text-success" : testState.status === "running" ? "text-slate-300" : "text-danger"}>
									{testState.status === "running"
										? t("settings.provider.testRunning")
										: testState.status === "success"
											? t("settings.provider.testDone")
											: testState.result?.message ?? testState.error ?? t("settings.provider.testFailed")}
								</span>
								{testState.status !== "running" && testState.result?.duration_ms !== undefined && (
									<span className="ml-2 text-slate-400">
										{t("settings.provider.testDuration", { ms: testState.result.duration_ms })}
									</span>
								)}
							</div>
						</div>
					)}
					<div className="flex items-center gap-2">
						<Button size="sm" tone="neutral" onClick={handleTest} disabled={testState.status === "running" || saving}>
							{testState.status === "running" ? t("settings.provider.testing") : t("settings.provider.testConnection")}
						</Button>
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
	const [accountOptions, setAccountOptions] = useState<AuthLoginOption[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [showAddInline, setShowAddInline] = useState(isSetupMode);
	const [loginProvider, setLoginProvider] = useState<{ id: string; name: string } | null>(null);
	const [authCategory, setAuthCategory] = useState<"account" | "apiKey" | null>(null);

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

	useEffect(() => {
		listAuthLoginOptions()
			.then((options) => setAccountOptions(options.filter((o) => o.kind === "account")))
			.catch(() => setAccountOptions([]));
	}, []);

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

	const oauthSignedIn = new Set(
		providers.filter((p) => p.has_api_key && p.auth_type === "oauth").map((p) => p.id),
	);

	return (
		<div className="space-y-6">
			{loginProvider && (
				<AccountLoginDialog
					provider={loginProvider.id}
					providerName={loginProvider.name}
					onDone={(ok, message) => {
						setLoginProvider(null);
						refresh();
						if (!ok && message) setError(message);
						if (ok && onConfigured) void onConfigured();
					}}
					onCancel={() => setLoginProvider(null)}
				/>
			)}
			{authCategory === null ? (
				<Card>
					<div className="mb-3 text-sm font-medium text-fg">{t("settings.provider.chooseCategory")}</div>
					<div className="grid gap-3 sm:grid-cols-2">
						{accountOptions.length > 0 && (
							<button
								onClick={() => setAuthCategory("account")}
								className="rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-accent"
							>
								<div className="text-sm font-medium text-fg">{t("settings.provider.accountSection")}</div>
								<div className="mt-1 text-xs text-muted">{t("settings.provider.accountSectionHint")}</div>
							</button>
						)}
						<button
							onClick={() => setAuthCategory("apiKey")}
							className="rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-accent"
						>
							<div className="text-sm font-medium text-fg">{t("settings.provider.apiKeySection")}</div>
							<div className="mt-1 text-xs text-muted">{t("settings.provider.apiKeySectionHint")}</div>
						</button>
					</div>
				</Card>
			) : authCategory === "account" ? (
				<Card>
					<div className="mb-3 flex items-center justify-between">
						<div className="text-sm font-medium text-fg">{t("settings.provider.accountSection")}</div>
						<Button size="sm" tone="neutral" onClick={() => setAuthCategory(null)}>
							{t("common.back")}
						</Button>
					</div>
					<div className="space-y-0">
						{accountOptions.map((o) => (
							<div key={o.id} className="flex items-center justify-between border-b border-border/60 py-3 last:border-0">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium text-fg">{o.name}</span>
									{oauthSignedIn.has(o.id) ? (
										<Badge tone="accent">{t("settings.provider.oauth")}</Badge>
									) : (
										<Badge tone="neutral">{t("settings.provider.notConfigured")}</Badge>
									)}
								</div>
								<Button size="sm" tone="accent" onClick={() => setLoginProvider({ id: o.id, name: o.name })}>
									{t("settings.provider.signIn")}
								</Button>
							</div>
						))}
					</div>
				</Card>
			) : (
			<Card>
				<div className="mb-3 flex items-center justify-between">
					<div className="text-sm font-medium text-fg">{t("settings.provider.apiKeySection")}</div>
					<div className="flex items-center gap-2">
						{!isSetupMode && (
							<Button size="sm" tone="accent" iconLeft={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowAddInline(true)}>
								{t("settings.provider.addProvider")}
							</Button>
						)}
						<Button size="sm" tone="neutral" onClick={() => setAuthCategory(null)}>
							{t("common.back")}
						</Button>
					</div>
				</div>

				{showAddInline && (
					<AddProviderInline
						available={available}
						existingIds={new Set(providers.map((p) => p.id))}
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
			)}
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
		// Fall back to "just go back to agent" if no restart callback was provided
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
						<GeneralTab />
					) : (
						<ProviderTab isSetupMode={isSetupMode} onConfigured={handleConfigured} />
					)}
				</div>
			</div>
		</div>
	);
}
