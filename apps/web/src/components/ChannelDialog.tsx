/**
 * Channel configuration modal — create or edit a message channel (Discord,
 * Lark, Slack, Telegram, or webhook). Mirrors the provider-config dialog flow:
 * a Modal wrapping a form, with Test + Save footer actions.
 *
 * The credential fields adapt to the selected type (token+target for chat
 * apps, webhook URL for webhooks). The "deliver to workspace" dropdown is the
 * target agent that inbound messages route to.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ErrorBanner, Field, Modal, Select } from "@/components/ui";
import {
	CHANNEL_TYPES,
	isTokenType,
	saveChannel,
	testChannel,
	workspaceOptions,
	type ChannelInfo,
	type ChannelInput,
	type ChannelType,
} from "@/lib/channels";

interface ChannelDialogProps {
	open: boolean;
	onClose: () => void;
	/** When editing, the existing channel; undefined when creating. */
	existing?: ChannelInfo | null;
	onSaved: (channel: ChannelInfo) => void;
}

export function ChannelDialog({ open, onClose, existing, onSaved }: ChannelDialogProps) {
	const { t } = useTranslation();
	const isEdit = !!existing;

	const [type, setType] = useState<ChannelType>(existing?.type ?? "discord");
	const [name, setName] = useState(existing?.name ?? "");
	const [token, setToken] = useState(existing?.token ?? "");
	const [server, setServer] = useState(existing?.server ?? "");
	const [channel, setChannel] = useState(existing?.channel ?? "");
	const [webhookUrl, setWebhookUrl] = useState(existing?.webhookUrl ?? "");
	const [workspace, setWorkspace] = useState(existing?.workspace ?? "");
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [workspaces, setWorkspaces] = useState<{ value: string; label: string; hint: string }[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);
	const [testMessage, setTestMessage] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// Remount on `existing` so a fresh "Add" after an "Edit" resets all fields.
	useEffect(() => {
		if (!open) return;
		setType(existing?.type ?? "discord");
		setName(existing?.name ?? "");
		setToken(existing?.token ?? "");
		setServer(existing?.server ?? "");
		setChannel(existing?.channel ?? "");
		setWebhookUrl(existing?.webhookUrl ?? "");
		setWorkspace(existing?.workspace ?? "");
		setEnabled(existing?.enabled ?? true);
		setError(null);
		setTestMessage(null);
		setTesting(false);
		setSaving(false);
	}, [open, existing]);

	useEffect(() => {
		if (!open) return;
		workspaceOptions().then(setWorkspaces).catch(() => setWorkspaces([]));
	}, [open]);

	const tokenType = isTokenType(type);

	function validate(): string | null {
		if (!name.trim()) return t("channels.dialog.nameRequired");
		if (!workspace) return t("channels.dialog.workspaceRequired");
		if (tokenType && !token.trim()) return t("channels.dialog.tokenRequired");
		if (!tokenType && !webhookUrl.trim()) return t("channels.dialog.urlRequired");
		return null;
	}

	async function handleTest() {
		const err = validate();
		if (err) {
			setError(err);
			return;
		}
		setError(null);
		setTesting(true);
		setTestMessage(null);
		try {
			// Save first (so testChannel has the latest config), then test.
			const input: ChannelInput = { type, name: name.trim(), token, server, channel, webhookUrl, workspace, enabled };
			const saved = await saveChannel(existing?.id ?? null, input);
			const result = await testChannel(saved.id);
			setTestMessage(result.message);
			onSaved({ ...saved, status: result.ok ? "connected" : "error" });
		} catch (e) {
			setTestMessage(e instanceof Error ? e.message : String(e));
		} finally {
			setTesting(false);
		}
	}

	async function handleSave() {
		const err = validate();
		if (err) {
			setError(err);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			const input: ChannelInput = { type, name: name.trim(), token, server, channel, webhookUrl, workspace, enabled };
			const saved = await saveChannel(existing?.id ?? null, input);
			onSaved(saved);
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={isEdit ? t("channels.dialog.editTitle") : t("channels.dialog.createTitle")}
			footer={
				<div className="flex w-full items-center justify-between gap-2">
					<Button tone="neutral" variant="ghost" size="sm" onClick={onClose}>
						{t("channels.dialog.cancel")}
					</Button>
					<div className="flex items-center gap-2">
						<Button tone="neutral" size="sm" loading={testing} disabled={saving} onClick={handleTest}>
							{testing ? t("channels.testing") : t("channels.test")}
						</Button>
						<Button size="sm" loading={saving} disabled={testing} onClick={handleSave}>
							{saving ? t("channels.saving") : t("channels.save")}
						</Button>
					</div>
				</div>
			}
		>
			<div className="space-y-4">
				{error && <ErrorBanner message={error} />}
				{testMessage && (
					<div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
						{testMessage}
					</div>
				)}

				<div className="grid grid-cols-2 gap-3">
					<Field label={t("channels.dialog.type")}>
						<Select
							value={type}
							options={CHANNEL_TYPES.map((tk) => ({ value: tk, label: t(`channels.types.${tk}`) }))}
							onChange={(v) => setType(v as ChannelType)}
						/>
					</Field>
					<Field label={t("channels.dialog.name")}>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("channels.dialog.namePlaceholder")}
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
				</div>

				{tokenType ? (
					<>
						<Field label={t("channels.dialog.token")} hint={t("channels.dialog.tokenHint")}>
							<input
								type="password"
								value={token}
								onChange={(e) => setToken(e.target.value)}
								placeholder="••••••••"
								className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
							/>
						</Field>
						<div className="grid grid-cols-2 gap-3">
							<Field label={t("channels.dialog.server")}>
								<input
									type="text"
									value={server}
									onChange={(e) => setServer(e.target.value)}
									placeholder={t("channels.dialog.serverPlaceholder")}
									className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
								/>
							</Field>
							<Field label={t("channels.dialog.channel")}>
								<input
									type="text"
									value={channel}
									onChange={(e) => setChannel(e.target.value)}
									placeholder={t("channels.dialog.channelPlaceholder")}
									className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
								/>
							</Field>
						</div>
					</>
				) : (
					<Field label={t("channels.dialog.webhookUrl")} hint={t("channels.dialog.urlHint")}>
						<input
							type="text"
							value={webhookUrl}
							onChange={(e) => setWebhookUrl(e.target.value)}
							placeholder="https://hooks.example.com/…"
							className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
						/>
					</Field>
				)}

				<Field label={t("channels.dialog.workspace")} hint={t("channels.dialog.workspaceHint")}>
					{workspaces.length > 0 ? (
						<Select
							value={workspace}
							options={workspaces}
							onChange={setWorkspace}
							placeholder={t("channels.dialog.workspacePlaceholder")}
						/>
					) : (
						<p className="text-xs text-muted">{t("channels.dialog.noWorkspaces")}</p>
					)}
				</Field>

				<Field label={t("channels.dialog.enabled")}>
					<label className="flex items-center gap-2 text-xs text-muted">
						<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
						{t("channels.dialog.enabledHint")}
					</label>
				</Field>
			</div>
		</Modal>
	);
}
