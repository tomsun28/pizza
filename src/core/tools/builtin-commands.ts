/**
 * Built-in CLI commands for file operations.
 * These are exposed to the LLM via the cli tool.
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
	type Edit,
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
			input: { path: string; edits: Edit[] };
	  }
	| {
			command: "session_split";
			input: { reason?: string; name?: string };
	  }
	| {
			command: "history_tree";
			input: {
				action: "list" | "view" | "jump" | "fork";
				session_id?: string;
				query?: string;
				max_messages?: number;
				reason?: string;
			};
	  }
	| {
			command: "delegate_agent";
			input: {
				action: "list" | "run";
				cwd?: string;
				task?: string;
				timeout?: number;
			};
	  };

/**
 * Map a built-in command token (what the user/LLM types, e.g. "_read") to its
 * stable internal id (e.g. "read"). Returns null when the token is not a
 * recognized built-in. The token is always the leading-underscore form so it
 * never collides with a real shell command/builtin.
 */
function builtinTokenToId(token: string): string | null {
	const lower = token.toLowerCase();
	if ((BUILTIN_COMMANDS as readonly string[]).includes(lower)) {
		return lower.slice(1);
	}
	return null;
}
/**
 * Parse builtin command with optional heredoc.
 * Supports:
 *   write <path> <<EOF       (also <<'EOF' / <<"EOF")
 *   line1
 *   line2
 *   EOF
 */
export function parseBuiltinCommandWithHeredoc(input: string): ParsedBuiltinCommand | null {
	const trimmed = input.trim();
	
	// Match: command args <<['"]DELIM\ncontent\nDELIM
	// Group 1 = prefix, group 2 = optional opening quote, group 3 = delimiter
	// word, group 4 = content. Supports <<EOF, <<'EOF', and <<"EOF". The
	// closing delimiter is always the bare word (shell semantics).
	const heredocMatch = trimmed.match(/^(.*?)\s+<<\s*(['"]?)(\w+)\2\s*\n([\s\S]*)\n\3\s*$/);
	if (!heredocMatch) {
		return null;
	}
	
	const [, prefix, , , content] = heredocMatch;
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
	const id = builtinTokenToId(command);
	if (!id) return null;
	switch (id) {
		case "read":
			return { command: "read", input: parseReadInput(args) };
		case "write":
			return { command: "write", input: parseWriteInput(args, heredoc) };
		case "edit":
			return { command: "edit", input: parseEditInput(args) };
		case "session_split":
			return { command: "session_split", input: parseSessionSplitInput(args) };
		case "history_tree":
			return { command: "history_tree", input: parseHistoryTreeInput(args) };
		case "delegate_agent":
			return { command: "delegate_agent", input: parseDelegateAgentInput(args, heredoc) };
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

function parseSessionSplitInput(args: string[]): { reason?: string; name?: string } {
	let reason: string | undefined;
	let name: string | undefined;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--reason" || arg === "-r") {
			reason = args[++i];
		} else if (arg === "--name" || arg === "-n") {
			name = args[++i];
		} else {
			positional.push(arg);
		}
	}

	if (positional.length > 0 && reason === undefined) {
		reason = positional[0];
		if (positional.length > 1 && name === undefined) {
			name = positional.slice(1).join(" ");
		}
	}

	return { reason, name };
}

const HISTORY_TREE_ACTIONS = ["list", "view", "jump", "fork"] as const;
type HistoryTreeAction = (typeof HISTORY_TREE_ACTIONS)[number];

function parseHistoryTreeInput(args: string[]): {
	action: HistoryTreeAction;
	session_id?: string;
	query?: string;
	max_messages?: number;
	reason?: string;
} {
	let action: HistoryTreeAction | undefined;
	let sessionId: string | undefined;
	let query: string | undefined;
	let maxMessages: number | undefined;
	let reason: string | undefined;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--session" || arg === "-s") {
			sessionId = args[++i];
		} else if (arg === "--query" || arg === "-q") {
			query = args[++i];
		} else if (arg === "--max-messages" || arg === "-m") {
			maxMessages = parseOptionalInt(args[++i]);
		} else if (arg === "--reason" || arg === "-r") {
			reason = args[++i];
		} else {
			positional.push(arg);
		}
	}

	if (positional.length > 0 && action === undefined) {
		const candidate = positional[0].toLowerCase();
		if (!HISTORY_TREE_ACTIONS.includes(candidate as HistoryTreeAction)) {
			throw new Error(`history_tree: unknown action "${positional[0]}". Valid actions: ${HISTORY_TREE_ACTIONS.join(", ")}`);
		}
		action = candidate as HistoryTreeAction;
		if (positional.length > 1 && sessionId === undefined) {
			sessionId = positional[1];
		}
	}

	if (!action) {
		throw new Error(`history_tree: action required. Valid actions: ${HISTORY_TREE_ACTIONS.join(", ")}`);
	}

	return { action, session_id: sessionId, query, max_messages: maxMessages, reason };
}
const DELEGATE_AGENT_ACTIONS = ["list", "run"] as const;
type DelegateAgentAction = (typeof DELEGATE_AGENT_ACTIONS)[number];

/**
 * Parse the `delegate_agent` command's args:
 *   delegate_agent list
 *   delegate_agent run <cwd> <task>
 *   delegate_agent run --cwd <path> --task "..." [--timeout N]
 *
 * For `run`, the first positional after the action is the cwd and the rest is
 * joined into the task; `--cwd` / `--task` flags override the positionals. A
 * heredoc (when present) supplies the task for `run`.
 */
function parseDelegateAgentInput(args: string[], heredoc?: string): {
	action: DelegateAgentAction;
	cwd?: string;
	task?: string;
	timeout?: number;
} {
	let action: DelegateAgentAction | undefined;
	let cwd: string | undefined;
	let task: string | undefined;
	let timeout: number | undefined;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cwd" || arg === "-d") {
			cwd = args[++i];
		} else if (arg === "--task" || arg === "-t") {
			task = args[++i];
		} else if (arg === "--timeout") {
			timeout = parseOptionalInt(args[++i]);
		} else {
			positional.push(arg);
		}
	}

	if (positional.length > 0 && action === undefined) {
		const candidate = positional[0].toLowerCase();
		if (!DELEGATE_AGENT_ACTIONS.includes(candidate as DelegateAgentAction)) {
			throw new Error(
				`delegate_agent: unknown action "${positional[0]}". Valid actions: ${DELEGATE_AGENT_ACTIONS.join(", ")}`,
			);
		}
		action = candidate as DelegateAgentAction;
	}

	if (!action) {
		throw new Error(`delegate_agent: action required. Valid actions: ${DELEGATE_AGENT_ACTIONS.join(", ")}`);
	}

	// For `run`, the remaining positionals are <cwd> <task...>.
	if (action === "run") {
		const rest = positional.slice(1);
		if (cwd === undefined && rest.length > 0) {
			cwd = rest[0];
		}
		if (task === undefined) {
			if (rest.length > 1) {
				task = rest.slice(1).join(" ");
			} else if (heredoc !== undefined) {
				task = heredoc;
			}
		}
	}

	return { action, cwd, task, timeout };
}

