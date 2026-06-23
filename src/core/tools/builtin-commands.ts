/**
 * Built-in CLI commands for file operations.
 * These are exposed to the LLM via the bash tool.
 * 
 * Supports heredoc syntax for multi-line content:
 *   write <path> <<EOF
 *   line1
 *   line2
 *   EOF
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, join } from "path";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { annotateTextWithLineAnchors } from "./line-anchors.js";
import { truncateHead } from "./truncate.js";

export interface BuiltinCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

// ============================================================================
// Heredoc Parser
// ============================================================================

export interface ParsedBuiltinCommand {
	command: string;
	args: string[];
	heredoc?: string;
}

export type ParsedBuiltinToolInput =
	| {
			command: "read";
			input: { path: string; offset?: number; limit?: number; anchors?: "line" | "none" };
	  }
	| {
			command: "write";
			input: { path: string; content: string };
	  }
	| {
			command: "edit";
			input: { path: string; edits: Array<{ rangeId: string; newText: string }> };
	  };

/**
 * Parse builtin command with optional heredoc.
 * Supports:
 *   write <path> <<EOF
 *   line1
 *   line2
 *   EOF
 */
export function parseBuiltinCommandWithHeredoc(input: string): ParsedBuiltinCommand | null {
	const trimmed = input.trim();
	
	// Match: command args <<DELIM\ncontent\nDELIM
	const heredocMatch = trimmed.match(/^(.*?)\s+<<\s*(\w+)\s*\n([\s\S]*)\n\2\s*$/);
	if (!heredocMatch) {
		return null;
	}
	
	const [, prefix, delimiter, content] = heredocMatch;
	const parts = splitShellWords(prefix.trim());
	
	return {
		command: parts[0],
		args: parts.slice(1),
		heredoc: content,
	};
}

export function parseBuiltinCommand(input: string): ParsedBuiltinCommand {
	const parsedHeredoc = parseBuiltinCommandWithHeredoc(input);
	if (parsedHeredoc) {
		return parsedHeredoc;
	}
	const parts = splitShellWords(input.trim());
	return {
		command: parts[0] ?? "",
		args: parts.slice(1),
	};
}

export function parseBuiltinToolInput(
	command: string,
	args: string[],
	heredoc?: string,
): ParsedBuiltinToolInput | null {
	const normalized = command.toLowerCase();
	switch (normalized) {
		case "read":
			return { command: "read", input: parseReadInput(args) };
		case "write":
			return { command: "write", input: parseWriteInput(args, heredoc) };
		case "edit":
			return { command: "edit", input: parseEditInput(args) };
		default:
			return null;
	}
}

function parseReadInput(args: string[]): { path: string; offset?: number; limit?: number; anchors?: "line" | "none" } {
	let path = "";
	let offset: number | undefined;
	let limit: number | undefined;
	let anchors: "line" | "none" | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--offset" || arg === "-o") {
			offset = parseOptionalInt(args[++i]);
		} else if (arg === "--limit" || arg === "-l") {
			limit = parseOptionalInt(args[++i]);
		} else if (arg === "--anchors") {
			const value = args[++i];
			if (value !== "line" && value !== "none") {
				throw new Error('read --anchors must be "line" or "none"');
			}
			anchors = value;
		} else if (arg === "--raw") {
			anchors = "none";
		} else if (!path) {
			path = arg;
		} else if (offset === undefined) {
			offset = parseOptionalInt(arg);
		} else if (limit === undefined) {
			limit = parseOptionalInt(arg);
		}
	}

	return { path, offset, limit, anchors };
}

function parseWriteInput(args: string[], heredoc?: string): { path: string; content: string } {
	let path = "";
	let content: string | undefined = heredoc;
	const positionalContent: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--content" || arg === "-c") {
			content = args[++i] ?? "";
		} else if (!path) {
			path = arg;
		} else if (content === undefined) {
			positionalContent.push(arg);
		}
	}

	if (content === undefined) {
		content = positionalContent.join(" ");
	}

	return { path, content };
}

