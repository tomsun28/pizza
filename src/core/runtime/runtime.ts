/**
 * Event-Sourced Runtime
 *
 * Top-level runtime that assembles EventStore + SessionManager + IntentExecutor + AgentLoop.
 * Provides unified interface for UI layers.
 */

import type { AgentMessage } from "../agent/types.js";
import type { EventBase, ImageContent } from "../event-store/types.js";
import type { EventStore, SubscribeOptions } from "../event-store/store.js";
import type { SessionDescriptor } from "../projection/types.js";
import type { ToolRegistry, ApprovalHandler } from "../intent/types.js";
import type { LLMClient, ModelConfig, ToolDefinition } from "./llm-types.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import { deriveWorkspaceId, getEventDatabasePath, getSessionIndexPath } from "../event-store/workspace.js";
import { SessionManager } from "../projection/session-manager.js";
import { SessionProjection } from "../projection/session-projection.js";
import { TimelineProjection, type TimelineQueryOptions } from "../projection/timeline-projection.js";
import { IntentExecutor } from "../intent/executor.js";
import { IntentClassifier } from "../intent/classifier.js";
import { Reactor } from "./reactor.js";
import type { CheckpointRef, RuntimeAdapter, RuntimeStatus } from "./types.js";
import { LocalRuntimeAdapter } from "./local-runtime.js";

// ============================================================================
// Runtime Configuration
// ============================================================================

export interface EventSourcedRuntimeConfig {
	/** Working directory (used to derive workspace_id) */
	cwd: string;
	/** Agent directory for storage */
	agentDir?: string;
	/** SQLite database path for events (overrides default) */
	storagePath?: string;
	/** Session index path (overrides default) */
	sessionIndexPath?: string;
	/** Pre-configured EventStore (optional, will create if not provided) */
	store?: EventStore;
	/** Pre-configured SessionManager (optional, will create if not provided) */
	sessionManager?: SessionManager;
	/** Classifier configuration */
	classifierConfig?: {
		approve_writes?: boolean;
		approve_edits?: boolean;
		approve_shell_moderate?: boolean;
		approve_unknown?: boolean;
	};
	/** Tool registry */
	toolRegistry: ToolRegistry;
	/** Runtime adapter for deterministic tool execution and checkpoints */
	runtimeAdapter?: RuntimeAdapter;
	/** Approval handler for UI */
	approvalHandler?: ApprovalHandler;
	/** LLM client */
	llmClient: LLMClient;
	/** System prompt */
	systemPrompt: string;
	/** Model configuration */
	model: ModelConfig;
	/** Tools available to the agent */
	tools: ToolDefinition[];
	/** Context token budget */
	contextBudget?: number;
	/** Retry policy (default: DefaultRetryPolicy). */
	retryPolicy?: import("./policies.js").RetryPolicy;
	/** Compaction policy (default: NoopCompactionPolicy). */
	compactionPolicy?: import("./policies.js").CompactionPolicy;
}

// ============================================================================
// Event-Sourced Runtime
// ============================================================================

/**
 * EventSourcedRuntime - replaces the original AgentSessionRuntime.
 *
 * Assembles EventStore + SessionManager + IntentExecutor + AgentLoop.
 * Provides unified interface for UI layers.
 */
export class EventSourcedRuntime {
	readonly store: EventStore;
	readonly sessionManager: SessionManager | undefined;
	readonly intentExecutor: IntentExecutor;
	readonly runtimeAdapter: RuntimeAdapter;
	readonly classifier: IntentClassifier;
	private reactor: Reactor | null = null;
	private config: EventSourcedRuntimeConfig;
	private ownsStore: boolean;
	private _isProcessing = false;
	private _turnCompletionWaiters: Array<() => void> = [];
	private _turnSubscription: (() => void) | undefined;
	private _resolveSettled: (() => void) | undefined;
	constructor(config: EventSourcedRuntimeConfig) {
		this.config = config;
		this.ownsStore = !config.store;

		// 1. Create or use provided EventStore
		const workspaceId = deriveWorkspaceId(config.cwd);
		this.store = config.store ?? new SqliteEventStore(
			workspaceId,
			config.storagePath ?? getEventDatabasePath(workspaceId, config.agentDir),
		);

		this.runtimeAdapter = config.runtimeAdapter ?? new LocalRuntimeAdapter({
			workspace_id: this.store.workspace_id,
			cwd: config.cwd,
			agentDir: config.agentDir,
			toolRegistry: config.toolRegistry,
		});

		// 2. Create or use provided SessionManager (optional for migration)
		this.sessionManager = config.sessionManager ?? (config.sessionManager !== undefined ? new SessionManager(
			this.store,
			config.sessionIndexPath ?? getSessionIndexPath(this.store.workspace_id, config.agentDir),
		) : undefined);

		// 3. Create IntentClassifier
		this.classifier = new IntentClassifier({
			approve_writes: config.classifierConfig?.approve_writes ?? false,
			approve_edits: config.classifierConfig?.approve_edits ?? false,
			approve_shell_moderate: config.classifierConfig?.approve_shell_moderate ?? false,
			approve_unknown: config.classifierConfig?.approve_unknown ?? true,
		});

		// 4. Create IntentExecutor (still used for the legacy direct execution path)
		this.intentExecutor = new IntentExecutor(
			this.store,
			this.classifier,
			config.toolRegistry,
			config.approvalHandler,
			this.runtimeAdapter,
		);

		this.store.append({
			actor_id: "runtime",
			type: "RUNTIME_STARTED",
			payload: { runtime_id: this.runtimeAdapter.runtime_id, kind: this.runtimeAdapter.kind, cwd: config.cwd },
		});
	}

