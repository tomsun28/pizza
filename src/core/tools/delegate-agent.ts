/**
 * `delegate_agent` built-in CLI command — cross-workspace orchestration for
 * any agent (main or workspace).
 *
 * Routed internally by the `cli` tool (alongside read/write/edit/session_split/
 * history_tree), wired up whenever the runtime has an agent dir (see
 * `session-facade-factory.ts`, which passes `delegate_agent` into the cli tool's
 * options). For sessions without an agent dir the command is recognized but
 * reports that it is unavailable.
 *
 * Lets an agent hand a task to a sub-agent running in another project
 * directory via the existing RPC infrastructure (`RpcClient`), so the
 * delegating agent's context is not polluted by the sub-agent's intermediate
 * output.
 *
 * The command also exposes the set of known workspace agents (project
 * directories the agent has previously worked in) via the `list` action, so the
 * model can discover delegation targets without guessing paths.
 *
 * Synchronous delegation — the delegating agent blocks until the sub-agent
 * finishes, then receives only the sub-agent's final assistant text.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { RpcClient } from "../../../packages/rpc/rpc-client.js";
import { listKnownWorkspaces, type KnownWorkspace } from "../event-store/workspace.js";
import { defineTool, type ToolDefinition } from "../extensions/types.js";

/** Supported `delegate_agent` subcommands. */
export const DELEGATE_AGENT_ACTIONS = ["list", "run"] as const;
export type DelegateAgentAction = (typeof DELEGATE_AGENT_ACTIONS)[number];

/**
 * CLI-style schema for the `delegate_agent` command. Mirrors the positional/flag
 * form parsed in `parseDelegateAgentInput` (builtin-commands.ts):
 *
 *   delegate_agent list
 *   delegate_agent run <cwd> <task>
 *   delegate_agent run --cwd <path> --task "..." [--timeout 120000]
 */
const delegateAgentSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("run")], {
		description:
			"list: show known workspace agents (project directories previously visited). " +
			"run: delegate a task to a sub-agent in a target project directory (requires cwd and task).",
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Target project directory for the sub-agent (required for run). Relative paths are resolved. Omit for list.",
		}),
	),
	task: Type.Optional(
		Type.String({
			description:
				"Task description to hand to the sub-agent (required for run). Use the heredoc form or --task for long tasks.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in milliseconds for the delegated task (default 120000).",
		}),
	),
});

export type DelegateAgentToolInput = Static<typeof delegateAgentSchema>;

/** Options for {@link createDelegateAgentToolDefinition}. */
export interface DelegateAgentToolOptions {
	/** Agent config directory — used to discover known workspaces and to align the sub-agent's auth. */
	agentDir: string;
	/**
	 * The delegating agent's own working directory. Excluded from `list` results —
	 * an agent delegates to *other* projects, never itself.
	 */
	mainDir?: string;
}

/**
 * Resolve the CLI entry point for spawning a sub-agent.
 *
 * In node mode `process.argv[1]` is the absolute path to the running `cli.js`.
 * In binary mode (bun `--compile`) `process.execPath` is the compiled binary
 * itself and `process.argv[1]` does not end in `.js` — the binary must be
 * spawned directly without a `node` prefix (handled via `RpcClient`'s
 * `binary` option).
 */
function resolveCliSpawn(): { cliPath: string; binary: boolean } {
	const argv1 = process.argv[1] ?? "";
	const isBinary = !argv1.endsWith(".js");
	return {
		cliPath: isBinary ? process.execPath : argv1,
		binary: isBinary,
	};
}

