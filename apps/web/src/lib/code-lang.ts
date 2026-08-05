/**
 * File path → highlight.js language id mapping, used by the CodeViewer.
 * Lives outside the component module so React Fast Refresh keeps working.
 */

/** Map a file extension to a highlight.js language id. */
const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "json", md: "markdown", mdx: "markdown",
	rs: "rust", go: "go", py: "python", rb: "ruby", java: "java",
	kt: "kotlin", kts: "kotlin", swift: "swift", scala: "scala",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
	cs: "csharp", php: "php", pl: "perl", lua: "lua", r: "r", dart: "dart",
	css: "css", scss: "scss", less: "less", html: "xml", htm: "xml",
	vue: "xml", svelte: "xml", xml: "xml", svg: "xml",
	yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
	sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
	sql: "sql", graphql: "graphql", gql: "graphql",
	dockerfile: "dockerfile", makefile: "makefile", diff: "diff", patch: "diff",
};

/** Files whose *name* (not extension) determines the language. */
const NAME_TO_LANG: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	".gitignore": "bash",
	".env": "bash",
};

/** Resolve a highlight.js language id for `filePath`, or "plaintext". */
export function languageForPath(filePath: string): string {
	const name = filePath.split("/").pop()?.toLowerCase() ?? "";
	if (NAME_TO_LANG[name]) return NAME_TO_LANG[name]!;
	const ext = name.includes(".") ? name.split(".").pop()! : "";
	return EXT_TO_LANG[ext] ?? "plaintext";
}
