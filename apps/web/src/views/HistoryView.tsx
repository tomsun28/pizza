import { useTranslation } from "react-i18next";
import { PageHeader, Card, EmptyState } from "@/components/ui";

export default function HistoryView() {
	const { t } = useTranslation();
	return (
		<div className="mx-auto max-w-5xl px-10 pb-10 pt-10">
			<PageHeader
				title={t("history.title")}
				description={t("history.description")}
			/>
			<Card>
				<EmptyState
					title={t("history.comingSoon")}
					description={t("history.comingSoonDescription")}
				/>
			</Card>
		</div>
	);
}
