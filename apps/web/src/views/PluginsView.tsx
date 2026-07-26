import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation, useOutletContext } from "react-router-dom";
import { PageHeader, Card, Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { fetchSkillsSh, getSkills, type SkillsShSkill, type SkillInfo } from "@/lib/transport";
import { ArrowLeft, ArrowRight, Puzzle, BookOpen, Server, Search, ExternalLink, Download, Check } from "lucide-react";
import type { LayoutOutletContext } from "@/components/Layout";

type PluginTab = "skills" | "extensions" | "mcp";

interface TabConfig {
	key: PluginTab;
	icon: typeof BookOpen;
}

const TABS: TabConfig[] = [
	{ key: "skills", icon: BookOpen },
	{ key: "extensions", icon: Puzzle },
	{ key: "mcp", icon: Server },
];

function InstalledSkillCard({ skill }: { skill: SkillInfo }) {
	const { t } = useTranslation();
	return (
		<Card className="transition-colors hover:border-accent/40">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<BookOpen className="h-4 w-4 shrink-0 text-accent" />
						<span className="truncate text-sm font-medium text-fg">{skill.name}</span>
					</div>
					{skill.description && (
						<p className="mt-2 line-clamp-2 text-xs text-muted">{skill.description}</p>
					)}
					<div className="mt-3 flex items-center gap-2">
						<Badge tone="success">{t("plugins.skills.installed")}</Badge>
						<code className="font-mono text-[10px] text-muted">{skill.command}</code>
					</div>
				</div>
				<Check className="h-4 w-4 shrink-0 text-success" />
			</div>
		</Card>
	);
}

function DirectorySkillCard({ skill, installed }: { skill: SkillsShSkill; installed: boolean }) {
	const { t } = useTranslation();
	return (
		<Card className="transition-colors hover:border-accent/40">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<BookOpen className="h-4 w-4 shrink-0 text-accent" />
						<span className="truncate text-sm font-medium text-fg">{skill.name}</span>
					</div>
					<p className="mt-2 line-clamp-1 text-xs text-muted">{skill.source}</p>
					<div className="mt-3 flex items-center gap-2">
						{installed ? (
							<Badge tone="success">{t("plugins.skills.installed")}</Badge>
						) : (
							<Badge tone="accent">{t("plugins.skills.type")}</Badge>
						)}
						<a
							href={skill.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-[10px] text-muted transition-colors hover:text-accent"
						>
							<ExternalLink className="h-3 w-3" />
							{t("plugins.skills.view")}
						</a>
					</div>
				</div>
				{!installed && (
					<a
						href={skill.url}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:border-accent hover:text-accent"
						title={t("plugins.skills.install")}
					>
						<Download className="h-3 w-3" />
						{t("plugins.skills.install")}
					</a>
				)}
			</div>
		</Card>
	);
}

function SkillsTab() {
	const { t } = useTranslation();
	const [dirSkills, setDirSkills] = useState<SkillsShSkill[]>([]);
	const [installedSkills, setInstalledSkills] = useState<SkillInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [search, setSearch] = useState("");

	const refresh = useCallback(async () => {
		try {
			setLoading(true);
			setError("");
			// Load both in parallel — local skills may fail if sidecar is down
			const [dir, local] = await Promise.allSettled([
				fetchSkillsSh(),
				getSkills(),
			]);
			if (dir.status === "fulfilled") setDirSkills(dir.value);
			if (local.status === "fulfilled") setInstalledSkills(local.value);
			if (dir.status === "rejected" && local.status === "rejected") {
				setError(dir.reason instanceof Error ? dir.reason.message : String(dir.reason));
			}
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const installedNames = new Set(installedSkills.map((s) => s.name));
	const filteredDir = search.trim()
		? dirSkills.filter(
				(s) =>
					s.name.toLowerCase().includes(search.toLowerCase()) ||
					s.source.toLowerCase().includes(search.toLowerCase()) ||
					s.slug.toLowerCase().includes(search.toLowerCase()),
			)
		: dirSkills;
	const filteredLocal = search.trim()
		? installedSkills.filter(
				(s) =>
					s.name.toLowerCase().includes(search.toLowerCase()) ||
					s.description?.toLowerCase().includes(search.toLowerCase()),
			)
		: installedSkills;

	if (loading) {
		return (
			<Card>
				<div className="text-sm text-muted">{t("plugins.loading")}</div>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<div className="text-sm text-danger">{t("plugins.error", { error })}</div>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("plugins.skills.search")}
						className="w-full rounded-md border border-border bg-surface px-9 py-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
				</div>
				<Button size="sm" tone="neutral" onClick={refresh}>
					{t("plugins.refresh")}
				</Button>
			</div>

				{filteredLocal.length > 0 && (
				<>
					<h2 className="mb-3 text-sm font-semibold text-fg">
						{t("plugins.skills.installedSection")} ({filteredLocal.length})
					</h2>
					<div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
						{filteredLocal.map((skill) => (
							<InstalledSkillCard key={skill.command} skill={skill} />
						))}
					</div>
				</>
			)}

			<h2 className="mb-3 text-sm font-semibold text-fg">
				{t("plugins.skills.directorySection")} ({filteredDir.length})
			</h2>

			{filteredDir.length === 0 ? (
				<Card>
					<div className="py-6 text-center">
						<BookOpen className="mx-auto mb-2 h-8 w-8 text-muted/40" />
						<p className="font-mono text-xs text-muted">{t("plugins.skills.empty")}</p>
						<p className="mt-1 font-mono text-[10px] text-muted">{t("plugins.skills.emptyHint")}</p>
					</div>
				</Card>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{filteredDir.map((skill) => (
						<DirectorySkillCard
							key={skill.id}
							skill={skill}
							installed={installedNames.has(skill.slug)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ComingSoonTab({ icon: Icon, title, description }: { icon: typeof BookOpen; title: string; description: string }) {
	return (
		<Card>
			<div className="py-8 text-center">
				<Icon className="mx-auto mb-3 h-10 w-10 text-muted/30" />
				<p className="font-mono text-sm text-muted">{title}</p>
				<p className="mt-2 font-mono text-xs text-muted/60">{description}</p>
			</div>
		</Card>
	);
}

export default function PluginsView() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const { sidebarCollapsed } = useOutletContext<LayoutOutletContext>() ?? { sidebarCollapsed: false };
	const [tab, setTab] = useState<PluginTab>("skills");

	const histIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
	const canBack = histIdx > 0;
	const canForward = histIdx > 0 && location.key !== "";

	return (
		<div className="flex h-full flex-col">
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

			<div className="scrollbar-hide flex-1 overflow-y-auto">
				<div className="mx-auto max-w-5xl px-10 pb-10 pt-10">
					<PageHeader title={t("plugins.title")} description={t("plugins.description")} />

					<div className="mb-6 flex gap-1 border-b border-border">
						{TABS.map(({ key, icon: Icon }) => (
							<button
								key={key}
								onClick={() => setTab(key)}
								className={cn(
									"flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors",
									tab === key
										? "border-b-2 border-accent text-accent"
										: "text-muted hover:text-fg",
								)}
							>
								<Icon className="h-3.5 w-3.5" />
								{t(`plugins.tabs.${key}`)}
							</button>
						))}
					</div>

					{tab === "skills" && <SkillsTab />}
					{tab === "extensions" && (
						<ComingSoonTab
							icon={Puzzle}
							title={t("plugins.extensions.comingSoon")}
							description={t("plugins.extensions.comingSoonHint")}
						/>
					)}
					{tab === "mcp" && (
						<ComingSoonTab
							icon={Server}
							title={t("plugins.mcp.comingSoon")}
							description={t("plugins.mcp.comingSoonHint")}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
