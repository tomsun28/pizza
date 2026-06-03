/**
 * Reactor — Event-Driven Agent Core
 *
 * Replaces the AgentLoop while-loop with a set of typed handlers that react
 * to events appended to the EventStore. Each handler is a pure async function
 * that may emit new events. The reactor itself is stateless — all mutable
 * state lives in the EventStore.
 *
 * Event flow:
 *
 *   USER_MESSAGE / USER_INTERRUPT / TOOL_RESULTS_AGGREGATED / RETRY_SCHEDULED
 *         ↓
 *   [onUserMessage]  ──→ emit AGENT_TURN_REQUESTED
 *         ↓
 *   [onAgentTurnRequested]  ──→ emit LLM_CALL_REQUESTED
 *         ↓
 *   [onLlmCallRequested]  ──→ call LLM → emit AGENT_MESSAGE_START/CHUNK/END
 *         ↓
 *   [onAgentMessageEnd]
 *       ├── if no tool_calls → emit AGENT_TURN_COMPLETED
 *       └── if tool_calls → emit INTENT_TOOL_CALL (one per call)
 *         ↓
 *   [onIntentToolCall]  ──→ (approval gate) → emit TOOL_EXECUTION_START/END
 *         ↓
 *   [onToolExecutionEnd]  ──→ track count → if all done → emit TOOL_RESULTS_AGGREGATED
 *         ↓
 *   [onToolResultsAggregated]  ──→ emit AGENT_TURN_REQUESTED  ← loop back
 *
 * Other handlers (run in parallel, do not gate the main flow):
 *   onAgentTurnCompleted  — UI notification
 *   onLlmCallFailed        — retry scheduling
 *   onUserInterrupt        — abort signal + turn completion
 *   onCompactionRequested  — compaction orchestration
 */

import type { EventBase, EventType } from "../event-store/types.js";
import type { EventStore, EventAppendInput } from "../event-store/store.js";
import type {
	ApprovalHandler,
	IntentClassification,
	ToolExecutionResult,
	ToolRegistry,
} from "../intent/types.js";
import type { IntentClassifier } from "../intent/classifier.js";
import type { LLMChunk, LLMClient, LLMResponse, ToolDefinition } from "./llm-types.js";
import type { RuntimeAdapter } from "./types.js";
import { extractToolCalls } from "../projection/event-to-message.js";
import type { SessionProjection } from "../projection/session-projection.js";
import type { CompactionPolicy, RetryPolicy } from "./policies.js";
import { DefaultRetryPolicy, NoopCompactionPolicy } from "./policies.js";
// ============================================================================
// Types
// ============================================================================

/** Reactor configuration */
export interface ReactorConfig {
	store: EventStore;
	projection: SessionProjection;
	llmClient: LLMClient;
	classifier: IntentClassifier;
	toolRegistry: ToolRegistry;
	approvalHandler?: ApprovalHandler;
	runtimeAdapter: RuntimeAdapter;
	systemPrompt: string;
	model: { provider: string; model_id: string; thinking_level?: string };
	contextBudget: number;
	/** Tool definitions exposed to the LLM */
	tools: ToolDefinition[];
	/** Retry policy (default: DefaultRetryPolicy). */
	retryPolicy?: RetryPolicy;
	/** Compaction policy (default: NoopCompactionPolicy). */
	compactionPolicy?: CompactionPolicy;
}

/** A single event handler. Returns void or void Promise. */
export type EventHandler = (event: EventBase) => void | Promise<void>;

/** Mapping from event type to handler */
export type EventHandlerMap = Partial<Record<EventType, EventHandler>>;

// ============================================================================
// Tool Call Tracking (join-pattern for parallel tool execution)
// ============================================================================

/**
 * Tracks outstanding tool executions for a single assistant message.
 * Emits TOOL_RESULTS_AGGREGATED once all expected calls have finished.
 */