	/**
	 * Process user input. Drives the reactor to completion (one turn cycle).
	 */
	async prompt(text: string, images?: ImageContent[]): Promise<void> {
		if (this._isProcessing) {
			// Reactor is already running — just emit USER_INTERRUPT so the running
			// reactor sees the new input and steers.
			this.store.append({
				actor_id: "user",
				type: "USER_INTERRUPT",
				payload: { content: text },
			});
			return;
		}

		this._isProcessing = true;

		try {
			// Lazy-create the reactor and start it. Reactor lives only as long as the prompt cycle.
			const projection = this.sessionManager?.getActiveSession() ?? (() => {
				// Fallback: create a minimal SessionProjection if no SessionManager
				const desc: SessionDescriptor = {
					session_id: "default",
					workspace_id: this.store.workspace_id,
					event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
					created_by: "user_explicit",
					created_at: Date.now(),
				};
				return new SessionProjection(this.store, desc);
			})();

			this.reactor = new Reactor({
				store: this.store,
				projection,
				llmClient: this.config.llmClient,
				classifier: this.classifier,
				toolRegistry: this.config.toolRegistry,
				approvalHandler: this.config.approvalHandler,
				runtimeAdapter: this.runtimeAdapter,
				systemPrompt: this.config.systemPrompt,
				model: this.config.model,
				contextBudget: this.config.contextBudget ?? 128000,
				tools: this.config.tools,
				retryPolicy: this.config.retryPolicy,
				compactionPolicy: this.config.compactionPolicy,
			});

			await this.reactor.start();

			// Wait until the reactor reaches a fully idle state. The reactor may chain
			// multiple turns (e.g. follow-up queue draining), so we keep waiting until settled.
			const settledPromise = this._waitUntilSettled();

			// Append the user message — the reactor will pick it up
			this.store.append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: text, images },
			});

			await settledPromise;
		} finally {
			this._turnSubscription?.();
			this._turnSubscription = undefined;
			this.reactor?.stop();
			this.reactor = null;
			this._isProcessing = false;
		}
	}

	/**
	 * Check if runtime is currently processing.
	 */
	get isRunning(): boolean {
		return this._isProcessing;
	}

	/**
	 * Interrupt current execution.
	 */
	abort(): void {
		this.store.append({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: {},
		});
		this.reactor?.interrupt();
		// Resolve the settled promise — abort may be called before the LLM call starts
		// and no AGENT_TURN_COMPLETED would ever fire.
		if (this._resolveSettled) {
			this._resolveSettled();
		}
	}

	/**
	 * Inject a steer message — interrupts the current turn and delivers the message
	 * as a follow-up after the current turn settles.
	 */
	steer(text: string, images?: ImageContent[]): void {
		this.store.append({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: { content: text, images, reason: "steer" },
		});
	}

	/**
	 * Tracks whether a follow-up was queued during a settled turn.
	 * _nextStep() sets this to true when it processes a queued follow-up,
	 * so _waitUntilSettled() knows to wait for the next turn.
	 */
	private _followUpQueuedInTurn = false;

	/**
	 * Queue a follow-up message — delivered after the current turn naturally completes.
	 * If the runtime is not processing, queues it for the next prompt.
	 */
	followUp(text: string, images?: ImageContent[]): void {
		this._followUpQueuedInTurn = true;
		this.store.append({
			actor_id: "user",
			type: "USER_FOLLOWUP_QUEUED",
			payload: { content: text, images },
		});
	}

	/**
	 * Wait until the reactor has settled — i.e. an AGENT_TURN_COMPLETED fires AND
	 * no further USER_MESSAGE has been appended in the same tick (e.g. by follow-up draining).
	 * Also waits for another turn if a follow-up was consumed in the current turn
	 * (detected via _followUpQueuedInTurn flag, which _nextStep() sets when it processes
	 * a queued follow-up vs. a newly-appended one).
	 */
	private _waitUntilSettled(): Promise<void> {
		return new Promise<void>((resolve) => {
			this._resolveSettled = resolve;
			let pendingCheck = false;
			const unsub = this.store.subscribe(
				() => {
					if (pendingCheck) return;
					pendingCheck = true;
					queueMicrotask(() => {
						pendingCheck = false;
						const followUpsRemaining = this.reactor?.pendingFollowUpCount ?? 0;
						if (followUpsRemaining > 0) return;
						// Detect whether a follow-up was consumed in the current turn by
						// checking the flag _nextStep sets when processing a queued follow-up.
						if (this._followUpQueuedInTurn) {
							this._followUpQueuedInTurn = false;
							return; // Wait for next turn
						}
						const lastMsg = this.store.query({ types: ["USER_MESSAGE"], reverse: true, limit: 1 })[0];
						const lastCompleted = this.store.query({
							types: ["AGENT_TURN_COMPLETED"],
							reverse: true,
							limit: 1,
						})[0];
						if (lastMsg && lastCompleted && lastMsg.sequence > lastCompleted.sequence) return;
						unsub();
						resolve();
					});
				},
				{ types: ["AGENT_TURN_COMPLETED"] },
			);
			this._turnSubscription = unsub;
		});
	}

	/**
	 * Approve a pending intent.
	 */
	approve(intentEventId: string): void {
		this.store.append({
			actor_id: "user",
			type: "USER_APPROVAL",
			payload: { intent_event_id: intentEventId },
		});
	}

	/**
	 * Reject a pending intent.
	 */
	reject(intentEventId: string): void {
		this.store.append({
			actor_id: "user",
			type: "USER_REJECTION",
			payload: { intent_event_id: intentEventId },
		});
	}

	/**
	 * Subscribe to real-time events (for UI).
	 */
	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		return this.store.subscribe(handler, options);
	}

	/**
	 * Query the activity timeline (for UI rendering).
	 */
	getTimeline(options?: TimelineQueryOptions) {
		const projection = new TimelineProjection(this.store);
		return projection.query(options);
	}

	/**
	 * Fork session at a specific event.
	 */
	fork(eventId: string): SessionDescriptor {
		return this.sessionManager?.forkAt(eventId) as any;
	}

	/**
	 * Switch to a different session.
	 */
	switchSession(sessionId: string): void {
		this.sessionManager?.switchTo(sessionId);
	}

	/**
	 * Create a new session.
	 */
	createSession(name?: string): SessionDescriptor {
		return this.sessionManager?.createSession("user_explicit", name) as any;
	}

	/**
	 * Get current session descriptor.
	 */
	getCurrentSession(): SessionDescriptor | undefined {
		const sessionId = this.sessionManager?.getActiveSessionId();
		return sessionId ? this.sessionManager?.getSession(sessionId) : undefined;
	}

	async createCheckpoint(label?: string): Promise<CheckpointRef> {
		const checkpoint = await this.runtimeAdapter.createCheckpoint({
			cwd: this.config.cwd,
			event_head: this.store.head,
			event_head_sequence: this.store.head_sequence,
			label,
		});
		this.store.append({
			actor_id: "runtime",
			type: "CHECKPOINT_CREATED",
			payload: checkpoint,
			caused_by: this.store.head,
		});
		return checkpoint;
	}

	async restoreCheckpoint(checkpoint: CheckpointRef): Promise<void> {
		try {
			await this.runtimeAdapter.restoreCheckpoint(checkpoint);
			this.store.append({
				actor_id: "runtime",
				type: "CHECKPOINT_RESTORED",
				payload: checkpoint,
				caused_by: checkpoint.event_head,
			});
		} catch (error) {
			this.store.append({
				actor_id: "runtime",
				type: "CHECKPOINT_FAILED",
				payload: {
					checkpoint,
					error_message: error instanceof Error ? error.message : String(error),
				},
				caused_by: checkpoint.event_head,
			});
			throw error;
		}
	}

	async getRuntimeStatus(): Promise<RuntimeStatus> {
		return this.runtimeAdapter.getStatus();
	}

	/**
	 * Dispose the runtime.
	 */
	dispose(): void {
		this.sessionManager?.dispose();
		this.intentExecutor.dispose();
		if (this.ownsStore) {
			(this.store as { close?: () => void }).close?.();
		}
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an EventSourcedRuntime from existing components.
 */
/**
 * Create an EventSourcedRuntime from existing components.
 *
 * Note: This factory bypasses the constructor to allow injection of
 * pre-configured EventStore and SessionManager instances.
 */
export function createEventSourcedRuntime(
	store: EventStore,
	sessionManager: SessionManager,
	config: Omit<EventSourcedRuntimeConfig, "cwd" | "storagePath" | "sessionIndexPath">,
): EventSourcedRuntime {
	return new EventSourcedRuntime({
		cwd: store.workspace_id, // workspace_id is used as cwd proxy
		store,
		sessionManager,
		toolRegistry: config.toolRegistry,
		classifierConfig: config.classifierConfig,
		runtimeAdapter: config.runtimeAdapter,
		approvalHandler: config.approvalHandler,
		llmClient: config.llmClient,
		systemPrompt: config.systemPrompt,
		model: config.model,
		tools: config.tools,
		contextBudget: config.contextBudget,
	});
}
