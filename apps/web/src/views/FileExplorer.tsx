import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Folder,
	FolderOpen,
	File as FileIcon,
	Search,
	ChevronRight,
	ChevronDown,
	RefreshCw,
	ArrowLeft,
	Copy,
} from "lucide-react";
import { listDir, readFileContent, type DirEntry } from "@/lib/transport";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getLanguage(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
		json: "json", md: "markdown", rs: "rust", go: "go",
		py: "python", rb: "ruby", java: "java", c: "c", cpp: "cpp",
		h: "c", hpp: "cpp", css: "css", html: "html", xml: "xml",
		yaml: "yaml", yml: "yaml", toml: "toml", sh: "bash",
		bash: "bash", zsh: "bash", sql: "sql", graphql: "graphql",
		vue: "vue", svelte: "svelte", txt: "text", env: "text",
		lock: "text", gitignore: "text", dockerfile: "docker",
	};
	return map[ext] ?? "text";
}

function isTextFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const textExts = [
		"ts", "tsx", "js", "jsx", "json", "md", "rs", "go", "py",
		"rb", "java", "c", "cpp", "h", "hpp", "css", "html", "xml",
		"yaml", "yml", "toml", "sh", "bash", "zsh", "sql", "graphql",
		"vue", "svelte", "txt", "env", "lock", "gitignore", "dockerfile",
		"ini", "cfg", "conf", "properties", "gradle", "kt", "swift",
		"scala", "clj", "ex", "exs", "erl", "hs", "ml", "lua", "r",
		"dart", "elm", "nim", "v", "zig", "wasm", "asm", "s",
	];
	return textExts.includes(ext) || ext === "";
}

interface TreeNode extends DirEntry {
	children?: TreeNode[];
	loaded?: boolean;
	loading?: boolean;
}