function parseEditInput(args: string[]): { path: string; edits: Array<{ rangeId: string; newText: string }> } {
	let path = "";
	let editsJson: string | undefined;
	const edits: Array<{ rangeId: string; newText: string }> = [];
	const positional: string[] = [];
	let pendingRangeId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--edits" || arg === "-e") {
			editsJson = args[++i] ?? "[]";
		} else if (arg === "--old" || arg === "-o") {
			throw new Error("edit no longer supports --old. Read the file and use --range-id from the line anchors.");
		} else if (arg === "--range-id" || arg === "--rangeId" || arg === "--range" || arg === "-r") {
			pendingRangeId = args[++i] ?? "";
		} else if (arg === "--new" || arg === "-n") {
			const newText = args[++i] ?? "";
			if (pendingRangeId !== undefined) {
				edits.push({ rangeId: pendingRangeId, newText });
				pendingRangeId = undefined;
			}
		} else if (!path) {
			path = arg;
		} else {
			positional.push(arg);
		}
	}

	if (editsJson !== undefined) {
		const parsed = JSON.parse(editsJson) as unknown;
		if (!Array.isArray(parsed)) {
			throw new Error("edit --edits must be a JSON array");
		}
		for (const entry of parsed) {
			if (
				!entry ||
				typeof entry !== "object" ||
				typeof (entry as { rangeId?: unknown }).rangeId !== "string" ||
				typeof (entry as { newText?: unknown }).newText !== "string"
			) {
				throw new Error("edit --edits entries must include string rangeId and newText");
			}
			edits.push({
				rangeId: (entry as { rangeId: string }).rangeId,
				newText: (entry as { newText: string }).newText,
			});
		}
	}

	if (pendingRangeId !== undefined) {
		edits.push({ rangeId: pendingRangeId, newText: "" });
	}

	if (edits.length === 0 && positional.length >= 2) {
		edits.push({
			rangeId: positional[0] ?? "",
			newText: positional.slice(1).join(" "),
		});
	}

	return { path, edits };
}

function parseOptionalInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function splitShellWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) {
		current += "\\";
	}
	if (current.length > 0) {
		words.push(current);
	}
	return words;
}

function isHelpRequest(args: string[]): boolean {
	if (args.length !== 1) return false;
	const value = args[0]?.toLowerCase();
	return value === "-h" || value === "--help" || value === "help";
}

