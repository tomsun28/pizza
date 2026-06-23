/**
 * Intent Classification Types
 *
 * Defines the risk levels and categories for LLM-proposed tool calls.
 */

import type { FileMutation } from "../event-store/types.js";

// ============================================================================
// Intent Classification
// ============================================================================

/** Intent risk level */
export type IntentRisk = "safe" | "moderate" | "dangerous";

/** Intent category */
export type IntentCategory =
	| "file_read" // safe: read, ls, find, grep
	| "file_write" // moderate: write, edit
	| "file_delete" // dangerous: rm, unlink
	| "shell_safe" // safe: echo, cat, pwd
	| "shell_moderate" // moderate: npm install, git commit
	| "shell_dangerous" // dangerous: rm -rf, sudo, curl | bash
	| "network" // moderate: fetch, curl
	| "unknown"; // dangerous by default

/** Intent classification result */
export interface IntentClassification {
	risk: IntentRisk;
	/** Whether this intent requires user approval */
	requires_approval: boolean;
	category: IntentCategory;
	/** Files affected by this intent */
	affected_files?: string[];
	/** Human-readable description */
	description: string;
}

// ============================================================================
// Intent Execution
// ============================================================================

/** Tool execution result */
export interface ToolExecutionResult {
	content: Array<{ type: string; [key: string]: unknown }>;
	/** Optional structured payload for logs/UI. */
	details?: unknown;
	is_error: boolean;
	/** File mutations produced by this execution */
	file_mutations?: FileMutation[];
	/** Error message if is_error */
	error_message?: string;
}

/** Partial tool execution update emitted while a tool is running. */
export interface ToolExecutionUpdate {
	content: Array<{ type: string }>;
	details?: unknown;
	progress?: number;
}

/** Runtime-provided execution context for a tool call. */
export interface ToolExecutionOptions {
	tool_call_id?: string;
	signal?: AbortSignal;
	onUpdate?: (partial: ToolExecutionUpdate) => void;
}

/** Tool registry interface */
export interface ToolRegistry {
	get(name: string): ToolExecutor | undefined;
	list(): string[];
}

/** Tool executor interface */
export interface ToolExecutor {
	execute(args: Record<string, unknown>, options?: ToolExecutionOptions): Promise<ToolExecutionResult>;
	getMetadata(): ToolMetadata;
}

/** Tool metadata */
export interface ToolMetadata {
	name: string;
	description?: string;
	category: IntentCategory;
	defaultRisk: IntentRisk;
}

// ============================================================================
// Approval Handler
// ============================================================================

/** Approval handler for UI integration */
export interface ApprovalHandler {
	requestApproval(intentEventId: string, classification: IntentClassification): void;
	cancelApproval(intentEventId: string): void;
}
