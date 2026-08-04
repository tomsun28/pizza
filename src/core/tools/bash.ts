import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "../agent/types.js";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { keyHint } from "../../../packages/tui/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../../packages/tui/components/visual-truncate.js";
import { theme } from "../../../packages/tui/theme/theme.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import { injectPizzaPathShims } from "../../utils/path-shims.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";
import {
	BUILTIN_COMMANDS,
	getBuiltinCommandHelpForArgs,
	parseBuiltinCommand,
	parseBuiltinToolInput,
	type ParsedBuiltinToolInput,
} from "./builtin-commands.js";
import { createEditToolDefinition, type EditToolDetails, type EditToolInput, type EditToolOptions } from "./edit.js";
import { createReadToolDefinition, type ReadToolDetails, type ReadToolInput, type ReadToolOptions } from "./read.js";
import { createHistoryTreeToolDefinition, type HistoryTreeToolInput } from "./history-tree.js";
import { createSessionSplitToolDefinition, type SessionSplitToolInput } from "./session-split.js";
import { createDelegateAgentToolDefinition, type DelegateAgentToolInput, type DelegateAgentToolOptions } from "./delegate-agent.js";
import { createWriteToolDefinition, type WriteToolInput, type WriteToolOptions } from "./write.js";

/**
 * Generate a unique temp file path for bash output.
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pizza-bash-${id}.log`);
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	builtin?: BashBuiltinDetails;
}

export type BashBuiltinDetails =
	| {
			name: "read";
			args: ReadToolInput;
			details?: ReadToolDetails;
	  }
	| {
			name: "write";
			args: WriteToolInput;
			details?: undefined;
	  }
	| {
			name: "edit";
			args: EditToolInput;
			details?: EditToolDetails;
	  }
	| {
			name: "session_split";
			args: SessionSplitToolInput;
			details?: undefined;
	  }
	| {
			name: "history_tree";
			args: HistoryTreeToolInput;
			details?: undefined;
	  }
	| {
			name: "delegate_agent";
			args: DelegateAgentToolInput;
			details?: undefined;
	  };

/**
 * Pluggable operations for the cli tool's shell execution path.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using Pizza's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want Pizza's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const childEnv = injectPizzaPathShims(env ?? getShellEnv());
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: true,
					env: childEnv,
					stdio: ["ignore", "pipe", "pipe"],
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Options used when routing the built-in read command through the read tool. */
	read?: ReadToolOptions;
	/** Options used when routing the built-in write command through the write tool. */
	write?: WriteToolOptions;
	/** Options used when routing the built-in edit command through the edit tool. */
	edit?: EditToolOptions;
	/** Options for the built-in delegate_agent command (main agent only). When set, the cli tool routes `delegate_agent` to the delegate_agent definition. */
	delegateAgent?: DelegateAgentToolOptions;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
	builtinKey?: string;
	builtinCallComponent?: Component;
	builtinResultComponent?: Component;
	builtinRendererState?: any;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	const output = getTextOutput(result as any, showImages).trim();

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

function parseBashBuiltinCommand(command: string): ParsedBuiltinToolInput | null {
	const parsed = parseBuiltinCommand(command);
	const builtinName = parsed.command.toLowerCase();
	if (!(BUILTIN_COMMANDS as readonly string[]).includes(builtinName)) {
		return null;
	}
	// Built-ins are never a shell: a bare (non-heredoc) command carrying shell
	// operators (|, >, <, ;, &, newlines — outside quotes) is not a routable
	// built-in. (Execution returns a guidance error for these; rendering falls
	// back to the generic bash call renderer.)
	if (parsed.heredoc === undefined && hasShellControlSyntax(command)) {
		return null;
	}
	if (getBuiltinCommandHelpForArgs(builtinName, parsed.args)) {
		return null;
	}
	return parseBuiltinToolInput(builtinName, parsed.args, parsed.heredoc, { quoteDelimitersConsumed: parsed.quoteDelimitersConsumed });
}

function hasShellControlSyntax(command: string): boolean {
	let quote: "'" | "\"" | undefined;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			continue;
		}
		if (char === "|" || char === "&" || char === ";" || char === "<" || char === ">" || char === "\n") {
			return true;
		}
	}
	return false;
}

/**
 * Detect a Pizza built-in command name that appears as the FIRST word of a
 * shell segment AFTER a chaining operator (&&, ||, ;, |). e.g.
 *   sed -i ... file && _read file 88   →  returns "_read"
 *
 * This is a *failure heuristic*: such a command is routed to the shell (the
 * first word is not a built-in), and the buried built-in is interpreted by the
 * shell as an unknown command ("_read: command not found"). We only use the
 * result to append advisory text after a non-zero exit — never to block — so
 * legitimate content that merely contains the word (e.g. grep _read file) is
 * unaffected as long as the command succeeds.
 *
 * Quote/escape-aware: tokens inside quotes or after a backslash are treated as
 * data, not commands.
 */
