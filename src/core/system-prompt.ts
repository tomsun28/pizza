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
	} = options;
	const resolvedCwd = cwd;
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
		let prompt = customPrompt;

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
		addGuideline("Use Pizza built-in file commands only for read, write, edit, and session_split");
		addGuideline("Use shell commands such as grep, find, and ls normally; shell handles pipes, redirects, globs, &&, and ;");
		addGuideline("Use read line anchors as edit range values; edit accepts op/range/new edits");
		addGuideline("Use edit op=search with old/new for search-and-replace when you don't have fresh line anchors (e.g. after using sed/cat, or after a previous edit shifted line numbers)");
		addGuideline("Only call session_split when the user's request is clearly unrelated to the current conversation topic");
		addGuideline("Do not call session_split for follow-up questions, clarifications, or refinements of the current task");
		addGuideline("Call session_split at most once per turn; after the split, your context is refreshed so proceed with the task");
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

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// Native CLI commands documentation
	const builtinCommandsSection = [
		"## Built-in Commands (executed internally by the cli tool)",
		"",
		"The cli tool recognizes only the following Pizza built-in commands and executes them internally (no shell fork):",
		"",
		"  read <path> [offset] [limit]                Read file content with 2-hex line anchors",
		"  write <path> <content>                       Write content to file",
		"  write <path> <<EOF\ncontent\nEOF             Write multi-line content (heredoc)",
		"  edit <path> <op> <range> [new]               Edit anchored whole line(s)",
		"  session_split [reason] [name]                Split conversation when the topic clearly changes",
		"",
		"grep, find, ls, git, npm, and all other commands are passed to the system shell as-is.",
		"The shell handles native pipes, redirects, globs, command grouping, &&, and ;. If grep/find/ls are missing from PATH, Pizza injects temporary per-process shims for only those missing commands.",
		"",
		"Examples:",
		'- cli("read src/main.ts") - Read a file; text lines include <line>#<2-hex-hash> anchors',
		'- cli("read src/main.ts 10 50") - Read lines 10-60',
		'- cli("write output.txt Hello World") - Write to a file',
		'- cli("edit src/main.ts replace 12#ab \"const value = 2\"") - Replace an anchored line',
		'- cli("edit src/main.ts insert_after 12#ab \"const next = 3\"") - Insert after an anchored line',
		'- cli("edit src/main.ts delete 12#ab..14#de") - Delete an anchored range',
		'- cli("edit src/main.ts search \"const a = 1\" \"const a = 2\"") - Search-and-replace without line anchors (fallback when anchors are stale or unavailable)',
		'- cli("session_split topic_change") - Split when the conversation topic changes',
		'- cli("session_split --reason topic_change --name \"Fix auth\"") - Split and name the new session',
		'- cli("grep -rn \"foo\" . | head") - Search with native shell pipeline',
		'- cli("find . -name \"*.py\" -maxdepth 2 | wc -l") - Find with native shell pipeline',
		'- cli("ls -lah *.py") - List files with shell glob expansion',
	].join("\n");

	let prompt = [
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
