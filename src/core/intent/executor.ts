/**
 * Intent Executor
 *
 * The sole component authorized to execute mutations.
 * All tool executions go through here, with approval gating.
 */

import type { EventBase } from "../event-store/types.js";
import type { EventAppendInput } from "../event-store/store.js";
import type {
	ApprovalHandler,
	IntentClassification,
	ToolExecutionResult,
	ToolRegistry,
} from "./types.js";
import { IntentClassifier } from "./classifier.js";
import type { RuntimeAdapter } from "../runtime/types.js";
import { LocalRuntimeAdapter } from "../runtime/local-runtime.js";

// ============================================================================
// Pending Intent
// ============================================================================

interface PendingIntent {
	resolve: (approved: boolean) => void;
	classification: IntentClassification;
	tool_call_id: string;
	tool_name: string;
	arguments: Record<string, unknown>;
}

// ============================================================================
// Intent Executor
// ============================================================================

/**
 * IntentExecutor - the only component authorized to execute mutations.
 *
 * Responsibilities:
 * 1. Receive INTENT_TOOL_CALL events
 * 2. Classify risk level
 * 3. If approval required, wait for USER_APPROVAL event
 * 4. Execute tool and emit TOOL_EXECUTION events
 * 5. Record file mutations
 */
export class IntentExecutor {
	private pendingApprovals: Map<string, PendingIntent> = new Map();
	private unsubscribeApproval: (() => void) | undefined;
	private unsubscribeRejection: (() => void) | undefined;
	private runtime: RuntimeAdapter;

	constructor(
		private store: { readonly workspace_id?: string; append(event: EventAppendInput): EventBase; subscribe(handler: (event: EventBase) => void, options?: { types?: string[] }): () => void },
		private classifier: IntentClassifier,
		private toolRegistry: ToolRegistry,
		private approvalHandler?: ApprovalHandler,
		runtime?: RuntimeAdapter,
	) {
		this.runtime = runtime ?? new LocalRuntimeAdapter({
			workspace_id: store.workspace_id ?? "unknown_workspace",
			cwd: process.cwd(),
			toolRegistry,
		});
		this._subscribeToApprovalEvents();
	}

	/**
	 * Process a tool call intent.
	 *
	 * Returns tool execution result for returning to the LLM.
	 * If approval is required, waits until user responds.
	 */
	async execute(intent: {
		tool_call_id: string;
		tool_name: string;
		arguments: Record<string, unknown>;
	}): Promise<ToolExecutionResult> {
		const classification = this.classifier.classify(intent.tool_name, intent.arguments);

		// Emit INTENT_TOOL_CALL event
		const intentEvent = this.store.append({
			actor_id: "runtime",
			type: "INTENT_TOOL_CALL",
			payload: {
				tool_call_id: intent.tool_call_id,
				tool_name: intent.tool_name,
				arguments: intent.arguments,
				requires_approval: classification.requires_approval,
				classification,
			},
		});

		// If approval required, wait for user response
		if (classification.requires_approval) {
			const approved = await this._waitForApproval(intentEvent.event_id, classification, intent);
			if (!approved) {
				return {
					content: [{ type: "text", text: "Tool execution rejected by user." }],
					is_error: true,
					error_message: "User rejected the tool call",
				};
			}
		}

		// Execute the tool
		return this._executeTool(intentEvent.event_id, intent);
	}

