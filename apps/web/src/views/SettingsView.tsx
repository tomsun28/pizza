import type { ReactNode } from "react";
import { PageHeader, Card, Badge } from "@/components/ui";
import type { RpcSessionState } from "@/lib/types";

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center justify-between border-b border-border/60 py-3 last:border-0">
			<span className="text-sm text-fg">{label}</span>
			<span className="text-sm text-muted">{children}</span>
		</div>
	);
}

export default function SettingsView({
	state,
}: {
	state: RpcSessionState | null;
}) {
	return (
		<div className="mx-auto max-w-5xl px-10 pb-10 pt-10">
			<PageHeader
				title="Settings"
				description="Session and model configuration"
			/>

			{state ? (
				<div className="space-y-6">
					<Card>
						<div className="mb-2 text-sm font-medium text-fg">Session</div>
						<Row label="Session ID">
							<span className="font-mono">{state.sessionId}</span>
						</Row>
						<Row label="Session File">
							<span className="font-mono">{state.sessionFile ?? "—"}</span>
						</Row>
						<Row label="Messages">
							<span className="font-mono">{state.messageCount}</span>
						</Row>
					</Card>

					<Card>
						<div className="mb-2 text-sm font-medium text-fg">Model</div>
						<Row label="Provider">
							<span className="font-mono">{state.model?.provider ?? "—"}</span>
						</Row>
						<Row label="Model">
							<span className="font-mono">{state.model?.id ?? "—"}</span>
						</Row>
						<Row label="Thinking Level">
							<Badge tone="accent">{state.thinkingLevel}</Badge>
						</Row>
					</Card>

					<Card>
						<div className="mb-2 text-sm font-medium text-fg">Compaction</div>
						<Row label="Auto Compaction">
							{state.autoCompactionEnabled ? (
								<Badge tone="success">Enabled</Badge>
							) : (
								<Badge tone="neutral">Disabled</Badge>
							)}
						</Row>
						<Row label="Status">
							{state.isCompacting ? (
								<Badge tone="warning">Compacting...</Badge>
							) : (
								<Badge tone="neutral">Idle</Badge>
							)}
						</Row>
					</Card>
				</div>
			) : (
				<Card>
					<div className="text-sm text-muted">No session active.</div>
				</Card>
			)}
		</div>
	);
}
