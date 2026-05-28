/**
 * Tool Adapter
 *
 * Adapts legacy AgentTool instances to the new ToolExecutor / ToolRegistry
 * interface used by the event-sourced runtime.
 *
 * Key responsibilities:
 * - Convert AgentTool.execute(toolCallId, params, signal, onUpdate) → ToolExecutor.execute(args)
 * - Detect file mutations from tool results and populate file_mutations
 * - Build a ToolRegistry from an array of AgentTools
 */

import type { AgentTool } from "../agent/types.js";
import type { IntentCategory, IntentRisk, ToolExecutionResult, ToolExecutor, ToolMetadata, ToolRegistry } from "./types.js";
import type { FileMutation } from "../event-store/types.js";

// ============================================================================
// File Mutation Detection
// ============================================================================

/** Tools known to mutate files */
const FILE_MUTATING_TOOLS = new Set(["edit", "edit_diff", "write", "bash"]);

/**
 * Infer file mutations from a tool execution.
 *
 * For write/edit tools, the path is in the arguments.
 * For bash, we cannot reliably detect mutations (best-effort).
 */
function inferFileMutations(
	toolName: string,
	args: Record<string, unknown>,
	_result: ToolExecutionResult,
): FileMutation[] | undefined {
	if (!FILE_MUTATING_TOOLS.has(toolName)) return undefined;

	switch (toolName) {
		case "edit":
		case "edit_diff": {
			const path = args.path as string | undefined;
			if (path) return [{ path, operation: "modify" }];
			return undefined;
		}
		case "write": {
			const path = args.path as string | undefined;
			if (path) return [{ path, operation: "create" }];
			return undefined;
		}
		default:
			return undefined;
	}
}

// ============================================================================
// Tool Category Mapping
// ============================================================================

/** Map AgentTool name to IntentCategory */
function inferCategory(toolName: string): IntentCategory {
	switch (toolName) {
		case "read":
		case "find":
		case "grep":
		case "ls":
		case "path_utils":
			return "file_read";
		case "write":
		case "edit":
		case "edit_diff":
			return "file_write";
		case "bash":
			return "shell_moderate";
		case "truncate":
			return "file_delete";
		default:
			return "unknown";
	}
}

/** Map category to default risk */
function inferRisk(category: IntentCategory): IntentRisk {
	switch (category) {
		case "file_read":
		case "shell_safe":
			return "safe";
		case "file_write":
		case "shell_moderate":
		case "network":
			return "moderate";
		case "file_delete":
		case "shell_dangerous":
		case "unknown":
			return "dangerous";
	}
}

// ============================================================================
// ToolExecutor Adapter
// ============================================================================

/**
 * Wraps a legacy AgentTool as a ToolExecutor for the event-sourced runtime.
 */
export class AgentToolAdapter implements ToolExecutor {
	private metadata: ToolMetadata;

	constructor(private tool: AgentTool<any, any>) {
		const category = inferCategory(tool.name);
		this.metadata = {
			name: tool.name,
			description: tool.description,
			category,
			defaultRisk: inferRisk(category),
		};
	}

	async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
		// Generate a synthetic tool_call_id (the new runtime tracks these at a higher level)
		const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		// Prepare arguments if the tool has a prepareArguments hook
		const prepared = this.tool.prepareArguments ? this.tool.prepareArguments(args) : args;

		try {
			const result = await this.tool.execute(toolCallId, prepared);

			const executionResult: ToolExecutionResult = {
				content: result.content.map((block) => ({ ...block })),
				is_error: false,
			};

			// Detect file mutations
			const mutations = inferFileMutations(this.tool.name, args, executionResult);
			if (mutations?.length) {
				executionResult.file_mutations = mutations;
			}

			return executionResult;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: msg }],
				is_error: true,
				error_message: msg,
			};
		}
	}

	getMetadata(): ToolMetadata {
		return this.metadata;
	}
}

// ============================================================================
// ToolRegistry from AgentTools
// ============================================================================

/**
 * Build a ToolRegistry from an array of AgentTool instances.
 *
 * Usage:
 *   const tools = createTools(cwd, options);
 *   const registry = createToolRegistry(tools);
 */
export function createToolRegistry(tools: AgentTool<any, any>[]): ToolRegistry {
	const executors = new Map<string, ToolExecutor>();

	for (const tool of tools) {
		executors.set(tool.name, new AgentToolAdapter(tool));
	}

	return {
		get(name: string) {
			return executors.get(name);
		},
		list() {
			return Array.from(executors.keys());
		},
	};
}