	/**
	 * Execute a tool directly (for internal use without intent event).
	 */
	async executeDirect(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
		const tool_call_id = `direct_${Date.now()}`;
		const startTime = Date.now();

		// Emit execution start
		this.store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: { tool_call_id, tool_name: toolName, arguments: args },
		});

		try {
			const result = await this.runtime.executeTool({
				tool_call_id,
				tool_name: toolName,
				arguments: args,
			});

			// Emit execution end
			this.store.append({
				actor_id: "runtime",
				type: "TOOL_EXECUTION_END",
				payload: {
					tool_call_id,
					tool_name: toolName,
					result: result.content,
					is_error: result.is_error,
					duration_ms: Date.now() - startTime,
					file_mutations: result.file_mutations,
				},
			});

			return result;
		} catch (error) {
			const error_message = error instanceof Error ? error.message : String(error);
			this.store.append({
				actor_id: "runtime",
				type: "TOOL_EXECUTION_END",
				payload: {
					tool_call_id,
					tool_name: toolName,
					result: [{ type: "text", text: error_message }],
					is_error: true,
					duration_ms: Date.now() - startTime,
				},
			});
			return {
				content: [{ type: "text", text: error_message }],
				is_error: true,
				error_message,
			};
		}
	}

	/**
	 * Cancel all pending approvals.
	 */
	cancelAllPending(): void {
		for (const [eventId, pending] of this.pendingApprovals) {
			pending.resolve(false);
			this.approvalHandler?.cancelApproval(eventId);
		}
		this.pendingApprovals.clear();
	}

	/**
	 * Get pending approvals count.
	 */
	get pendingCount(): number {
		return this.pendingApprovals.size;
	}

	/**
	 * Get pending approval details.
	 */
	getPendingApprovals(): Array<{ eventId: string; classification: IntentClassification }> {
		return Array.from(this.pendingApprovals.entries()).map(([eventId, pending]) => ({
			eventId,
			classification: pending.classification,
		}));
	}

	/**
	 * Dispose the executor.
	 */
	dispose(): void {
		this.unsubscribeApproval?.();
		this.unsubscribeRejection?.();
		this.cancelAllPending();
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private _subscribeToApprovalEvents(): void {
		this.unsubscribeApproval = this.store.subscribe(
			(event) => {
				if (event.type === "USER_APPROVAL") {
					this._handleApproval(event);
				}
			},
			{ types: ["USER_APPROVAL"] },
		);

		this.unsubscribeRejection = this.store.subscribe(
			(event) => {
				if (event.type === "USER_REJECTION") {
					this._handleRejection(event);
				}
			},
			{ types: ["USER_REJECTION"] },
		);
	}

	private async _executeTool(
		causedByEventId: string,
		intent: { tool_call_id: string; tool_name: string; arguments: Record<string, unknown> },
	): Promise<ToolExecutionResult> {
		// Emit execution start
		const startTime = Date.now();
		this.store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: {
				tool_call_id: intent.tool_call_id,
				tool_name: intent.tool_name,
				arguments: intent.arguments,
			},
			caused_by: causedByEventId,
		});

		try {
			const result = await this.runtime.executeTool({
				...intent,
				caused_by: causedByEventId,
			});

			// Emit execution end
			this.store.append({
				actor_id: "runtime",
				type: "TOOL_EXECUTION_END",
				payload: {
					tool_call_id: intent.tool_call_id,
					tool_name: intent.tool_name,
					result: result.content,
					is_error: result.is_error,
					duration_ms: Date.now() - startTime,
					file_mutations: result.file_mutations,
				},
				caused_by: causedByEventId,
			});

			return result;
		} catch (error) {
			const error_message = error instanceof Error ? error.message : String(error);

			this.store.append({
				actor_id: "runtime",
				type: "TOOL_EXECUTION_END",
				payload: {
					tool_call_id: intent.tool_call_id,
					tool_name: intent.tool_name,
					result: [{ type: "text", text: error_message }],
					is_error: true,
					duration_ms: Date.now() - startTime,
				},
				caused_by: causedByEventId,
			});

			return {
				content: [{ type: "text", text: error_message }],
				is_error: true,
				error_message,
			};
		}
	}

	private _waitForApproval(
		intentEventId: string,
		classification: IntentClassification,
		intent: { tool_call_id: string; tool_name: string; arguments: Record<string, unknown> },
	): Promise<boolean> {
		return new Promise((resolve) => {
			this.pendingApprovals.set(intentEventId, {
				resolve,
				classification,
				tool_call_id: intent.tool_call_id,
				tool_name: intent.tool_name,
				arguments: intent.arguments,
			});

			// Notify UI via approval handler
			this.approvalHandler?.requestApproval(intentEventId, classification);
		});
	}

	private _handleApproval(event: EventBase): void {
		const payload = event.payload as { intent_event_id: string };
		const pending = this.pendingApprovals.get(payload.intent_event_id);
		if (pending) {
			this.pendingApprovals.delete(payload.intent_event_id);
			pending.resolve(true);
		}
	}

	private _handleRejection(event: EventBase): void {
		const payload = event.payload as { intent_event_id: string };
		const pending = this.pendingApprovals.get(payload.intent_event_id);
		if (pending) {
			this.pendingApprovals.delete(payload.intent_event_id);
			pending.resolve(false);
		}
	}
}
