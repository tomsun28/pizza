/**
 * Event-Sourced Runtime
 *
 * Top-level runtime that assembles EventStore + SessionManager + Reactor.
 * Provides unified interface for UI layers.
 */

import type { AgentMessage } from "../agent/types.js";
import type { EventBase, ImageContent } from "../event-store/types.js";
import type { EventStore, SubscribeOptions } from "../event-store/store.js";
import type { SessionDescriptor } from "../projection/types.js";
import type { ToolRegistry, ApprovalHandler } from "../intent/types.js";
import type { LLMClient, ModelConfig, ToolDefinition } from "./llm-types.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import { ThreadScopedStore } from "../event-store/thread-scoped-store.js";
import { SessionStore, isSessionStore } from "../event-store/session-store.js";
import { deriveWorkspaceId, getEventDatabasePath } from "../event-store/workspace.js";
import { SessionManager } from "../projection/session-manager.js";
import { SessionProjection } from "../projection/session-projection.js";
import { TimelineProjection, type TimelineQueryOptions } from "../projection/timeline-projection.js";
import { IntentClassifier, type ClassifierConfig } from "../intent/classifier.js";
import { Reactor } from "./reactor.js";
import type { CheckpointRef, RuntimeAdapter, RuntimeStatus } from "./types.js";
import { LocalRuntimeAdapter } from "./local-runtime.js";
import { CompactionEngine, type CompactionEngineSettings } from "../compaction/compaction-engine.js";
import { getAgentDir } from "../../config.js";

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
	/** Pre-configured EventStore (optional, will create if not provided) */
	store?: EventStore;
	/** Thread ID for event isolation. When set, the runtime wraps its store so every appended event carries thread_id = threadId. */
	threadId?: string;
	/** Pre-configured SessionManager (optional, will create if not provided) */
	sessionManager?: SessionManager;
	/** Classifier configuration */
	classifierConfig?: ClassifierConfig;
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
	/** Whether assistant messages that complete with stop_reason=error should be retried by the reactor. */
	retryAssistantErrorCompletions?: boolean;
	/** Compaction policy (default: NoopCompactionPolicy). */
	compactionPolicy?: import("./policies.js").CompactionPolicy;
	/** Settings for the default event-sourced compaction engine. Ignored when compactionPolicy is provided. */
	compactionEngineSettings?: CompactionEngineSettings;
}

export interface RuntimeCompactOptions {
	reason?: "manual" | "threshold" | "overflow";
	token_count?: number;
}

// ============================================================================
// Event-Sourced Runtime
// ============================================================================

/**
 * EventSourcedRuntime - the primary LLM execution engine.
 *
 * Assembles EventStore + SessionManager + Reactor.
 * Provides unified interface for UI layers.
 */
export class EventSourcedRuntime {
	readonly store: EventStore;
	readonly sessionManager: SessionManager | undefined;
	readonly runtimeAdapter: RuntimeAdapter;
	readonly classifier: IntentClassifier;
	private reactor: Reactor | null = null;
	private config: EventSourcedRuntimeConfig;
	private readonly ownsStore: boolean;

