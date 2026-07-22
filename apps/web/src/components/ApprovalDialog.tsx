import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Button, Badge } from "@/components/ui";
import { approveToolCall, rejectToolCall } from "@/lib/transport";
import { cn } from "@/lib/utils";

/** A pending tool-call approval request. */
export interface PendingApproval {
	/** The INTENT_TOOL_CALL event id (used to resolve the approval). */
	intentEventId: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	description?: string;
	risk?: string;
	category?: string;
	affectedFiles?: string[];
}

function toneForRisk(risk?: string): "neutral" | "warning" | "danger" {
	switch (risk) {
		case "dangerous":
			return "danger";
		case "moderate":
			return "warning";
		default:
			return "neutral";
	}
}

function riskLabel(risk?: string): string {
	switch (risk) {
		case "dangerous":
			return "dangerous";
		case "moderate":
			return "moderate";
		case "safe":
			return "safe";
		default:
			return risk ?? "unknown";
	}
}

function formatArguments(args: Record<string, unknown>): string {
	const command = args.command ?? args.path ?? args.command_output;
	if (typeof command === "string") {
		return command.length > 800 ? command.slice(0, 800) + "\n…" : command;
	}
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}

export function ApprovalDialog({
	approval,
	onResolved,
}: {
	approval: PendingApproval | null;
	onResolved: (intentEventId: string) => void;
}) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);

	const open = approval !== null;

	const handle = async (intentEventId: string, approved: boolean) => {
		if (busy) return;
		setBusy(true);
		try {
			if (approved) {
				await approveToolCall(intentEventId);
			} else {
				await rejectToolCall(intentEventId);
			}
		} catch (e) {
			console.error("[approval] resolve failed", e);
		} finally {
			setBusy(false);
			onResolved(intentEventId);
		}
	};

	return (
		<Modal
			open={open}
			onClose={() => approval && handle(approval.intentEventId, false)}
			title={t("approval.title")}
			footer={
				approval && (
					<div className="flex w-full items-center justify-between gap-3">
						<span className="text-xs text-muted">{t("approval.hint")}</span>
						<div className="flex gap-2">
							<Button
								tone="neutral"
								variant="soft"
								onClick={() => handle(approval.intentEventId, false)}
								disabled={busy}
							>
								{t("approval.reject")}
							</Button>
							<Button
								tone="accent"
								variant="solid"
								onClick={() => handle(approval.intentEventId, true)}
								loading={busy}
							>
								{t("approval.approve")}
							</Button>
						</div>
					</div>
				)
			}
		>
			{approval && (
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-2">
						<Badge tone={toneForRisk(approval.risk)}>
							{t("approval.riskPrefix")} {riskLabel(approval.risk)}
						</Badge>
						{approval.category && (
							<Badge tone="neutral">{approval.category}</Badge>
						)}
						<span className="font-mono text-sm text-fg">{approval.toolName}</span>
					</div>

					{approval.description && (
						<p className="text-sm text-muted">{approval.description}</p>
					)}

					{approval.affectedFiles && approval.affectedFiles.length > 0 && (
						<div className="flex flex-col gap-1">
							{approval.affectedFiles.map((f) => (
								<code
									key={f}
									className="block truncate rounded bg-surface-2 px-2 py-1 font-mono text-xs text-fg"
									title={f}
								>
									{f}
								</code>
							))}
						</div>
					)}

					<pre
						className={cn(
							"max-h-64 overflow-auto rounded-lg bg-surface-2 p-3",
							"font-mono text-xs text-fg whitespace-pre-wrap break-all",
						)}
					>
						{formatArguments(approval.arguments)}
					</pre>
				</div>
			)}
		</Modal>
	);
}