interface TurnTracker {
	assistantMessageEventId: string;
	expectedCount: number;
	received: Array<{ tool_call_id: string; tool_name: string; result: ToolExecutionResult; is_error: boolean }>;
	abortSignal?: AbortSignal;
}

export class Reactor {
	private config: ReactorConfig;
	private abortController: AbortController | undefined;
	private turnTrackers: Map<string, TurnTracker> = new Map();
	private handlers: EventHandlerMap = {};
	private unsubscribers: Array<() => void> = [];
	private _isRunning = false;
	/** Context built in onAgentTurnRequested, consumed by onLlmCallRequested. */
	private _pendingContext: ReturnType<SessionProjection["buildContext"]> | undefined;
	/** Active retry policy. */
	private retryPolicy: RetryPolicy;
	/** Active compaction policy. */
	private compactionPolicy: CompactionPolicy;
	/** Pending follow-up messages (delivered after current turn completes without interrupt). */
	private followUpQueue: Array<{ content: string | unknown[]; images?: unknown[] }> = [];
	/** Aborter for the current compaction run (if any). */
	private compactionAbort: AbortController | undefined;
	/** Set when abort() is called with no new content — next turn completion should discard queued follow-ups. */
	private _abortedByUser = false;
	constructor(config: ReactorConfig) {
		this.config = config;
		this.retryPolicy = config.retryPolicy ?? new DefaultRetryPolicy();
		this.compactionPolicy = config.compactionPolicy ?? new NoopCompactionPolicy();
		this._registerAllHandlers();
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/** Subscribe to all events and start the reactor. */
	async start(): Promise<void> {
		if (this._isRunning) return;
		this._isRunning = true;
		this.abortController = new AbortController();

		// Subscribe to the event store — all events flow through the store
		const unsub = this.config.store.subscribe(
			(event) => this._dispatch(event),
			// No type filter here; individual handlers decide what they care about
		);
		this.unsubscribers.push(unsub);

		// Replay any pre-existing follow-up events that were queued while the reactor was idle
		this._replayPendingFollowUps();

		// Emit RUNTIME_STARTED if the store is fresh
		if (this.config.store.size === 0) {
			this._emit({
				actor_id: "runtime",
				type: "RUNTIME_STARTED",
				payload: {},
			});
		}
	}

	/**
	 * Replay USER_FOLLOWUP_QUEUED events that were appended while the reactor was idle.
	 * Skips events that have already been consumed (i.e. an AGENT_TURN_COMPLETED with a
	 * caused_by chain that includes them).
	 *
	 * For now we use a simple heuristic: count followups vs followup-driven user messages.
	 * If followups outnumber the consumed ones, replay the difference into the in-memory queue.
	 */
	private _replayPendingFollowUps(): void {
		const followups = this.config.store.query({ types: ["USER_FOLLOWUP_QUEUED"] });
		if (followups.length === 0) return;

		// A USER_FOLLOWUP_QUEUED is "consumed" when a USER_MESSAGE event has it as caused_by.
		const userMessages = this.config.store.query({ types: ["USER_MESSAGE"] });
		const consumedCausedBy = new Set(
			userMessages.map((m) => m.caused_by).filter((id): id is string => !!id),
		);

		for (const f of followups) {
			if (consumedCausedBy.has(f.event_id)) continue;
			const p = f.payload as { content: string | unknown[]; images?: unknown[] };
			this.followUpQueue.push({ content: p.content, images: p.images });
		}
	}

	/** Stop the reactor. Clears all subscriptions. */
	stop(): void {
		this._isRunning = false;
		this.abortController?.abort();
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
	}

	/** Check if the reactor is running. */
	get isRunning(): boolean {
		return this._isRunning;
	}

	// =========================================================================
	// Event dispatch
	// =========================================================================

	private async _dispatch(event: EventBase): Promise<void> {
		const handler = this.handlers[event.type];
		if (!handler) return;

		try {
			await handler(event);
		} catch (err) {
			// Emit as RUNTIME_ERROR instead of throwing — the reactor must keep running
			const msg = err instanceof Error ? err.message : String(err);
			this._emit({
				actor_id: "runtime",
				type: "RUNTIME_ERROR",
				payload: { error: msg, stack: err instanceof Error ? err.stack : undefined, causing_event_id: event.event_id },
			});
		}
	}

	private _emit(input: EventAppendInput): EventBase {
		return this.config.store.append(input);
	}

	/** Check if the reactor has been asked to stop. */
	private _shouldInterrupt(): boolean {
		return this.abortController?.signal.aborted ?? false;
	}

	/** Interrupt the reactor. */
	interrupt(): void {
		this.abortController?.abort();
	}

	// =========================================================================
	// Handler registration
	// =========================================================================

	private _registerAllHandlers(): void {
		this.handlers = {
			USER_MESSAGE: this._onUserMessage.bind(this),
			USER_INTERRUPT: this._onUserInterrupt.bind(this),
			USER_FOLLOWUP_QUEUED: this._onUserFollowupQueued.bind(this),
			AGENT_TURN_REQUESTED: this._onAgentTurnRequested.bind(this),
			LLM_CALL_REQUESTED: this._onLlmCallRequested.bind(this),
			AGENT_MESSAGE_END: this._onAgentMessageEnd.bind(this),
			INTENT_TOOL_CALL: this._onIntentToolCall.bind(this),
			TOOL_EXECUTION_END: this._onToolExecutionEnd.bind(this),
			TOOL_RESULTS_AGGREGATED: this._onToolResultsAggregated.bind(this),
			LLM_CALL_FAILED: this._onLlmCallFailed.bind(this),
			AGENT_TURN_COMPLETED: this._onAgentTurnCompleted.bind(this),
			USER_APPROVAL: this._onUserApproval.bind(this),
			USER_REJECTION: this._onUserRejection.bind(this),
			COMPACTION_REQUESTED: this._onCompactionRequested.bind(this),
		};
	}

	// =========================================================================
	// User-facing entry points (used by modes)
	// =========================================================================

	/**
	 * Send a user message to the agent (idle path).
	 * For interrupt-while-streaming use steer(). For after-turn-completion use followUp().
	 */
	prompt(
		content: string | Array<{ type: string; [key: string]: unknown }>,
		images?: Array<{ type: "image"; data: string; mime_type: string }>,
	): void {
		this._emit({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content, images },
		});
	}