	/** Working directory for this runtime */
	get cwd(): string { return this.config.cwd; }
	/** Agent data directory */
	get agentDir(): string { return this.config.agentDir ?? getAgentDir(); }
	private _isProcessing = false;
	private _turnCompletionWaiters: Array<() => void> = [];
	private _turnSubscription: (() => void) | undefined;
	private _resolveSettled: (() => void) | undefined;
	constructor(config: EventSourcedRuntimeConfig) {
		this.config = config;
		this.ownsStore = !config.store;

		// 1. Create or use provided EventStore
		const workspaceId = deriveWorkspaceId(config.cwd);
		const rawStore = config.store ?? new SqliteEventStore(
			workspaceId,
			config.storagePath ?? getEventDatabasePath(workspaceId, config.agentDir),
		);
		this.store = config.threadId ? new ThreadScopedStore(rawStore, config.threadId) : rawStore;

		this.runtimeAdapter = config.runtimeAdapter ?? new LocalRuntimeAdapter({
			workspace_id: this.store.workspace_id,
			cwd: config.cwd,
			agentDir: config.agentDir,
			toolRegistry: config.toolRegistry,
		});

		// 2. Create or use provided SessionManager (optional for migration)
		this.sessionManager = config.sessionManager ?? (config.sessionManager !== undefined ? new SessionManager(
			this.store,
			isSessionStore(rawStore) ? (rawStore as SessionStore) : undefined,
		) : undefined);

		// 3. Create IntentClassifier
		this.classifier = new IntentClassifier(config.classifierConfig);

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
			throw new Error(
				"EventSourcedRuntime is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		this._isProcessing = true;

		try {
			// Lazy-create the reactor and start it. Reactor lives only as long as the prompt cycle.
			const projection = this.getProjection();

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
				retryAssistantErrorCompletions: this.config.retryAssistantErrorCompletions,
				compactionPolicy: this.config.compactionPolicy ?? new CompactionEngine({
					store: this.store,
					projection,
					llmClient: this.config.llmClient,
					model: this.config.model,
					settings: {
						contextWindow: this.config.contextBudget ?? 128000,
						...this.config.compactionEngineSettings,
					},
				}),
			sessionManager: this.sessionManager,
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
			this._resolveIdleWaiters();
		}
	}

	/**
	 * Check if runtime is currently processing.
	 */
	get isRunning(): boolean {
		return this._isProcessing;
	}

	get signal(): AbortSignal | undefined {
		return this.reactor?.signal;
	}

	/**
	 * Resolve when the current prompt cycle is fully settled.
	 */
	waitForIdle(): Promise<void> {
		if (!this._isProcessing) return Promise.resolve();
		return new Promise((resolve) => {
			this._turnCompletionWaiters.push(resolve);
		});
	}

	private _resolveIdleWaiters(): void {
		const waiters = this._turnCompletionWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	/**
	 * Interrupt current execution.
	 *
	 * Sets _abortedByUser on the reactor, which causes _onAgentTurnCompleted to discard
	 * queued follow-ups and let the reactor settle. The settled promise resolves naturally
	 * when the current turn finishes (via _waitUntilSettled).
	 *
	 * Edge case: if no turn is running (no AGENT_TURN_COMPLETED will fire), also resolve
	 * the settled promise immediately so the caller doesn't hang.
	 */
	abort(): void {
		this.store.append({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: {},
		});
		this.reactor?.interrupt();
		// The _waitUntilSettled subscription will resolve when AGENT_TURN_COMPLETED fires.
		// But if no turn is running (or the turn fails before starting), we resolve immediately.
		if (!this._isProcessing && this._resolveSettled) {
			this._resolveSettled();
		}
	}

	/**
	 * Inject a steer message — interrupts the current turn and delivers the message
	 * as a follow-up after the current turn settles.
	 */
	steer(text: string, images?: ImageContent[]): void {
		if (!this._isProcessing) {
			this.store.append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: text, images },
			});
			return;
		}
		this.store.append({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: { content: text, images, reason: "steer" },
		});
	}

	/**
	 * Queue a follow-up message — delivered after the current turn naturally completes.
	 * If the runtime is not processing, queues it for the next prompt.
	 */
	followUp(text: string, images?: ImageContent[]): void {
		this.store.append({
			actor_id: "user",
			type: "USER_FOLLOWUP_QUEUED",
			payload: { content: text, images },
		});
	}

	/**
	 * Request context compaction. The active reactor handles this immediately when
	 * running; otherwise the request is recorded for the event stream.
	 */
	compact(options?: RuntimeCompactOptions): void {
		this.store.append({
			actor_id: "user",
			type: "COMPACTION_REQUESTED",
			payload: {
				reason: options?.reason ?? "manual",
				token_count: options?.token_count ?? 0,
			},
		});
	}

	setModel(provider: string, modelId: string): void {
		const previous_provider = this.config.model.provider;
		const previous_model_id = this.config.model.model_id;
		this.config.model.provider = provider;
		this.config.model.model_id = modelId;
		this.store.append({
			actor_id: "user",
			type: "MODEL_CHANGED",
			payload: {
				provider,
				model_id: modelId,
				previous_provider,
				previous_model_id,
			},
		});
	}

	getModel(): ModelConfig {
		return { ...this.config.model };
	}

	setThinkingLevel(level: string): void {
		const previous_level = this.config.model.thinking_level;
		this.config.model.thinking_level = level;
		this.store.append({
			actor_id: "user",
			type: "THINKING_LEVEL_CHANGED",
			payload: { level, previous_level },
		});
	}

	getThinkingLevel(): string | undefined {
		return this.config.model.thinking_level;
	}

	getProjection(): SessionProjection {
		return this.sessionManager?.getActiveSession() ?? this._createDefaultProjection();
	}

	getTools(): ToolDefinition[] {
		return [...this.config.tools];
	}

	setTools(tools: ToolDefinition[]): void {
		this.config.tools.splice(0, this.config.tools.length, ...tools);
		this.store.append({
			actor_id: "user",
			type: "USER_CONFIG_CHANGE",
			payload: { key: "tools", old_value: undefined, new_value: tools.map((tool) => tool.name) },
		});
	}

	getSystemPrompt(): string {
		return this.config.systemPrompt;
	}

	setSystemPrompt(prompt: string): void {
		const old_value = this.config.systemPrompt;
		this.config.systemPrompt = prompt;
		this.store.append({
			actor_id: "user",
			type: "USER_CONFIG_CHANGE",
			payload: { key: "systemPrompt", old_value, new_value: prompt },
		});
	}

	setApprovalHandler(approvalHandler: ApprovalHandler): void {
		this.config.approvalHandler = approvalHandler;
	}

	private _createDefaultProjection(): SessionProjection {
		const desc: SessionDescriptor = {
			session_id: "default",
			thread_id: "default",
			workspace_id: this.store.workspace_id,
			event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
			created_by: "user_explicit",
			created_at: Date.now(),
		};
		return new SessionProjection(this.store, desc);
	}

	/**
	 * Wait until the reactor has settled — i.e. an AGENT_TURN_COMPLETED fires AND
	 * no further USER_MESSAGE has been appended in the same tick (e.g. by follow-up draining).
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
						const retriesRemaining = this.reactor?.pendingRetryCount ?? 0;
						if (retriesRemaining > 0) return;
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
	config: Omit<EventSourcedRuntimeConfig, "cwd" | "storagePath">,
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
		retryPolicy: config.retryPolicy,
		compactionPolicy: config.compactionPolicy,
		compactionEngineSettings: config.compactionEngineSettings,
	});
}