function parseEditInput(args: string[]): { path: string; edits: Edit[] } {
	let path = "";
	let editsJson: string | undefined;
	const edits: Edit[] = [];
	const positional: string[] = [];
	let op: Edit["op"] | undefined;
	let range: string | undefined;
	let oldValue: string | undefined;
	let newValue: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--edits" || arg === "-e") {
			editsJson = args[++i] ?? "[]";
		} else if (arg === "--op") {
			op = parseEditOp(args[++i] ?? "");
		} else if (arg === "--old" || arg === "-o") {
			oldValue = args[++i] ?? "";
		} else if (arg === "--range-id" || arg === "--rangeId") {
			throw new Error("edit no longer supports --range-id. Use --range.");
		} else if (arg === "--range" || arg === "-r") {
			range = args[++i] ?? "";
		} else if (arg === "--new" || arg === "-n") {
			newValue = args[++i] ?? "";
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
			edits.push(parseEditEntry(entry));
		}
	}

	if (edits.length === 0) {
		if (op === "search") {
			edits.push(buildSearchEdit(oldValue, newValue));
		} else if (op !== undefined || range !== undefined) {
			edits.push(buildEditFromParts(op, range, newValue));
		} else if (positional.length >= 2) {
			const parsedOp = parseEditOp(positional[0] ?? "");
			if (parsedOp === "search") {
				edits.push(buildSearchEdit(positional[1], positional.slice(2).join(" ")));
			} else {
				edits.push(buildEditFromParts(parsedOp, positional[1], positional.slice(2).join(" ")));
			}
		}
	}

	return { path, edits };
}

function parseEditOp(value: string): Edit["op"] {
	if (value === "replace" || value === "insert_before" || value === "insert_after" || value === "delete" || value === "search") {
		return value;
	}
	throw new Error("edit op must be one of: replace, insert_before, insert_after, delete, search");
}

