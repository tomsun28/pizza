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
			input: { path: string; offset?: number; limit?: number };
	  }
	| {
			command: "write";
			input: { path: string; content: string };
	  }
	| {
			command: "edit";
			input: { path: string; edits: Array<{ oldText: string; newText: string }> };
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

function parseReadInput(args: string[]): { path: string; offset?: number; limit?: number } {
	let path = "";
	let offset: number | undefined;
	let limit: number | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--offset" || arg === "-o") {
			offset = parseOptionalInt(args[++i]);
		} else if (arg === "--limit" || arg === "-l") {
			limit = parseOptionalInt(args[++i]);
		} else if (!path) {
			path = arg;
		} else if (offset === undefined) {
			offset = parseOptionalInt(arg);
		} else if (limit === undefined) {
			limit = parseOptionalInt(arg);
		}
	}

	return { path, offset, limit };
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

function parseEditInput(args: string[]): { path: string; edits: Array<{ oldText: string; newText: string }> } {
	let path = "";
	let editsJson: string | undefined;
	const edits: Array<{ oldText: string; newText: string }> = [];
	const positional: string[] = [];
	let pendingOld: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--edits" || arg === "-e") {
			editsJson = args[++i] ?? "[]";
		} else if (arg === "--old" || arg === "-o") {
			pendingOld = args[++i] ?? "";
		} else if (arg === "--new" || arg === "-n") {
			const newText = args[++i] ?? "";
			if (pendingOld !== undefined) {
				edits.push({ oldText: pendingOld, newText });
				pendingOld = undefined;
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
				typeof (entry as { oldText?: unknown }).oldText !== "string" ||
				typeof (entry as { newText?: unknown }).newText !== "string"
			) {
				throw new Error("edit --edits entries must include string oldText and newText");
			}
			edits.push({
				oldText: (entry as { oldText: string }).oldText,
				newText: (entry as { newText: string }).newText,
			});
		}
	}

	if (pendingOld !== undefined) {
		edits.push({ oldText: pendingOld, newText: "" });
	}

	if (edits.length === 0 && positional.length >= 2) {
		edits.push({
			oldText: positional[0] ?? "",
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

/** @deprecated Use parseBuiltinCommandWithHeredoc */
export const parseCommandWithHeredoc = parseBuiltinCommandWithHeredoc;

// ============================================================================
// Read Command
// ============================================================================

interface ReadOptions {
	path: string;
	offset?: number;
	limit?: number;
	cwd: string;
}

async function executeRead(options: ReadOptions): Promise<BuiltinCommandResult> {
	try {
		const filePath = resolve(options.cwd, options.path);
		const content = await readFile(filePath, "utf-8");
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
		let output = truncation.content;
		const startLineDisplay = startLine + 1;

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
	newText: string;
	oldText: string;
	cwd: string;
}

async function executeEdit(options: EditOptions): Promise<BuiltinCommandResult> {
	try {
		const filePath = resolve(options.cwd, options.path);
		const content = await readFile(filePath, "utf-8");

		if (!content.includes(options.oldText)) {
			return {
				stdout: "",
				stderr: `Error: oldText not found in file`,
				exitCode: 1,
			};
		}

		const newContent = content.replace(options.oldText, options.newText);
		await writeFile(filePath, newContent, "utf-8");

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
			const firstEdit = parsed.input.edits[0];
			return executeEdit({
				path: parsed.input.path,
				oldText: firstEdit?.oldText ?? "",
				newText: firstEdit?.newText ?? "",
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