	/**
	 * Steer: interrupt current turn with a new user message.
	 * The reactor aborts the current LLM call (if any) and treats the steer message
	 * as a fresh USER_MESSAGE once the turn settles.
	 */
	steer(
		content: string | Array<{ type: string; [key: string]: unknown }>,
		images?: Array<{ type: "image"; data: string; mime_type: string }>,
	): void {
		this._emit({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: { content, images, reason: "steer" },
		});
	}

	/**
	 * Follow-up: queue a message to be delivered after the current turn naturally completes.
	 * Does not interrupt. If the reactor is idle, behaves like prompt().
	 */
	followUp(
		content: string | Array<{ type: string; [key: string]: unknown }>,
		images?: Array<{ type: "image"; data: string; mime_type: string }>,
	): void {
		this._emit({
			actor_id: "user",
			type: "USER_FOLLOWUP_QUEUED",
			payload: { content, images },
		});
	}

	/** Number of pending follow-up messages. */
	get pendingFollowUpCount(): number {
		return this.followUpQueue.length;
	}

	/** Clear pending follow-ups (e.g. on user-explicit cancel). */
	clearFollowUpQueue(): void {
		this.followUpQueue = [];
	}

	// =========================================================================
	// HANDLERS
	// =========================================================================

	// ─── USER_MESSAGE ───────────────────────────────────────────────────────