function parseEditEntry(entry: unknown): Edit {
	if (!entry || typeof entry !== "object") {
		throw new Error('edit --edits entries must be objects with op, range, and new (unless op is "delete" or "search")');
	}
	const record = entry as Record<string, unknown>;
	const op = parseEditOp(String(record.op ?? ""));
	if (op === "search") {
		return buildSearchEdit(
			typeof record.old === "string" ? record.old : undefined,
			typeof record.new === "string" ? record.new : undefined,
		);
	}
	return buildEditFromParts(
		op as AnchorEditOp,
		typeof record.range === "string" ? record.range : undefined,
		typeof record.new === "string" ? record.new : undefined,
	);
}

function buildSearchEdit(oldValue: string | undefined, newValue: string | undefined): Edit {
	if (typeof oldValue !== "string") {
		throw new Error('edit search requires --old (the text to search for in the file)');
	}
	if (typeof newValue !== "string") {
		throw new Error('edit search requires --new (the replacement text)');
	}
	return { op: "search", old: oldValue, new: newValue };
}

type AnchorEditOp = "replace" | "insert_before" | "insert_after" | "delete";

function buildEditFromParts(op: AnchorEditOp | undefined, range: string | undefined, newValue: string | undefined): Edit {
	if (!op) {
		throw new Error("edit requires --op");
	}
	if (typeof range !== "string") {
		throw new Error("edit requires --range");
	}
	if (op === "delete") {
		return { op, range };
	}
	if (typeof newValue !== "string") {
		throw new Error('edit requires --new unless --op is "delete"');
	}
	return { op, range, new: newValue };
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
	const id = builtinTokenToId(command);
	if (!id) return undefined;
	switch (id) {
		case "read":
			return [
				"_read - Read a file",
				"",
				"Description:",
				"  Reads a text file or supported image file from the current working directory.",
				"  Text output includes 2-hex hashline anchors by default: <line>#<hash> | content.",
				"  Use those anchors as edit range values. Images are returned as image content",
				"  when routed through the cli tool's built-in read implementation.",
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
				"  _read src/main.ts",
				"  _read src/main.ts 20",
				"  _read src/main.ts 20 50",
				"  _read --path src/main.ts --offset 20 --limit 50",
				"  _read -p src/main.ts -o 20 -l 50",
				"  _read --path src/main.ts --anchors none",
			].join("\n");
		case "write":
			return [
				"_write - Create or overwrite a file",
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
				"  _write notes.txt hello",
				"  _write --path notes.txt --content \"hello world\"",
				"  _write -p notes.txt -c \"hello world\"",
				"  _write src/generated.ts <<EOF",
				"  export const value = 1;",
				"  EOF",
			].join("\n");
		case "edit":
			return [
				"_edit - Edit a file with read range anchors or search-and-replace",
				"",
				"Description:",
				"  Edits one existing file. Two modes are supported:",
				"  1. Anchor mode: use hashline ranges from read output (replace, insert_before,",
				"     insert_after, delete). Ranges fail safely if lines changed or became ambiguous.",
				"  2. Search mode: use op=search to find and replace exact text without line anchors.",
				"     The search text must match exactly one location in the file. Use this as a",
				"     fallback when you don't have fresh line anchors (e.g. after using sed/cat).",
				"",
				"Parameters:",
				"  path              File path to edit. Relative paths are resolved from the working directory.",
				"  op                replace, insert_before, insert_after, delete, or search.",
				"  range             Line anchor or range from read output, e.g. 12#ab or 12#ab..14#de.",
				"  old               Text to search for (only for op=search). Must match exactly one location.",
				"  new               New text for replace, insert, and search operations. Omit for delete.",
				"  --path, -p        File path to edit.",
				"  --op              Edit operation.",
				"  --range, -r       Line anchor or range from read output.",
				"  --old, -o         Text to search for (only for op=search).",
				"  --new, -n         New text for replace, insert, and search operations.",
				"  --edits, -e       JSON array of edit objects.",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  _read src/app.ts",
				"  _edit src/app.ts replace 12#ab \"const a = 2\"",
				"  _edit --path src/app.ts --op insert_after --range 12#ab --new \"const b = 3\"",
				"  _edit --path src/app.ts --op delete --range 12#ab..14#de",
				"  _edit --path src/app.ts --op search --old \"const a = 1\" --new \"const a = 2\"",
				"  _edit src/app.ts search \"const a = 1\" \"const a = 2\"",
				"  _edit --path src/app.ts --edits '[{\"op\":\"replace\",\"range\":\"12#ab\",\"new\":\"const a = 2\"}]'",
				"  _edit --path src/app.ts --edits '[{\"op\":\"search\",\"old\":\"const a = 1\",\"new\":\"const a = 2\"}]'",
			].join("\n");
		case "session_split":
			return [
				"_session_split - Split the current conversation session",
				"",
				"Description:",
				"  Start a new session from the current point. Previous messages are no longer",
				"  included in the LLM context for subsequent turns. Use this when the user's",
				"  intent has clearly shifted to a new, unrelated topic.",
				"",
				"Parameters:",
				"  reason            Short reason for the split (e.g. 'topic_change', 'new_task', 'context_reset').",
				"  name              Optional name for the new session (e.g. 'Fix authentication bug').",
				"  --reason, -r      Split reason.",
				"  --name, -n        New session name.",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  _session_split topic_change",
				"  _session_split topic_change \"Fix auth\"",
				"  _session_split --reason topic_change --name \"Fix auth\"",
			].join("\n");
		case "history_tree":
			return [
				"_history_tree - Browse and navigate the session history tree",
				"",
				"Description:",
				"  Every past session is a node in the history tree. Use list to see the tree,",
				"  view to preview a session's messages without switching, jump to return to a",
				"  previous session and continue there, and fork to branch off from a session.",
				"",
				"Actions:",
				"  list              Show the session history tree.",
				"  view <session>    Preview a session's recent messages (no switch).",
				"  jump <session>    Switch to a session; closed sessions are reopened via fork.",
				"  fork <session>    Start a new branch from a session.",
				"",
				"Parameters:",
				"  --session, -s      Target session id (alternative to positional).",
				"  --query, -q        For list: filter on session names and first messages.",
				"  --max-messages, -m For view: max recent messages to show (default 20).",
				"  --reason, -r       For jump: short reason (recorded in the event log).",
				"  -h, --help         Show this help.",
				"",
				"Examples:",
				"  _history_tree list",
				"  _history_tree list --query \"auth bug\"",
				"  _history_tree view sess_0042",
				"  _history_tree jump sess_0042 --reason \"return to auth work\"",
				"  _history_tree fork sess_0042",
			].join("\n");
		case "delegate_agent":
			return [
				"_delegate_agent - Delegate a task to a sub-agent in another project directory",
				"",
				"Description:",
				"  Hand a bounded task to a sub-agent running in another project directory. The",
				"  sub-agent runs in its own workspace (independent event store / compaction) and",
				"  only its final reply is returned — intermediate output stays out of this context.",
				"  Only available to the main (persistent) agent.",
				"",
				"Actions:",
				"  list              Show known workspace agents (project directories previously visited).",
				"  run <cwd> <task>  Delegate a task to a sub-agent in <cwd>; blocks until it finishes.",
				"",
				"Parameters:",
				"  cwd               Target project directory (required for run). Resolved from the working directory.",
				"  task              Task description to hand to the sub-agent (required for run).",
				"  --cwd, -d         Target project directory (alternative to positional).",
				"  --task, -t        Task description (alternative to positional).",
				"  --timeout         Timeout in milliseconds (default 120000).",
				"  <<EOF             Heredoc form for the task (multi-line).",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  _delegate_agent list",
				"  _delegate_agent run ../other-project \"fix the auth bug and summarize the change\"",
				"  _delegate_agent run --cwd ../other-project --task \"fix the auth bug\" --timeout 60000",
				"  _delegate_agent run ../other-project <<EOF",
				"  Refactor the auth module and write a short summary of what changed.",
				"  EOF",
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
	edits: Edit[];
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

		case "session_split": {
			return {
				stdout: "",
				stderr: "session_split requires an active agent session context and is executed through the cli tool.",
				exitCode: 1,
			};
		}

		case "history_tree": {
			return {
				stdout: "",
				stderr: "history_tree requires an active agent session context and is executed through the cli tool.",
				exitCode: 1,
			};
		}
		case "delegate_agent": {
			return {
				stdout: "",
				stderr: "delegate_agent requires the main (persistent) agent context and is executed through the cli tool.",
				exitCode: 1,
			};
		}

		default:
			return {
				stdout: "",
				stderr: `Unknown builtin command: ${command}. Available commands: ${BUILTIN_COMMANDS.join(", ")}`,
				exitCode: 1,
			};
	}
}

export const BUILTIN_COMMANDS = ["_read", "_write", "_edit", "_session_split", "_history_tree", "_delegate_agent"] as const;
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
