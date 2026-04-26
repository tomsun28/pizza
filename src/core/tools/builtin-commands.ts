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
	const parts = prefix.trim().split(/\s+/);
	
	return {
		command: parts[0],
		args: parts.slice(1),
		heredoc: content,
	};
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
	switch (command) {
		case "read": {
			// Support: read <path> [offset] [limit]
			// Or: read <path> --offset <n> --limit <n>
			let path = args[0];
			let offset: number | undefined;
			let limit: number | undefined;

			for (let i = 1; i < args.length; i++) {
				const arg = args[i];
				if (arg === "--offset" || arg === "-o") {
					offset = parseInt(args[++i]);
				} else if (arg === "--limit" || arg === "-l") {
					limit = parseInt(args[++i]);
				} else if (offset === undefined) {
					offset = parseInt(arg);
				} else if (limit === undefined) {
					limit = parseInt(arg);
				}
			}

			return executeRead({ path: path || "", offset, limit, cwd: context.cwd });
		}

		case "write": {
			// Support:
			//   write <path> <content>
			//   write <path> --content <content>
			let path: string | undefined;
			let content: string | undefined;

			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === "--path" || arg === "-p") {
					path = args[++i];
				} else if (arg === "--content" || arg === "-c") {
					content = args[++i];
				} else if (!path) {
					path = arg;
				} else if (content === undefined) {
					content = arg;
				}
			}

			return executeWrite({ path: path || "", content: content || "", cwd: context.cwd });
		}

		case "edit": {
			// Support: edit <path> <oldText> <newText>
			// Or: edit <path> --old <old> --new <new>
			let path: string | undefined;
			let oldText: string | undefined;
			let newText: string | undefined;

			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === "--path" || arg === "-p") {
					path = args[++i];
				} else if (arg === "--old" || arg === "-o") {
					oldText = args[++i];
				} else if (arg === "--new" || arg === "-n") {
					newText = args[++i];
				} else if (!path) {
					path = arg;
				} else if (!oldText) {
					oldText = arg;
				} else if (!newText) {
					newText = arg;
				}
			}

			return executeEdit({ path: path || "", oldText: oldText || "", newText: newText || "", cwd: context.cwd });
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
