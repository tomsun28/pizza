import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader, Card, Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PixelSelect, PixelSwitch, PixelCombobox } from "@pxlkit/ui-kit";
import { listProviders, setProviderApiKey, removeProviderApiKey, type ProviderInfo } from "@/lib/transport";
import type { RpcSessionState } from "@/lib/types";
import { sendCommandAwait } from "@/lib/transport";
import { Key, Trash2, Eye, EyeOff, Plus } from "lucide-react";
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
	const [autoCompaction, setAutoCompaction] = useState<boolean>(state?.autoCompactionEnabled ?? true);
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

	const handleCompactionChange = useCallback(async (enabled: boolean) => {
		setAutoCompaction(enabled);
		try {
			await sendCommandAwait({ type: "set_auto_compaction", enabled });
		} catch (e) {
			console.error("[settings] set_auto_compaction failed:", e);
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
				<div className="mb-2 text-sm font-medium text-fg">{t("settings.general.compaction")}</div>
				<Row label={t("settings.general.autoCompaction")}>
					<PixelSwitch
						label={t("settings.general.autoCompaction")}
						checked={autoCompaction}
						onChange={handleCompactionChange}
						tone="cyan"
					/>
				</Row>
				{state?.isCompacting && (
					<Row label={t("settings.general.status")}>
						<Badge tone="warning">{t("settings.general.compacting")}</Badge>
					</Row>
				)}
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
	}, [provider.id, onRefresh, t]);

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

function ProviderTab() {
	const { t } = useTranslation();
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [showAddInline, setShowAddInline] = useState(false);

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
					<Button size="sm" tone="accent" iconLeft={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowAddInline(true)}>
						{t("settings.provider.addProvider")}
					</Button>
				</div>

				{showAddInline && (
					<AddProviderInline
						available={available}
						onSaved={() => { setShowAddInline(false); refresh(); }}
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
					<ProviderRow key={p.id} provider={p} onRefresh={refresh} />
				))}
			</Card>
		</div>
	);
}

export default function SettingsView({
	state,
}: {
	state: RpcSessionState | null;
}) {
	const { t } = useTranslation();
	const [tab, setTab] = useState<"general" | "provider">("general");

	return (
		<div className="mx-auto max-w-5xl px-10 pb-10 pt-10">
			<PageHeader title={t("settings.title")} />

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

			{tab === "general" ? <GeneralTab state={state} /> : <ProviderTab />}
		</div>
	);
}
