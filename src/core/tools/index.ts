export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export { createHistoryTreeToolDefinition, type HistoryTreeToolInput } from "./history-tree.js";
export {
	createSkillToolDefinition,
	type SkillToolInput,
	type SkillToolOptions,
} from "./skill.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.js";

import type { AgentTool } from "../agent/types.js";
import type { ToolDefinition } from "../extensions/types.js";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.js";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.js";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.js";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.js";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.js";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
/**
 * Default tools exposed to LLM via function calls.
 * Only cli is exposed; read/write/edit are handled internally by the cli tool.
 * Other commands (grep, find, ls, git, npm, etc.) are passed to the system shell.
 */
export type ToolName = "cli" | "bash" | "read" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "cli", "bash", "edit", "write", "grep", "find", "ls"]);

/**
 * Default tools exposed via function calls.
 * Only cli is exposed; read/write/edit are handled internally by the cli tool.
 * Other commands (grep, find, ls, etc.) are passed to the system shell.
 */
export const DEFAULT_LLM_TOOLS: ToolName[] = ["cli"];

export interface ToolsOptions {
	read?: ReadToolOptions;
	cli?: BashToolOptions;
	/** @deprecated Use cli. */
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "cli":
		case "bash":
			return createBashToolDefinition(cwd, options?.cli ?? options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "cli":
		case "bash":
			return createBashTool(cwd, options?.cli ?? options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

/**
 * Default coding tools exposed via function calls.
 * Only cli is exposed; read/write/edit are handled internally by the cli tool.
 * Other commands (grep, find, ls, git, npm, etc.) are passed to the system shell.
 */
export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createBashToolDefinition(cwd, options?.cli ?? options?.bash),
	];
}

/**
 * Read-only tools for analysis mode.
 * Only cli is exposed; read is handled internally; grep/find/ls are passed to shell.
 */
export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createBashToolDefinition(cwd, options?.cli ?? options?.bash),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const cliDefinition = createBashToolDefinition(cwd, options?.cli ?? options?.bash);
	return {
		read: createReadToolDefinition(cwd, options?.read),
		cli: cliDefinition,
		bash: cliDefinition,
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
	};
}

/**
 * Default coding tools exposed to LLM.
 * Only cli is exposed; read/write/edit are handled internally by the cli tool.
 * Other commands (grep, find, ls, git, npm, etc.) are passed to the system shell.
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createBashTool(cwd, options?.cli ?? options?.bash),
	];
}

/**
 * Read-only tools for analysis mode.
 * Only cli is exposed; read is handled internally; grep/find/ls are passed to shell.
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createBashTool(cwd, options?.cli ?? options?.bash),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const cliTool = createBashTool(cwd, options?.cli ?? options?.bash);
	return {
		read: createReadTool(cwd, options?.read),
		cli: cliTool,
		bash: cliTool,
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
	};
}