export default function FileExplorer({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [tree, setTree] = useState<TreeNode[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState("");
	const [fileLoading, setFileLoading] = useState(false);
	const [fileError, setFileError] = useState("");
	const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
	const fileContentRef = useRef<HTMLDivElement>(null);

	const cwd = workspace ?? "";

	const loadRoot = useCallback(async () => {
		if (!cwd) return;
		try {
			setError("");
			const entries = await listDir(cwd);
			setTree(entries.map((e) => ({ ...e, loaded: e.is_dir ? false : undefined })));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		setLoading(true);
		setTree([]);
		setExpanded(new Set());
		setSelectedFile(null);
		setFileContent("");
		setBreadcrumb([]);
		void loadRoot();
	}, [cwd, loadRoot]);

	const loadChildren = useCallback(
		async (nodePath: string) => {
			if (!cwd) return;
			setTree((prev) => updateNodeLoading(prev, nodePath, true));
			try {
				const entries = await listDir(cwd, nodePath);
				setTree((prev) =>
					updateNodeChildren(prev, nodePath, entries.map((e) => ({ ...e, loaded: e.is_dir ? false : undefined }))),
				);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[cwd],
	);

	const toggleExpand = useCallback(
		(nodePath: string) => {
			setExpanded((prev) => {
				const next = new Set(prev);
				if (next.has(nodePath)) {
					next.delete(nodePath);
				} else {
					next.add(nodePath);
					// Lazy-load children if not yet loaded.
					const node = findNode(tree, nodePath);
					if (node && node.is_dir && !node.loaded && !node.loading) {
						void loadChildren(nodePath);
					}
				}
				return next;
			});
		},
		[tree, loadChildren],
	);

	const openFile = useCallback(
		async (filePath: string) => {
			if (!cwd) return;
			setSelectedFile(filePath);
			setFileContent("");
			setFileError("");
			setFileLoading(true);
			// Update breadcrumb from path segments.
			setBreadcrumb(filePath.split("/").filter(Boolean));
			try {
				const content = await readFileContent(cwd, filePath);
				setFileContent(content);
			} catch (e) {
				setFileError(e instanceof Error ? e.message : String(e));
			} finally {
				setFileLoading(false);
			}
		},
		[cwd],
	);

	// Filtered flat list for search mode.
	const searchResults = useMemo(() => {
		if (!query.trim()) return null;
		// Search through all loaded nodes recursively.
		const results: TreeNode[] = [];
		const walk = (nodes: TreeNode[]) => {
			for (const node of nodes) {
				if (node.name.toLowerCase().includes(query.toLowerCase())) {
					results.push(node);
				}
				if (node.children) walk(node.children);
			}
		};
		walk(tree);
		return results;
	}, [query, tree]);

	const lang = selectedFile ? getLanguage(selectedFile) : "text";

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("files.search")}
						className="w-full rounded-md border border-border bg-bg py-1 pl-7 pr-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
					/>
				</div>
				<button
					onClick={() => void loadRoot()}
					className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
					title={t("files.refresh")}
				>
					<RefreshCw className="h-3.5 w-3.5" />
				</button>
			</div>

			{error && <div className="px-3 pt-2"><ErrorBanner message={error} /></div>}

			{/* Tree or search results */}
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{loading ? (
					<div className="flex h-full items-center justify-center"><Spinner /></div>
				) : tree.length === 0 ? (
					<div className="p-4">
						<EmptyState title={t("files.emptyTitle")} description={t("files.emptyDescription")} />
					</div>
				) : query.trim() && searchResults ? (
					<ul className="font-mono text-xs">
						{searchResults.length === 0 ? (
							<li className="px-3 py-2 text-muted">{t("files.noMatch")}</li>
						) : (
							searchResults.map((node) => (
								<li
									key={node.path}
									onClick={() => (node.is_dir ? void toggleExpand(node.path) : void openFile(node.path))}
									className={cn(
										"flex cursor-pointer items-center gap-1.5 px-3 py-1.5 transition-colors hover:bg-surface-2",
										selectedFile === node.path && "bg-accent/10",
									)}
									title={node.path}
								>
									{node.is_dir ? (
										<Folder className="h-3.5 w-3.5 shrink-0 text-muted" />
									) : (
										<FileIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
									)}
									<span className="truncate text-fg">{node.name}</span>
									<span className="ml-auto shrink-0 text-[10px] text-muted">{node.path}</span>
								</li>
							))
						)}
					</ul>
				) : (
					<TreeList
						nodes={tree}
						expanded={expanded}
						selectedFile={selectedFile}
						onToggle={toggleExpand}
						onOpenFile={openFile}
						depth={0}
					/>
				)}
			</div>

			{/* File content viewer */}
			{selectedFile && (
				<div className="flex shrink-0 flex-col border-t border-border" style={{ height: "45%" }}>
					{/* File header with breadcrumb + close */}
					<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
						<button
							onClick={() => { setSelectedFile(null); setFileContent(""); setBreadcrumb([]); }}
							className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg"
							title={t("files.closeFile")}
						>
							<ArrowLeft className="h-3.5 w-3.5" />
						</button>
						<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-[11px] text-muted">
							{breadcrumb.map((seg, i) => (
								<span key={i} className="flex items-center gap-0.5 whitespace-nowrap">
									{i > 0 && <ChevronRight className="h-3 w-3" />}
									<span className={cn(i === breadcrumb.length - 1 && "text-fg")}>{seg}</span>
								</span>
							))}
						</div>
						<button
							onClick={() => void navigator.clipboard?.writeText(fileContent)}
							className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg"
							title={t("common.copy")}
						>
							<Copy className="h-3.5 w-3.5" />
						</button>
					</div>
					{/* Content */}
					<div ref={fileContentRef} className="min-h-0 flex-1 overflow-auto bg-bg">
						{fileLoading ? (
							<div className="flex h-full items-center justify-center"><Spinner /></div>
						) : fileError ? (
							<div className="p-3"><ErrorBanner message={fileError} /></div>
						) : (
							<pre className="p-3 font-mono text-[11px] leading-relaxed text-fg">
								<code className={`language-${lang}`}>{fileContent}</code>
							</pre>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function TreeList({
	nodes,
	expanded,
	selectedFile,
	onToggle,
	onOpenFile,
	depth,
}: {
	nodes: TreeNode[];
	expanded: Set<string>;
	selectedFile: string | null;
	onToggle: (path: string) => void;
	onOpenFile: (path: string) => void;
	depth: number;
}) {
	return (
		<ul className="font-mono text-xs">
			{nodes.map((node) => (
				<TreeItem
					key={node.path}
					node={node}
					expanded={expanded}
					selectedFile={selectedFile}
					onToggle={onToggle}
					onOpenFile={onOpenFile}
					depth={depth}
				/>
			))}
		</ul>
	);
}

function TreeItem({
	node,
	expanded,
	selectedFile,
	onToggle,
	onOpenFile,
	depth,
}: {
	node: TreeNode;
	expanded: Set<string>;
	selectedFile: string | null;
	onToggle: (path: string) => void;
	onOpenFile: (path: string) => void;
	depth: number;
}) {
	const isOpen = expanded.has(node.path);
	const indent = depth * 16 + 12;

	return (
		<li>
			<div
				onClick={() => (node.is_dir ? onToggle(node.path) : onOpenFile(node.path))}
				className={cn(
					"flex cursor-pointer items-center gap-1.5 py-1 pr-3 transition-colors hover:bg-surface-2",
					selectedFile === node.path && "bg-accent/10",
				)}
				style={{ paddingLeft: indent }}
				title={node.path}
			>
				{node.is_dir ? (
					<>
						{isOpen ? (
							<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
						) : (
							<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
						)}
						{isOpen ? (
							<FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
						) : (
							<Folder className="h-3.5 w-3.5 shrink-0 text-muted" />
						)}
					</>
				) : (
					<>
						<span className="w-3.5 shrink-0" />
						<FileIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
					</>
				)}
				<span className={cn("truncate", node.is_dir ? "text-fg" : "text-fg")}>
					{node.name}
				</span>
				{!node.is_dir && node.size > 0 && (
					<span className="ml-auto shrink-0 text-[10px] text-muted">{formatSize(node.size)}</span>
				)}
			</div>
			{node.is_dir && isOpen && (
				<>
					{node.loading && !node.loaded ? (
						<div className="flex items-center gap-2 py-1" style={{ paddingLeft: indent + 16 }}>
							<Spinner />
						</div>
					) : node.children && node.children.length > 0 ? (
						<TreeList
							nodes={node.children}
							expanded={expanded}
							selectedFile={selectedFile}
							onToggle={onToggle}
							onOpenFile={onOpenFile}
							depth={depth + 1}
						/>
					) : (
						<div className="py-1 font-mono text-[10px] text-muted" style={{ paddingLeft: indent + 16 }}>
							(empty)
						</div>
					)}
				</>
			)}
		</li>
	);
}

// --- Tree helpers ---

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
	for (const node of nodes) {
		if (node.path === path) return node;
		if (node.children) {
			const found = findNode(node.children, path);
			if (found) return found;
		}
	}
	return null;
}

function updateNodeLoading(nodes: TreeNode[], path: string, loading: boolean): TreeNode[] {
	return nodes.map((node) => {
		if (node.path === path) {
			return { ...node, loading };
		}
		if (node.children) {
			return { ...node, children: updateNodeLoading(node.children, path, loading) };
		}
		return node;
	});
}

function updateNodeChildren(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
	return nodes.map((node) => {
		if (node.path === path) {
			return { ...node, children, loaded: true, loading: false };
		}
		if (node.children) {
			return { ...node, children: updateNodeChildren(node.children, path, children) };
		}
		return node;
	});
}
