/**
 * `delegate` tool — cross-workspace orchestration for the persistent (main) agent.
 *
 * Registered ONLY when `isMainAgent` is true (see `session-facade-factory.ts`).
 * Lets the main agent hand a task to a sub-agent running in another project
 * directory via the existing RPC infrastructure (`RpcClient`), so the main
 * agent's context is not polluted by the sub-agent's intermediate output.
 *
 * The tool also exposes the set of known workspace agents (project directories
 * the agent has previously worked in) via the `list_workspaces` action, so the
 * model can discover delegate targets without guessing paths.
 *
 * Phase 2 of the cross-workspace orchestration design (PERSISTENT-AGENT.md §8):
 * synchronous delegation — the main agent blocks until the sub-agent finishes,
 * then receives only the sub-agent's final assistant text.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { RpcClient } from "../../../packages/rpc/rpc-client.js";
import { listKnownWorkspaces, type KnownWorkspace } from "../event-store/workspace.js";
import { defineTool, type ToolDefinition } from "../extensions/types.js";

const delegateSchema = Type.Object({
	cwd: Type.Optional(
		Type.String({
			description:
				"Target project directory for the sub-agent. Required when delegating a task. " +
				"Omit (or set list_workspaces=true) to list known workspace agents instead.",
		}),
	),
	task: Type.Optional(
		Type.String({
			description:
				"Task description to delegate to the sub-agent. Required when delegating a task.",
		}),
	),
	list_workspaces: Type.Optional(
		Type.Boolean({
			description:
				"If true, return a list of known workspace agents (project directories previously " +
				"visited by the agent) instead of delegating. Use this to discover valid `cwd` values " +
				"before delegating. Defaults to true when neither cwd nor task is provided.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in milliseconds for the delegated task (default 120000).",
		}),
	),
});

export type DelegateToolInput = Static<typeof delegateSchema>;

/** Options for {@link createDelegateToolDefinition}. */
export interface DelegateToolOptions {
	/** Agent config directory — used to discover known workspaces and to align the sub-agent's auth. */
	agentDir: string;
	/**
	 * The main agent's own working directory. Excluded from `list_workspaces`
	 * results — the main agent delegates to *other* projects, never itself.
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

/**
 * Create the `delegate` tool definition.
 *
 * Only registered for the main agent. The tool has two modes:
 *  - **list**: when `list_workspaces` is true, or when neither `cwd` nor `task`
 *    is provided, returns the list of known workspace agents.
 *  - **delegate**: when `cwd` and `task` are provided, spawns a sub-agent in
 *    `cwd` via `RpcClient`, waits for it to finish, and returns its final
 *    assistant text.
 */
export function createDelegateToolDefinition(
	options: DelegateToolOptions,
): ToolDefinition<any, any, any> {
	const { agentDir, mainDir } = options;

	return defineTool({
		name: "delegate",
		label: "delegate",
		description:
			"Delegate a task to a sub-agent running in another project directory. " +
			"The sub-agent runs in its own workspace (independent event store / compaction) and " +
			"only its final reply is returned — intermediate output does not enter this context. " +
			"Call with list_workspaces=true (or no cwd/task) to discover which project directories " +
			"are available as delegate targets.",
		promptSnippet:
			"delegate: run a sub-agent in another project directory and return only its final reply",
		promptGuidelines: [
			"Use the delegate tool to hand cross-project tasks to a sub-agent instead of handling another project's code in this context.",
			"Before delegating to an unfamiliar project, call delegate with list_workspaces=true to see which project directories are known.",
			"delegate returns only the sub-agent's final reply — intermediate steps stay out of this context. If you need progress, ask the sub-agent to summarize in its final message.",
			"delegate is synchronous and blocks until the sub-agent finishes; prefer it for bounded tasks. Avoid delegating very long-running work.",
		],
		parameters: delegateSchema,
		renderShell: "self",
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			// An explicit list_workspaces=false opts out of listing even when no
			// cwd/task is provided (so the caller gets the "requires both" error
			// instead of a silent list). An explicit true, or omitting everything,
			// lists known workspaces.
			const wantList =
				params.list_workspaces === true ||
				(params.list_workspaces !== false && !params.cwd && !params.task);

			if (wantList) {
				const workspaces = listKnownWorkspaces(agentDir, mainDir);
				return {
					content: [{ type: "text" as const, text: formatWorkspaceList(workspaces) }],
				};
			}

			if (!params.cwd || !params.task) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"delegate requires both `cwd` and `task` to delegate a task. " +
								"Set list_workspaces=true to see known project directories.",
						},
					],
				};
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
					throw new Error("delegate aborted before prompt was sent");
				}

				// promptAndWait = prompt + collectEvents(until AGENT_TURN_COMPLETED).
				await client.promptAndWait(params.task, undefined, timeout);

				if (signal?.aborted) {
					// Best-effort abort of the sub-agent.
					await client.abort().catch(() => {});
				}

				const text = await client.getLastAssistantText();
				return {
					content: [
						{
							type: "text" as const,
							text: text ?? "(sub-agent produced no response)",
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const stderr = client.getStderr();
				return {
					content: [
						{
							type: "text" as const,
							text: `delegate to ${targetCwd} failed: ${message}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`,
						},
					],
				};
			} finally {
				await client.stop().catch(() => {});
			}
		},
		renderCall(args, _theme) {
			if (args?.list_workspaces === true || (!args?.cwd && !args?.task)) {
				return new Text("delegate (list workspaces)", 0, 0);
			}
			const cwd = args?.cwd ?? "?";
			const task = args?.task ? `: ${args.task.slice(0, 60)}${args.task.length > 60 ? "…" : ""}` : "";
			return new Text(`delegate → ${cwd}${task}`, 0, 0);
		},
		renderResult(result, _options, _theme) {
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			return new Text(`\n${text}`, 0, 0);
		},
	});
}
