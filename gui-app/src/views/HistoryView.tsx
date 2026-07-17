import { PageHeader, Card, EmptyState } from "@/components/ui";

export default function HistoryView() {
	return (
		<div className="mx-auto max-w-5xl px-10 pb-10 pt-10">
			<PageHeader
				title="History"
				description="Session tree and branch navigation"
			/>
			<Card>
				<EmptyState
					title="Coming soon"
					description="History tree visualization will be available in a future update."
				/>
			</Card>
		</div>
	);
}