export function getBuiltinCommandHelp(command: string): string | undefined {
	switch (command.toLowerCase()) {
		case "read":
			return [
				"read - Read a file",
				"",
				"Description:",
				"  Reads a text file or supported image file from the current working directory.",
				"  Text output includes hashline anchors by default: L<line>#<hash> | content.",
				"  Use those anchors as edit rangeId values. Images are returned as image content",
				"  when routed through the bash tool's built-in read implementation.",
				"",
				"Parameters:",
				"  path              File path to read. Relative paths are resolved from the working directory.",
				"  offset            Optional 1-based line number to start reading from.",
				"  limit             Optional maximum number of lines to return.",
				"  --path, -p        File path to read.",
				"  --offset, -o      1-based line number to start reading from.",
				"  --limit, -l       Maximum number of lines to return.",
				"  --anchors         line or none. Defaults to line.",
				"  --raw             Alias for --anchors none.",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  read src/main.ts",
				"  read src/main.ts 20",
				"  read src/main.ts 20 50",
				"  read --path src/main.ts --offset 20 --limit 50",
				"  read -p src/main.ts -o 20 -l 50",
				"  read --path src/main.ts --anchors none",
			].join("\n");
		case "write":
			return [
				"write - Create or overwrite a file",
				"",
				"Description:",
				"  Writes complete content to a file. Creates parent directories when needed.",
				"  If the target file already exists, it is overwritten.",
				"",
				"Parameters:",
				"  path              Target file path. Relative paths are resolved from the working directory.",
				"  content           Complete file content to write.",
				"  --path, -p        Target file path.",
				"  --content, -c     Complete file content to write.",
				"  <<EOF             Heredoc form for multi-line content.",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  write notes.txt hello",
				"  write --path notes.txt --content \"hello world\"",
				"  write -p notes.txt -c \"hello world\"",
				"  write src/generated.ts <<EOF",
				"  export const value = 1;",
				"  EOF",
			].join("\n");
		case "edit":
			return [
				"edit - Edit a file with read rangeId anchors",
				"",
				"Description:",
				"  Edits one existing file using hashline range ids from read output. Each edit",
				"  replaces one whole line or a continuous whole-line range. Range ids fail safely",
				"  if the referenced lines changed or became ambiguous.",
				"",
				"Parameters:",
				"  path              File path to edit. Relative paths are resolved from the working directory.",
				"  rangeId           Line anchor or range from read output, e.g. L12#deadbeef or L12#deadbeef..L14#c0ffee00.",
				"  newText           Replacement text.",
				"  --path, -p        File path to edit.",
				"  --range-id, -r    Line anchor or range from read output. Can be paired with --new.",
				"  --new, -n         Replacement text. Can be paired with --range-id.",
				"  --edits, -e       JSON array of {\"rangeId\":\"...\",\"newText\":\"...\"} replacements.",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  read src/app.ts",
				"  edit src/app.ts L12#deadbeef \"const a = 2\"",
				"  edit --path src/app.ts --range-id L12#deadbeef --new \"const a = 2\"",
				"  edit --path src/app.ts --edits '[{\"rangeId\":\"L12#deadbeef\",\"newText\":\"const a = 2\"}]'",
			].join("\n");
		default:
			return undefined;
	}
}

export function getBuiltinCommandHelpForArgs(command: string, args: string[]): string | undefined {
	if (!isHelpRequest(args)) return undefined;
	return getBuiltinCommandHelp(command);
}

/** @deprecated Use parseBuiltinCommandWithHeredoc */
export const parseCommandWithHeredoc = parseBuiltinCommandWithHeredoc;

// ============================================================================
// Read Command
// ============================================================================

interface ReadOptions {
	path: string;
	offset?: number;
	limit?: number;
	anchors?: "line" | "none";
	cwd: string;
}

async function executeRead(options: ReadOptions): Promise<BuiltinCommandResult> {
	try {
		const filePath = resolve(options.cwd, options.path);
		const anchors = options.anchors ?? "line";
		const rawContent = await readFile(filePath, "utf-8");
		const content = anchors === "line" ? normalizeToLF(rawContent) : rawContent;
		let lines = content.split("\n");
		const totalLines = lines.length;

		// Apply offset (1-indexed)
		const startLine = options.offset && options.offset > 0 ? options.offset - 1 : 0;
		if (startLine > 0) {
			lines = lines.slice(startLine);
		}

		// Apply limit
		let userLimited = false;
		if (options.limit !== undefined && options.limit > 0) {
			lines = lines.slice(0, options.limit);
			userLimited = true;
		}

		// Apply truncation
		const truncation = truncateHead(lines.join("\n"));
		const startLineDisplay = startLine + 1;
		let output =
			anchors === "line" ? annotateTextWithLineAnchors(truncation.content, startLineDisplay) : truncation.content;

		if (truncation.truncated) {
			const endLine = startLineDisplay + truncation.outputLines - 1;
			const nextOffset = endLine + 1;
			output += `\n\n[Showing lines ${startLineDisplay}-${endLine} of ${totalLines}. Use: read ${options.path} ${nextOffset}]`;
		} else if (userLimited && startLine + lines.length < totalLines) {
			const remaining = totalLines - (startLine + lines.length);
			const nextOffset = startLine + lines.length + 1;
			output += `\n\n[${remaining} more lines. Use: read ${options.path} ${nextOffset}]`;
		}

		return {
			stdout: output,
			stderr: "",
			exitCode: 0,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: `Error reading file: ${message}`,
			exitCode: 1,
		};
	}
}