	private async _onUserMessage(event: EventBase): Promise<void> {
		const payload = event.payload as { content: unknown; images?: unknown };
		if (this._shouldInterrupt()) return;

		// Emit thinking start
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_THINKING_START",
			payload: { model: this.config.model.model_id },
			caused_by: event.event_id,
		});

		// Emit turn requested — this kicks off the reactor loop
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_REQUESTED",
			payload: { reason: "user_message" },
			caused_by: event.event_id,
		});
	}

	// ─── USER_INTERRUPT ─────────────────────────────────────────────────────
	private async _onUserInterrupt(event: EventBase): Promise<void> {
		const payload = event.payload as { content?: unknown; images?: unknown };
		this.interrupt();
		// Track hard abort (no new content) so _onAgentTurnCompleted doesn't drain follow-ups.
		if (payload.content === undefined) {
			this._abortedByUser = true;
		}
		// If steer carried new content, queue it as a follow-up so the turn-completion
		// handler picks it up after the current turn settles (aborted state).
		if (payload.content !== undefined) {
			this.followUpQueue.push({
				content: payload.content as string | unknown[],
				images: payload.images as unknown[] | undefined,
			});
		}
		// Cancel any pending compaction so we don't block turn completion
		this.compactionAbort?.abort();
	}
	// ─── USER_FOLLOWUP_QUEUED ───────────────────────────────────────────────

	private async _onUserFollowupQueued(event: EventBase): Promise<void> {
		const payload = event.payload as { content: string | unknown[]; images?: unknown[] };
		this.followUpQueue.push({ content: payload.content, images: payload.images });
	}

	// ─── AGENT_TURN_REQUESTED ───────────────────────────────────────────────

	private async _onAgentTurnRequested(event: EventBase): Promise<void> {
		if (this._shouldInterrupt()) return;

		const payload = event.payload as { reason: string; retry_attempt?: number };

		// Build context from projection
		const context = this.config.projection.buildContext({
			max_tokens: this.config.contextBudget,
		});

		// Stash context for the LLM_CALL_REQUESTED handler. MUST be set before _emit
		// because store subscribers fire synchronously and _onLlmCallRequested reads
		// _pendingContext during its sync portion before awaiting the LLM call.
		this._pendingContext = context;

		// Emit turn start
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_START",
			payload: { message_count: context.messages.length },
			caused_by: event.event_id,
		});

		// Request an LLM call
		this._emit({
			actor_id: "coder_agent",
			type: "LLM_CALL_REQUESTED",
			payload: { message_count: context.messages.length },
			caused_by: event.event_id,
		});
	}

	// ─── LLM_CALL_REQUESTED ─────────────────────────────────────────────────

	private async _onLlmCallRequested(event: EventBase): Promise<void> {
		if (this._shouldInterrupt()) return;

		const context = this._pendingContext ?? this.config.projection.buildContext({ max_tokens: this.config.contextBudget });
		this._pendingContext = undefined;

		// Emit AGENT_MESSAGE_START up front so chunks have a parent in the causal chain.
		const msgStart = this._emit({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_START",
			payload: { model: { provider: this.config.model.provider, model_id: this.config.model.model_id } },
			caused_by: event.event_id,
		});

		try {
			const response = await this.config.llmClient.complete({
				messages: context.messages,
				systemPrompt: this.config.systemPrompt,
				model: this.config.model,
				tools: this.config.tools,
				signal: this.abortController?.signal,
				onChunk: (chunk: LLMChunk) => {
					// Translate LLMChunk into an AGENT_MESSAGE_CHUNK event so projections / UI
					// can render the streaming response in real time.
					this._emit({
						actor_id: "coder_agent",
						type: "AGENT_MESSAGE_CHUNK",
						payload: { chunk: chunk as any },
						caused_by: msgStart.event_id,
					});
				},
			});

			this._handleLlmResponse(response, event.event_id, msgStart.event_id);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isRetryable = this.retryPolicy.isRetryable({ message: msg });

			this._emit({
				actor_id: "runtime",
				type: "LLM_CALL_FAILED",
				payload: { error: msg, retryable: isRetryable },
				caused_by: event.event_id,
			});
		}
	}

	private _handleLlmResponse(response: LLMResponse, causedBy: string, msgStartEventId?: string): void {
		// AGENT_MESSAGE_START is now emitted by _onLlmCallRequested before the call so chunks
		// can reference it. For backwards compat with callers that don't stream, emit it here
		// if not already emitted.
		if (!msgStartEventId) {
			const started = this._emit({
				actor_id: "coder_agent",
				type: "AGENT_MESSAGE_START",
				payload: { model: { provider: response.provider, model_id: response.model } },
				caused_by: causedBy,
			});
			msgStartEventId = started.event_id;
		}

		// Emit message end (the chunking is optional; for now we skip to end for simplicity)
		const toolCalls = extractToolCalls(response.content);

		// Append the AGENT_MESSAGE_END event.
		const msgEnd = this._emit({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: response.content,
				model: { provider: response.provider, model_id: response.model },
				usage: response.usage,
				stop_reason: response.stopReason,
				error_message: response.errorMessage,
			},
			caused_by: causedBy,
		});

		// Emit turn end
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_END",
			payload: { tool_calls_count: toolCalls.length },
			caused_by: msgEnd.event_id,
		});

		// Emit thinking end
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_THINKING_END",
			payload: {},
			caused_by: msgEnd.event_id,
		});

		// The ON_AGENT_MESSAGE_END handler will dispatch tool calls or complete the turn
	}

	// ─── AGENT_MESSAGE_END ──────────────────────────────────────────────────

	private async _onAgentMessageEnd(event: EventBase): Promise<void> {
		if (this._shouldInterrupt()) {
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "aborted" },
				caused_by: event.event_id,
			});
			return;
		}

		const payload = event.payload as {
			content: unknown[];
			stop_reason: string;
			error_message?: string;
		};

		const toolCalls = extractToolCalls(payload.content as Parameters<typeof extractToolCalls>[0]);

		if (toolCalls.length === 0 || payload.stop_reason !== "tool_use") {
			// No tool calls — turn is complete
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: payload.stop_reason as "stop" | "length" | "error", error_message: payload.error_message },
				caused_by: event.event_id,
			});
			return;
		}

		// Track this turn's tool executions
		const tracker: TurnTracker = {
			assistantMessageEventId: event.event_id,
			expectedCount: toolCalls.length,
			received: [],
			abortSignal: this.abortController?.signal,
		};
		this.turnTrackers.set(event.event_id, tracker);

		// Emit one INTENT_TOOL_CALL per tool call
		for (const toolCall of toolCalls) {
			const classification = this.config.classifier.classify(toolCall.name, toolCall.arguments);
			this._emit({
				actor_id: "coder_agent",
				type: "INTENT_TOOL_CALL",
				payload: {
					tool_call_id: toolCall.id,
					tool_name: toolCall.name,
					arguments: toolCall.arguments,
					requires_approval: classification.requires_approval,
					classification,
				},
				caused_by: event.event_id,
			});
		}
	}

	// ─── INTENT_TOOL_CALL ──────────────────────────────────────────────────

	private readonly _pendingApprovals = new Map<
		string,
		{ resolve: (approved: boolean) => void; tool_call_id: string; tool_name: string; arguments: Record<string, unknown> }
	>();

	private async _onIntentToolCall(event: EventBase): Promise<void> {
		if (this._shouldInterrupt()) return;

		const payload = event.payload as {
			tool_call_id: string;
			tool_name: string;
			arguments: Record<string, unknown>;
			requires_approval: boolean;
			classification?: IntentClassification;
		};

		if (payload.requires_approval) {
			// Wait for user approval/rejection
			const approved = await new Promise<boolean>((resolve) => {
				this._pendingApprovals.set(event.event_id, {
					resolve,
					tool_call_id: payload.tool_call_id,
					tool_name: payload.tool_name,
					arguments: payload.arguments,
				});
				this.config.approvalHandler?.requestApproval(event.event_id, payload.classification!);
			});

			if (!approved) {
				this._emitToolExecutionEnd(payload.tool_call_id, payload.tool_name, {
					content: [{ type: "text", text: "Tool execution rejected by user." }],
					is_error: true,
					error_message: "User rejected the tool call",
				}, event.event_id);
				return;
			}
		}

		// Execute the tool
		await this._executeTool(event.event_id, payload.tool_call_id, payload.tool_name, payload.arguments);
	}

	private async _executeTool(causedBy: string, tool_call_id: string, tool_name: string, args: Record<string, unknown>): Promise<void> {
		const startTime = Date.now();

		this._emit({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: { tool_call_id, tool_name, arguments: args },
			caused_by: causedBy,
		});

		try {
			const result = await this.config.runtimeAdapter.executeTool({ tool_call_id, tool_name, arguments: args });
			this._emitToolExecutionEnd(tool_call_id, tool_name, result, causedBy, startTime);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._emitToolExecutionEnd(tool_call_id, tool_name, {
				content: [{ type: "text", text: msg }],
				is_error: true,
				error_message: msg,
			}, causedBy, startTime);
		}
	}

	private _emitToolExecutionEnd(
		tool_call_id: string,
		tool_name: string,
		result: ToolExecutionResult,
		causedBy: string,
		startTime?: number,
	): void {
		this._emit({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id,
				tool_name,
				result: result.content,
				is_error: result.is_error,
				duration_ms: startTime !== undefined ? Date.now() - startTime : 0,
				file_mutations: result.file_mutations,
			},
			caused_by: causedBy,
		});
	}

	// ─── TOOL_EXECUTION_END ─────────────────────────────────────────────────

	private async _onToolExecutionEnd(event: EventBase): Promise<void> {
		const payload = event.payload as {
			tool_call_id: string;
			tool_name: string;
			result: unknown[];
			is_error: boolean;
			file_mutations?: Array<{ path: string; operation: string; diff?: string }>;
		};

		// Emit FILE_MUTATION_APPLIED for each mutation reported by the tool
		if (payload.file_mutations?.length) {
			for (const mutation of payload.file_mutations) {
				this._emit({
					actor_id: "runtime",
					type: "FILE_MUTATION_APPLIED",
					payload: {
						path: mutation.path,
						operation: mutation.operation,
						diff: mutation.diff,
						tool_name: payload.tool_name,
						tool_call_id: payload.tool_call_id,
					},
					caused_by: event.event_id,
				});
			}
		}

		// Find the tracker for this tool call's assistant message
		// Walk up the causal chain from the TOOL_EXECUTION_END event
		const causedBy = event.caused_by;
		if (!causedBy) return;

		// The caused_by points to the INTENT_TOOL_CALL event.
		// We need to find the INTENT_TOOL_CALL → AGENT_MESSAGE_END chain.
		// Actually, the causal chain in EventStore should give us this.
		// For now, find the tracker by looking up the chain:
		const chain = this.config.store.getCausalChain(event.event_id);

		// Find the AGENT_MESSAGE_END in the causal chain
		let assistantMessageEventId: string | undefined;
		for (const e of chain) {
			if (e.type === "AGENT_MESSAGE_END") {
				assistantMessageEventId = e.event_id;
				break;
			}
		}

		if (!assistantMessageEventId) return;

		const tracker = this.turnTrackers.get(assistantMessageEventId);
		if (!tracker) return;

		tracker.received.push({
			tool_call_id: payload.tool_call_id,
			tool_name: payload.tool_name,
			result: { content: payload.result as ToolExecutionResult["content"], is_error: payload.is_error },
			is_error: payload.is_error,
		});

		// If all tools have completed, emit TOOL_RESULTS_AGGREGATED
		if (tracker.received.length === tracker.expectedCount) {
			this.turnTrackers.delete(assistantMessageEventId);
			this._emit({
				actor_id: "coder_agent",
				type: "TOOL_RESULTS_AGGREGATED",
				payload: {
					assistant_message_event_id: assistantMessageEventId,
					tool_call_count: tracker.expectedCount,
					any_error: tracker.received.some((r) => r.is_error),
				},
				caused_by: event.event_id,
			});
		}
	}

	// ─── TOOL_RESULTS_AGGREGATED ────────────────────────────────────────────

	private async _onToolResultsAggregated(event: EventBase): Promise<void> {
		if (this._shouldInterrupt()) {
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "aborted" },
				caused_by: event.event_id,
			});
			return;
		}

		// Kick off the next turn with the tool results
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_REQUESTED",
			payload: { reason: "tool_results" },
			caused_by: event.event_id,
		});
	}

	// ─── AGENT_TURN_COMPLETED ───────────────────────────────────────────────
	//
	// Drain the followUp queue (if any) or let the reactor go idle.
	// Also triggers compaction check after a non-error turn.

	private _onAgentTurnCompleted(event: EventBase): void {
		const payload = event.payload as { reason: string; error_message?: string };

		// If abort() was called, discard any pending follow-ups so the reactor stops.
		// _abortedByUser is set by _onUserInterrupt when the interrupt has no new content.
		if (this._abortedByUser) {
			this.followUpQueue = [];
			this._abortedByUser = false;
			return;
		}

		// If a steer or follow-up message is queued, deliver it as a new USER_MESSAGE
		// so the turn cycle restarts.
		if (this.followUpQueue.length > 0) {
			// Reset abort controller for the new turn — the previous turn's interrupt
			// has already been handled.
			this.abortController = new AbortController();
			const next = this.followUpQueue.shift()!;
			this._emit({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: next.content, images: next.images },
				caused_by: event.event_id,
			});
			return;
		}

		// Check compaction policy after a non-aborted turn
		if (payload.reason !== "aborted") {
			this._checkCompaction(event);
		}
	}

	// ─── LLM_CALL_FAILED ────────────────────────────────────────────────────

	private async _onLlmCallFailed(event: EventBase): Promise<void> {
		const payload = event.payload as { error: string; retryable: boolean };

		const attempt = this._attemptCount(event.event_id);

		if (!payload.retryable || attempt >= this.retryPolicy.maxAttempts) {
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: {
					reason: "error",
					error_message:
						attempt >= this.retryPolicy.maxAttempts
							? `Max retries (${this.retryPolicy.maxAttempts}) exceeded: ${payload.error}`
							: payload.error,
				},
				caused_by: event.event_id,
			});
			return;
		}

		const nextAttempt = attempt + 1;
		const delayMs = this.retryPolicy.nextDelayMs(nextAttempt);
		if (delayMs === null) {
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "error", error_message: `Retry backoff exhausted: ${payload.error}` },
				caused_by: event.event_id,
			});
			return;
		}

		this._emit({
			actor_id: "runtime",
			type: "RETRY_SCHEDULED",
			payload: {
				attempt: nextAttempt,
				max_attempts: this.retryPolicy.maxAttempts,
				delay_ms: delayMs,
				error_message: payload.error,
			},
			caused_by: event.event_id,
		});

		setTimeout(() => {
			if (!this._shouldInterrupt()) {
				this._emit({
					actor_id: "coder_agent",
					type: "AGENT_TURN_REQUESTED",
					payload: { reason: "retry", retry_attempt: nextAttempt },
					caused_by: event.event_id,
				});
			}
		}, delayMs);
	}

	/** Walk causal chain back to find the highest retry_attempt seen. */
	private _attemptCount(eventId: string): number {
		const chain = this.config.store.getCausalChain(eventId);
		let attempt = 0;
		for (const e of chain) {
			if (e.type === "AGENT_TURN_REQUESTED") {
				const p = e.payload as { retry_attempt?: number };
				if (p.retry_attempt !== undefined && p.retry_attempt > attempt) {
					attempt = p.retry_attempt;
				}
			}
		}
		return attempt;
	}

	// ─── USER_APPROVAL ──────────────────────────────────────────────────────

	private async _onUserApproval(event: EventBase): Promise<void> {
		const payload = event.payload as { intent_event_id: string };
		const pending = this._pendingApprovals.get(payload.intent_event_id);
		if (pending) {
			this._pendingApprovals.delete(payload.intent_event_id);
			pending.resolve(true);
		}
	}

	// ─── USER_REJECTION ─────────────────────────────────────────────────────

	private async _onUserRejection(event: EventBase): Promise<void> {
		const payload = event.payload as { intent_event_id: string };
		const pending = this._pendingApprovals.get(payload.intent_event_id);
		if (pending) {
			this._pendingApprovals.delete(payload.intent_event_id);
			pending.resolve(false);
		}
	}

	// ─── COMPACTION ─────────────────────────────────────────────────────────

	private async _onCompactionRequested(event: EventBase): Promise<void> {
		if (this.compactionAbort) return; // Already running

		const payload = event.payload as { reason: "manual" | "threshold" | "overflow"; token_count: number };
		this.compactionAbort = new AbortController();

		this._emit({
			actor_id: "compactor",
			type: "COMPACTION_START",
			payload: { token_count: payload.token_count },
			caused_by: event.event_id,
		});

		try {
			const outcome = await this.compactionPolicy.compact(payload.reason, this.compactionAbort.signal);
			this._emit({
				actor_id: "compactor",
				type: "COMPACTION_END",
				payload: {
					summary: outcome.summary,
					first_kept_event_id: outcome.first_kept_event_id,
					tokens_before: outcome.tokens_before,
					tokens_after: outcome.tokens_after,
				},
				caused_by: event.event_id,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._emit({
				actor_id: "compactor",
				type: "COMPACTION_END",
				payload: {
					summary: `Compaction failed: ${msg}`,
					first_kept_event_id: "",
					tokens_before: 0,
				},
				caused_by: event.event_id,
			});
		} finally {
			this.compactionAbort = undefined;
		}
	}

	/**
	 * Check compaction policy after a non-error turn. Emits COMPACTION_REQUESTED if
	 * threshold or overflow conditions are met.
	 */
	private _checkCompaction(turnCompletedEvent: EventBase): void {
		const policy = this.compactionPolicy;

		// Walk the causal chain to find the AGENT_MESSAGE_END that produced this turn completion.
		// This avoids mutable state (_lastAssistantMessageEvent) that races with synchronous event dispatch.
		const lastAssistant = this._findLastAssistantMessage(turnCompletedEvent.event_id);

		// Overflow takes priority — when it fires we skip the threshold check entirely.
		// This prevents both "overflow" and "threshold" COMPACTION_REQUESTED events from
		// being emitted in the same turn (overflow implies context is over threshold too).
		if (policy.isOverflow(lastAssistant)) {
			const tokens = policy.estimateContextTokens();
			this._emit({
				actor_id: "runtime",
				type: "COMPACTION_REQUESTED",
				payload: { reason: "overflow", token_count: tokens },
				caused_by: turnCompletedEvent.event_id,
			});
			return;
		}

		const tokens = policy.estimateContextTokens();
		const window = policy.contextWindow();
		if (window > 0 && window !== Number.MAX_SAFE_INTEGER && tokens > window * policy.threshold()) {
			this._emit({
				actor_id: "runtime",
				type: "COMPACTION_REQUESTED",
				payload: { reason: "threshold", token_count: tokens },
				caused_by: turnCompletedEvent.event_id,
			});
		}
	}

	/**
	 * Walk causal chain back from the given event to find the most recent AGENT_MESSAGE_END.
	 * Replaces the mutable _lastAssistantMessageEvent field which races with synchronous dispatch.
	 */
	private _findLastAssistantMessage(eventId: string): EventBase | undefined {
		const chain = this.config.store.getCausalChain(eventId);
		for (let i = chain.length - 1; i >= 0; i--) {
			if (chain[i].type === "AGENT_MESSAGE_END") return chain[i];
		}
		return undefined;
	}

}