export function detectChainedBuiltin(command: string): string | null {
	const builtins = BUILTIN_COMMANDS as readonly string[];
	// First whitespace-delimited token of a segment, ignoring quotes/escapes.
	const firstWord = (text: string): string => {
		const raw = text.trimStart();
		let out = "";
		let q: "'" | '"' | undefined;
		let esc = false;
		for (let i = 0; i < raw.length && out.length < 64; i++) {
			const ch = raw[i];
			if (esc) { esc = false; out += ch; continue; }
			if (ch === "\\") { esc = true; continue; }
			if (q) { if (ch === q) q = undefined; else out += ch; continue; }
			if (ch === "'" || ch === '"') { q = ch; continue; }
			if (ch === " " || ch === "\t" || ch === "\n") break;
			out += ch;
		}
		return out.toLowerCase();
	};

	let quote: "'" | '"' | undefined;
	let escaped = false;
	let segmentStart = 0;
	// Only built-ins chained AFTER an operator are the misuses we care about;
	// the leading segment routes through normal cli parsing.
	let skipFirst = true;

	const checkSegment = (start: number, end: number): string | null => {
		if (skipFirst) return null;
		const word = firstWord(command.slice(start, end));
		return word && builtins.includes(word) ? word : null;
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (escaped) { escaped = false; continue; }
		if (char === "\\") { escaped = true; continue; }
		if (quote) { if (char === quote) quote = undefined; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		const next = command[i + 1];
		const two = (char === "&" && next === "&") || (char === "|" && next === "|");
		if (two || char === ";" || char === "|") {
			const hit = checkSegment(segmentStart, i);
			if (hit) return hit;
			skipFirst = false;
			segmentStart = i + (two ? 2 : 1);
			if (two) i += 1;
		}
	}
	return checkSegment(segmentStart, command.length);
}

function builtinKey(builtin: ParsedBuiltinToolInput | BashBuiltinDetails): string {
	if ("command" in builtin) {
		return JSON.stringify({ name: builtin.command, args: builtin.input });
	}
	return JSON.stringify({ name: builtin.name, args: builtin.args });
}

function resetBuiltinRendererStateIfNeeded(state: BashRenderState, key: string): void {
	if (state.builtinKey === key) return;
	state.builtinKey = key;
	state.builtinCallComponent = undefined;
	state.builtinResultComponent = undefined;
	state.builtinRendererState = {};
}

function makeBuiltinRenderContext<TArgs>(
	context: Parameters<NonNullable<ToolDefinition<any, any, BashRenderState>["renderCall"]>>[2],
	args: TArgs,
	lastComponent: Component | undefined,
	state: BashRenderState,
) {
	state.builtinRendererState ??= {};
	return {
		...context,
		args,
		lastComponent,
		state: state.builtinRendererState,
	};
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const readDefinition = createReadToolDefinition(cwd, options?.read);
	const writeDefinition = createWriteToolDefinition(cwd, options?.write);
	const editDefinition = createEditToolDefinition(cwd, options?.edit);
	const sessionSplitDefinition = createSessionSplitToolDefinition();
	const historyTreeDefinition = createHistoryTreeToolDefinition();
	const delegateAgentDefinition = options?.delegateAgent ? createDelegateAgentToolDefinition(options.delegateAgent) : undefined;
	/** Map of built-in command name → definition. delegate_agent is only present for the main agent. */
	const builtinDefinitions: Record<string, ToolDefinition<any, any, any> | undefined> = {
		read: readDefinition,
		write: writeDefinition,
		edit: editDefinition,
		session_split: sessionSplitDefinition,
		history_tree: historyTreeDefinition,
		delegate_agent: delegateAgentDefinition,
	};
	return {
		name: "cli",
		label: "cli",
		description: `Execute a CLI command in the current working directory. Built-in commands are prefixed with an underscore and handled internally (they never fall back to the shell): _read, _write, _edit, _session_split, _history_tree, and (for the main agent) _delegate_agent. The underscore prefix avoids collisions with real shell commands (e.g. bash's own read/write builtins). IMPORTANT: built-in commands do NOT support shell operators — no pipes (|), redirects (> <), chaining (; & &&), command substitution, or newlines; issue each as a single pure command. To use a pipeline or redirection, run a plain shell command instead (grep, find, ls, cat, sed, git, npm, etc.). For _edit/_write, a value containing quotes, multiple spaces, or newlines must go through a verbatim channel — _edit with --edits JSON (e.g. --edits '[{"op":"replace","range":"12#ab","new":"line1\nline2"}]'), _write with --content or a <<EOF heredoc, or wrap the whole value in quotes. Do NOT pass such a value as bare positional tokens — its inner quotes/spaces get silently mangled. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Execute CLI commands: built-ins are prefixed with _ (_read/_write/_edit/_session_split/_history_tree/_delegate_agent) and are pure single commands with NO shell operators; use shell commands (grep, find, ls, cat, git, npm) for pipes/redirections",
		parameters: bashSchema,
		async execute(
			toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			// Routing policy: a command whose first word is a built-in command name
			// (read/write/edit/session_split/history_tree/delegate_agent) is ALWAYS handled
			// by the internal implementation — it never degrades to the shell. Built-ins are
			// not a shell, so they cannot support shell operators (|, >, <, ;, &, &&,
			// command substitution, newlines). If such an operator appears (outside quotes /
			// heredoc), return a clear error guiding toward the plain shell command instead,
			// rather than silently misbehaving or running unintended shell commands.
			const trimmedCommand = command.trim();
			const parsedCommand = parseBuiltinCommand(trimmedCommand);
			const firstWord = parsedCommand.command.toLowerCase();
			if ((BUILTIN_COMMANDS as readonly string[]).includes(firstWord)) {
				// Built-in commands are ALWAYS handled internally and never degrade to the
				// shell. They are not a shell, so they cannot support shell operators.
				const help = getBuiltinCommandHelpForArgs(firstWord, parsedCommand.args);
				if (help) {
					return { content: [{ type: "text", text: help }], details: undefined };
				}
				// A bare (non-heredoc) command with shell operators (|, >, <, ;, &, newlines,
				// outside quotes) is rejected with guidance rather than misbehaving or running
				// unintended shell commands.
				if (parsedCommand.heredoc === undefined && hasShellControlSyntax(trimmedCommand)) {
					return {
						content: [
							{
								type: "text",
								text:
									firstWord +
									" is a built-in cli command and does not support shell operators " +
									"(|, >, <, ;, &, &&, command substitution, or newlines)." +
									(["_edit", "edit", "_write", "write"].includes(firstWord)
										? " For multi-line or special-character content, pass it through a channel that "
										+ "preserves it verbatim: edit --edits '{\"op\":\"replace\",\"range\":\"12#ab\",\"new\":\"line1\\nline2\"}' "
										+ "(JSON keeps quotes/spaces/newlines), a <<EOF heredoc, or wrap the whole value in quotes. "
										+ "Do not split a value across bare positional tokens."
									: " Issue it as a single pure command. For pipelines or redirections, use a plain "
										+ "shell command instead — e.g. grep PATTERN FILE, cat FILE | ..., or sed ...."),
							},
						],
						details: undefined,
					};
				}
				let builtin: ParsedBuiltinToolInput | null;
				try {
					builtin = parseBuiltinToolInput(firstWord, parsedCommand.args, parsedCommand.heredoc, {
						quoteDelimitersConsumed: parsedCommand.quoteDelimitersConsumed,
					});
				} catch (parseError) {
					// Argument-parse errors (e.g. the positional quote-stripping guard,
					// an unknown edit op) are user-facing guidance, not crashes — surface
					// them as a clean text result so the caller can retry correctly.
					return {
						content: [
							{
								type: "text",
								text: parseError instanceof Error ? parseError.message : String(parseError),
							},
						],
						details: undefined,
					};
				}
				if (builtin) {
					switch (builtin.command) {
						case "read": {
							const result = await readDefinition.execute(toolCallId, builtin.input, signal, undefined, ctx as never);
							return {
								content: result.content,
								details: { builtin: { name: "read", args: builtin.input, details: result.details } },
							};
						}
						case "write": {
							const result = await writeDefinition.execute(toolCallId, builtin.input, signal, undefined, ctx as never);
							return {
								content: result.content,
								details: { builtin: { name: "write", args: builtin.input, details: result.details } },
							};
						}
						case "edit": {
							const prepared = editDefinition.prepareArguments
								? editDefinition.prepareArguments(builtin.input)
								: builtin.input;
							const result = await editDefinition.execute(toolCallId, prepared, signal, undefined, ctx as never);
							return {
								content: result.content,
								details: { builtin: { name: "edit", args: prepared, details: result.details } },
							};
						}
						case "session_split": {
							const result = await sessionSplitDefinition.execute(toolCallId, builtin.input, signal, undefined, ctx as never);
							return {
								content: result.content,
								details: { builtin: { name: "session_split", args: builtin.input, details: result.details } },
							};
						}
						case "history_tree": {
							const result = await historyTreeDefinition.execute(toolCallId, builtin.input, signal, undefined, ctx as never);
							return {
								content: result.content,
								details: { builtin: { name: "history_tree", args: builtin.input, details: result.details } },
							};
						}
						case "delegate_agent": {
							if (!delegateAgentDefinition) {
								return {
									content: [
										{
											type: "text",
											text: "delegate_agent is only available to the main (persistent) agent. " +
												"It cannot be used in this workspace.",
										},
									],
									details: undefined,
								};
							}
							const result = await delegateAgentDefinition.execute(toolCallId, builtin.input, signal, undefined, ctx as never);
							return {
								content: result.content,
								details: { builtin: { name: "delegate_agent", args: builtin.input, details: result.details } },
							};
						}
					}
				}
			}
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}
			return new Promise((resolve, reject) => {
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				const ensureTempFile = () => {
					if (tempFilePath) return;
					tempFilePath = getTempFilePath();
					tempFileStream = createWriteStream(tempFilePath);
					for (const chunk of chunks) tempFileStream.write(chunk);
				};

				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					// Start writing to a temp file once output exceeds the in-memory threshold.
					if (totalBytes > DEFAULT_MAX_BYTES) {
						ensureTempFile();
					}
					// Write to temp file if we have one.
					if (tempFileStream) tempFileStream.write(data);
					// Keep a rolling buffer of recent output for tail truncation.
					chunks.push(data);
					chunksBytes += data.length;
					// Trim old chunks if the rolling buffer grows too large.
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= removed.length;
					}
					// Stream partial output using the rolling tail buffer.
					if (onUpdate) {
						const fullBuffer = Buffer.concat(chunks);
						const fullText = fullBuffer.toString("utf-8");
						const truncation = truncateTail(fullText);
						if (truncation.truncated) {
							ensureTempFile();
						}
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout,
					env: spawnContext.env,
				})
					.then(({ exitCode }) => {
						// Combine the rolling buffer chunks.
						const fullBuffer = Buffer.concat(chunks);
						const fullOutput = fullBuffer.toString("utf-8");
						// Apply tail truncation for the final display payload.
						const truncation = truncateTail(fullOutput);
						if (truncation.truncated) {
							ensureTempFile();
						}
						// Close temp file stream before building the final result.
						if (tempFileStream) tempFileStream.end();
						let outputText = truncation.content || "(no output)";
						let details: BashToolDetails | undefined;
						if (truncation.truncated) {
							// Build truncation details and an actionable notice.
							details = { truncation, fullOutputPath: tempFilePath };
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;
							if (truncation.lastLinePartial) {
								// Edge case: the last line alone is larger than the byte limit.
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}
						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
						// Failure heuristic: if a built-in command name (e.g. _read) was
						// chained after a shell operator (sed ... && _read ...), the shell
						// ran it as an unknown command. Surface an advisory hint so the model
						// reissues the built-in as its own pure command. Advisory only — a
						// command that merely *contains* the word (grep _read file) is ignored
						// unless it also failed.
						const chainedBuiltin = detectChainedBuiltin(command);
						if (chainedBuiltin) {
							outputText +=
								"\n\n" +
								`(${chainedBuiltin} is a Pizza built-in cli command. It cannot be ` +
								`chained after shell operators like &&, ||, ;, or | — the shell ran it ` +
								`as an unknown command. Reissue it as a single pure command, e.g. ` +
								`cli("${chainedBuiltin} <args>").)`;
						}
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						// Close temp file stream and include buffered output in the error message.
						if (tempFileStream) tempFileStream.end();
						const fullBuffer = Buffer.concat(chunks);
						let output = fullBuffer.toString("utf-8");
						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							reject(new Error(output));
						} else {
							reject(err);
						}
					});
			});
		},
		renderCall(args, renderTheme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const command = str(args?.command);
			if (command) {
				try {
					const builtin = parseBashBuiltinCommand(command);
					if (builtin) {
						const key = builtinKey(builtin);
						resetBuiltinRendererStateIfNeeded(state, key);
						const definition = builtinDefinitions[builtin.command];
						if (!definition) {
							// Unknown or unavailable built-in (e.g. delegate_agent on a non-main workspace).
							// Fall through to the default bash call renderer below.
						} else {
							const renderContext = makeBuiltinRenderContext(
								context,
								builtin.input,
								state.builtinCallComponent,
								state,
							);
							const component = definition.renderCall?.(builtin.input as never, renderTheme, renderContext as never);
							if (component) {
								state.builtinCallComponent = component;
								return component;
							}
						}
					}
				} catch {
					// Fall back to the bash call renderer for malformed built-in commands.
				}
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, renderTheme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const builtin = result.details?.builtin;
			if (builtin) {
				const key = builtinKey(builtin);
				resetBuiltinRendererStateIfNeeded(state, key);
				const renderContext = makeBuiltinRenderContext(
					context,
					builtin.args,
					state.builtinResultComponent,
					state,
				);
				const definition = builtinDefinitions[builtin.name];
				const component = definition?.renderResult?.(
					{ content: result.content as never, details: builtin.details },
					options,
					renderTheme,
					renderContext as never,
				);
				if (component) {
					state.builtinResultComponent = component;
					return component;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