/** Format the known-workspace list as a readable text block for the model. */
function formatWorkspaceList(workspaces: KnownWorkspace[]): string {
	if (workspaces.length === 0) {
		return (
			"No known workspace agents found. Provide an explicit `cwd` to delegate to a new " +
			"project directory — it will be registered as a workspace after the first delegation."
		);
	}
	const lines = workspaces.map((ws, index) => {
		const last = ws.last_accessed_at > 0 ? new Date(ws.last_accessed_at).toISOString() : "unknown";
		const db = ws.has_event_db ? "yes" : "no";
		return `${index + 1}. cwd: ${ws.cwd}\n   workspace_id: ${ws.workspace_id}\n   last_accessed: ${last}\n   has_event_db: ${db}`;
	});
	return `Known workspace agents (${workspaces.length}):\n\n${lines.join("\n\n")}`;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

/**
 * Create the `delegate_agent` command's tool definition.
 *
 * Two actions:
 *  - **list**: returns the list of known workspace agents.
 *  - **run**: spawns a sub-agent in `cwd` via `RpcClient`, waits for it to
 *    finish, and returns its final assistant text.
 */
export function createDelegateAgentToolDefinition(
	options: DelegateAgentToolOptions,
): ToolDefinition<typeof delegateAgentSchema, undefined> {
	const { agentDir, mainDir } = options;

	return defineTool({
		name: "delegate_agent",
		label: "delegate_agent",
		description:
			"Delegate a task to a sub-agent running in another project directory. " +
			"The sub-agent runs in its own workspace (independent event store / compaction) and " +
			"only its final reply is returned — intermediate output does not enter this context. " +
			"Use the `list` action to discover which project directories are available as delegation targets, " +
			"then `run` with a target cwd and task.",
		promptSnippet: "_delegate_agent: run a sub-agent in another project directory and return only its final reply",
		promptGuidelines: [
			"Use _delegate_agent to hand cross-project tasks to a sub-agent instead of handling another project's code in this context.",
			"Before delegating to an unfamiliar project, call `_delegate_agent list` to see which project directories are known.",
			"_delegate_agent returns only the sub-agent's final reply — intermediate steps stay out of this context. If you need progress, ask the sub-agent to summarize in its final message.",
			"_delegate_agent is synchronous and blocks until the sub-agent finishes; prefer it for bounded tasks. Avoid delegating very long-running work.",
		],
		parameters: delegateAgentSchema,
		renderShell: "self",
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (params.action === "list") {
				const workspaces = listKnownWorkspaces(agentDir, mainDir);
				return textResult(formatWorkspaceList(workspaces));
			}

			// action === "run"
			if (!params.cwd || !params.task) {
				return textResult(
				"_delegate_agent run requires both `cwd` and `task`. " +
					"Use `_delegate_agent list` to see known project directories, or provide an explicit cwd.",
				);
			}

			const targetCwd = resolve(params.cwd);
			const timeout = params.timeout ?? 120_000;

			const { cliPath, binary } = resolveCliSpawn();
			// Align the sub-agent's agentDir with the main agent's so they share
			// auth/models/workspaces. PIZZA_AGENT_DIR is the env override read by
			// getAgentDir().
			const env: Record<string, string> = { PIZZA_AGENT_DIR: agentDir };

			const client = new RpcClient({
				cwd: targetCwd,
				cliPath,
				binary,
				env,
			});

			try {
				await client.start();

				// Reject early if the spawn was aborted before the prompt lands.
				if (signal?.aborted) {
					throw new Error("delegate_agent aborted before prompt was sent");
				}

				// promptAndWait = prompt + collectEvents(until AGENT_TURN_COMPLETED).
				await client.promptAndWait(params.task, undefined, timeout);

				if (signal?.aborted) {
					// Best-effort abort of the sub-agent.
					await client.abort().catch(() => {});
				}

				const text = await client.getLastAssistantText();
				return textResult(text ?? "(sub-agent produced no response)");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const stderr = client.getStderr();
				return textResult(
					`delegate_agent to ${targetCwd} failed: ${message}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`,
				);
			} finally {
				await client.stop().catch(() => {});
			}
		},
		renderCall(args, _theme) {
			if (args?.action === "list") {
				return new Text("delegate_agent (list workspaces)", 0, 0);
			}
			const cwd = args?.cwd ?? "?";
			const task = args?.task ? `: ${args.task.slice(0, 60)}${args.task.length > 60 ? "…" : ""}` : "";
			return new Text(`delegate_agent → ${cwd}${task}`, 0, 0);
		},
		renderResult(result, _options, _theme) {
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			return new Text(`\n${text}`, 0, 0);
		},
	});
}