// ============================================================================
// Write Command
// ============================================================================

interface WriteOptions {
	path: string;
	content: string;
	cwd: string;
}

async function executeWrite(options: WriteOptions): Promise<BuiltinCommandResult> {
	try {
		const filePath = resolve(options.cwd, options.path);

		// Ensure parent directory exists
		const parentDir = join(filePath, "..");
		await mkdir(parentDir, { recursive: true });

		await writeFile(filePath, options.content, "utf-8");
		return {
			stdout: `File written: ${options.path}`,
			stderr: "",
			exitCode: 0,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: `Error writing file: ${message}`,
			exitCode: 1,
		};
	}
}

// ============================================================================
// Edit Command
// ============================================================================

interface EditOptions {
	path: string;
	edits: Array<{ rangeId: string; newText: string }>;
	cwd: string;
}

async function executeEdit(options: EditOptions): Promise<BuiltinCommandResult> {
	try {
		const filePath = resolve(options.cwd, options.path);
		const rawContent = await readFile(filePath, "utf-8");
		const { bom, text: content } = stripBom(rawContent);
		const originalEnding = detectLineEnding(content);
		const normalizedContent = normalizeToLF(content);
		const { newContent } = applyEditsToNormalizedContent(normalizedContent, options.edits, options.path);
		await writeFile(filePath, bom + restoreLineEndings(newContent, originalEnding), "utf-8");

		return {
			stdout: `File edited: ${options.path}`,
			stderr: "",
			exitCode: 0,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: `Error editing file: ${message}`,
			exitCode: 1,
		};
	}
}

// ============================================================================
// Main Router
// ============================================================================

export interface BuiltinCommandContext {
	cwd: string;
}

export async function executeBuiltinCommand(
	command: string,
	args: string[],
	context: BuiltinCommandContext,
): Promise<BuiltinCommandResult> {
	const help = getBuiltinCommandHelpForArgs(command, args);
	if (help) {
		return {
			stdout: help,
			stderr: "",
			exitCode: 0,
		};
	}

	let parsed: ParsedBuiltinToolInput | null;
	try {
		parsed = parseBuiltinToolInput(command, args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: message,
			exitCode: 1,
		};
	}

	switch (parsed?.command) {
		case "read": {
			return executeRead({ ...parsed.input, cwd: context.cwd });
		}

		case "write": {
			return executeWrite({ ...parsed.input, cwd: context.cwd });
		}

		case "edit": {
			return executeEdit({
				path: parsed.input.path,
				edits: parsed.input.edits,
				cwd: context.cwd,
			});
		}

		default:
			return {
				stdout: "",
				stderr: `Unknown builtin command: ${command}. Available commands: read, write, edit`,
				exitCode: 1,
			};
	}
}

export const BUILTIN_COMMANDS = ["read", "write", "edit"] as const;
export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

// ============================================================================
// Deprecated aliases (for backward compatibility)
// ============================================================================

/** @deprecated Use BuiltinCommandResult */
export type NativeCommandResult = BuiltinCommandResult;
/** @deprecated Use ParsedBuiltinCommand */
export type ParsedCommand = ParsedBuiltinCommand;
/** @deprecated Use BuiltinCommandContext */
export type NativeCommandContext = BuiltinCommandContext;
/** @deprecated Use executeBuiltinCommand */
export const executeNativeCommand = executeBuiltinCommand;
/** @deprecated Use BUILTIN_COMMANDS */
export const NATIVE_COMMANDS = BUILTIN_COMMANDS;
/** @deprecated Use BuiltinCommand */
export type NativeCommand = BuiltinCommand;
