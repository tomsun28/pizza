/**
 * System prompt construction and project context loading
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

/**
 * Check if the current directory is a git repository
 */
function isGitRepository(cwd: string): boolean {
	try {
		const gitDir = existsSync(cwd) ? cwd : process.cwd();
		execSync("git rev-parse --is-inside-work-tree", { cwd: gitDir, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the environment section to append at the end of the system prompt
 */
function buildEnvironmentSection(cwd: string): string {
	const resolvedCwd = cwd.replace(/\\/g, "/");
	const isGit = isGitRepository(cwd);
	const platform = process.platform;
	const shell = process.env.SHELL || process.env.COMSPEC || "unknown";
	const osVersion = process.version;
	const nodeVersion = process.versions.node;

	return `
## Environment
You are being called in the following environment:
 - Primary working directory: ${resolvedCwd}
 - Is Git repository: ${isGit ? "Yes" : "No"}
 - Platform: ${platform}
 - Shell: ${shell}
 - Node.js version: ${nodeVersion}
 - OS version: ${osVersion}
`;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [bash] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Soul file placed at the very top of the prompt (main agent only). */
	soulFile?: { path: string; content: string };
	/** Long-term memory entries placed after the soul, before the body (main agent only). */
	longTermMemory?: Array<{ path: string; content: string }>;
	/**
	 * A mandatory-action banner placed at the very top of the prompt (before
	 * Identity) when the main agent's soul is still a placeholder. The model
	 * is instructed to address this before answering the user.
	 */
	mainAgentBanner?: string;
}

/**
 * Build the identity/long-term-memory prefix injected at the top of the prompt
 * for the persistent main agent. Returns an empty string for normal workspaces.
 */
function buildMainAgentPrefix(options: {
	soulFile?: { path: string; content: string };
	longTermMemory?: Array<{ path: string; content: string }>;
	mainAgentBanner?: string;
}): string {
	let prefix = "";

	// The banner goes ABOVE Identity so it is the very first thing the model
	// sees — this maximizes the chance the model acts on it before answering.
	if (options.mainAgentBanner) {
		prefix += `${options.mainAgentBanner}\n\n---\n\n`;
	}

	if (options.soulFile) {
		prefix += `# Identity\n\n${options.soulFile.content.trim()}\n\n`;
	}

	const memory = options.longTermMemory ?? [];
	if (memory.length > 0) {
		prefix += "# Long-Term Memory\n\n";
		prefix +=
			"Your long-term memory index is below. Read the referenced files on demand with the read command.\n\n";
		for (const { path: filePath, content } of memory) {
			prefix += `## ${filePath}\n\n${content.trim()}\n\n`;
		}
	}

	return prefix;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		soulFile,
		longTermMemory,
		mainAgentBanner,
	} = options;
	const resolvedCwd = cwd;
	const mainAgentPrefix = buildMainAgentPrefix({ soulFile, longTermMemory, mainAgentBanner });
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = mainAgentPrefix + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		// Add environment section at the end
		prompt += buildEnvironmentSection(resolvedCwd);

		return prompt;
	}

	// Build tools list - only cli is exposed via function calls.
	// read/write/edit are handled internally by the cli tool;
	// grep/find/ls and other commands are passed to the system shell as-is.
	const tools = selectedTools || (toolSnippets ? Object.keys(toolSnippets) : ["cli"]);
	const toolSnippetsMap: Record<string, string> = {
		cli: "Execute CLI commands",
		bash: "Execute shell commands",
		...toolSnippets,
	};
	const visibleTools = tools.filter((name) => !!toolSnippetsMap[name]);
	const toolsList =
		visibleTools.length > 0
			? visibleTools.map((name) => `- ${name}: ${toolSnippetsMap[name]}`)
			: "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasCli = tools.includes("cli") || tools.includes("bash");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasCli) {
		addGuideline("Use Pizza built-in file commands only for _read, _write, _edit, _session_split, _history_tree, and _delegate_agent");
		addGuideline("Built-in commands are NOT a shell: never use pipes (|), redirects (> <), chaining (; & &&), command substitution, or newlines with them. A built-in only works as the FIRST word of its own single cli() call — buried after &&/||/;/| it is passed to the shell, which has no such command. Issue each built-in as its own separate call; do not prefix it with cd && since the working directory is already set. For pipelines, redirections, or globs, use a plain shell command instead (grep, find, ls, cat, sed, git, npm, etc.).");
		addGuideline("Use _read line anchors as _edit range values; _edit accepts op/range/new edits. Use _edit op=search with old/new for search-and-replace when you don't have fresh line anchors (e.g. after using sed/cat, or after a previous edit shifted line numbers).");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");
	addGuideline("Keep reasoning tight: think only as much as the task needs, then act — avoid over-analyzing simple requests");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// Native CLI commands documentation
	const builtinCommandsSection = [
		"## Built-in Commands (executed internally by the cli tool)",
		"",
		"The cli tool recognizes only the following Pizza built-in commands and executes them internally (no shell fork):",
		"",
		"  _read <path> [offset] [limit]                Read file content with 2-hex line anchors",
		"  _write <path> <content>                       Write content to file",
		"  _write <path> <<EOF\ncontent\nEOF             Write multi-line content (heredoc)",
		"  _edit <path> <op> <range> [new]               Edit anchored whole line(s)",
		"  _session_split [reason] [name]                Split promptly when the user starts a new task or topic",
		"  _history_tree <action> [session_id]           Browse past sessions: list, view, jump, fork",
		"  _delegate_agent <action> [cwd] [task]         Main agent only: list known workspaces, run a sub-agent",
		"",
		"IMPORTANT: built-in commands are pure single commands. They do NOT support shell operators",
		"(no pipes |, redirects > <, chaining ; & &&, command substitution, or newlines). A built-in",
		"command is ALWAYS handled internally and never falls back to the shell — do not pipe or",
		"redirect it. grep, find, ls, git, npm, and all other commands are passed to the system shell,",
		"which handles native pipes, redirects, globs, command grouping, &&, and ;. If grep/find/ls",
		"are missing from PATH, Pizza injects temporary per-process shims for only those missing commands.",
		"",
		"Examples:",
		'- cli("_read src/main.ts") - Read a file; text lines include <line>#<2-hex-hash> anchors',
		'- cli("_read src/main.ts 10 50") - Read lines 10-60',
		'- cli("_write output.txt Hello World") - Write to a file',
		'- cli("_edit src/main.ts replace 12#ab \"const value = 2\"") - Replace an anchored line',
		'- cli("_edit src/main.ts insert_after 12#ab \"const next = 3\"") - Insert after an anchored line',
		'- cli("_edit src/main.ts delete 12#ab..14#de") - Delete an anchored range',
		'- cli("_edit src/main.ts search \"const a = 1\" \"const a = 2\"") - Search-and-replace without line anchors (fallback when anchors are stale or unavailable)',
		'- cli("_session_split topic_change") - Split when the conversation topic changes',
		'- cli("_session_split --reason topic_change --name \"Fix auth\"") - Split and name the new session',
		'- cli("_history_tree list") - Show the session history tree',
		'- cli("_history_tree jump sess_0042") - Return to a previous session and continue there',
		'- cli("grep -rn \"foo\" . | head") - Search with native shell pipeline',
		'- cli("find . -name \"*.py\" -maxdepth 2 | wc -l") - Find with native shell pipeline',
		'- cli("ls -lah *.py") - List files with shell glob expansion',
	].join("\n");

	let prompt = mainAgentPrefix + [
		"You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.",
		"",
		"Available tools:",
		toolsList,
		"",
		builtinCommandsSection,
		"",
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		"",
		"Guidelines:",
		guidelines,
		"",
		"Current date: " + date,
		"Current working directory: " + promptCwd,
	].join("\n");

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add environment section at the end
	prompt += buildEnvironmentSection(resolvedCwd);

	return prompt;
}
