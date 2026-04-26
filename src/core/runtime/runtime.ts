/**
 * Event-Sourced Runtime
 *
 * Top-level runtime that assembles EventStore + SessionManager + IntentExecutor + AgentLoop.
 * Provides unified interface for UI layers.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { EventBase, ImageContent } from "../event-store/types.js";
import type { EventStore, SubscribeOptions } from "../event-store/store.js";
import type { SessionDescriptor } from "../projection/types.js";
import type { ToolRegistry, ApprovalHandler } from "../intent/types.js";
import type { LLMClient, ModelConfig, ToolDefinition } from "./agent-loop.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import { deriveWorkspaceId, getEventDatabasePath, getSessionIndexPath } from "../event-store/workspace.js";
import { SessionManager } from "../projection/session-manager.js";
import { IntentExecutor } from "../intent/executor.js";
import { IntentClassifier } from "../intent/classifier.js";
import { AgentLoop } from "./agent-loop.js";
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
	readonly sessionManager: SessionManager;
	readonly intentExecutor: IntentExecutor;
	readonly runtimeAdapter: RuntimeAdapter;
	private agentLoop: AgentLoop | null = null;
	private _isRunning = false;
	private config: EventSourcedRuntimeConfig;
	private ownsStore: boolean;

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

		// 2. Create or use provided SessionManager
		this.sessionManager = config.sessionManager ?? new SessionManager(
			this.store,
			config.sessionIndexPath ?? getSessionIndexPath(this.store.workspace_id, config.agentDir),
		);

		// 3. Create IntentClassifier
		const classifier = new IntentClassifier({
			approve_writes: config.classifierConfig?.approve_writes ?? false,
			approve_edits: config.classifierConfig?.approve_edits ?? false,
			approve_shell_moderate: config.classifierConfig?.approve_shell_moderate ?? false,
			approve_unknown: config.classifierConfig?.approve_unknown ?? true,
		});

		// 4. Create IntentExecutor
		this.intentExecutor = new IntentExecutor(
			this.store,
			classifier,
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
	 * Process user input.
	 */
	async prompt(text: string, images?: ImageContent[]): Promise<void> {
		if (this._isRunning) {
			// Queue as steering (interrupt current turn)
			this.store.append({
				actor_id: "user",
				type: "USER_INTERRUPT",
				payload: { content: text, images },
			});
			return;
		}

		this._isRunning = true;

		try {
			// 1. Append user message event
			const userEvent = this.store.append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: text, images },
			});

			// 2. Get active session projection
			const projection = this.sessionManager.getActiveSession();

			// 3. Create and run agent loop
			this.agentLoop = new AgentLoop(this.store, {
				projection,
				systemPrompt: this.config.systemPrompt,
				model: this.config.model,
				tools: this.config.tools,
				contextBudget: this.config.contextBudget ?? 128000,
				llmClient: this.config.llmClient,
				intentExecutor: this.intentExecutor,
				toolRegistry: this.config.toolRegistry,
			});

			await this.agentLoop.run(userEvent.event_id);
		} finally {
			this._isRunning = false;
			this.agentLoop = null;
		}
	}

	/**
	 * Check if runtime is currently processing.
	 */
	get isRunning(): boolean {
		return this._isRunning;
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
		this.agentLoop?.interrupt();
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
	 * Fork session at a specific event.
	 */
	fork(eventId: string): SessionDescriptor {
		return this.sessionManager.forkAt(eventId);
	}

	/**
	 * Switch to a different session.
	 */
	switchSession(sessionId: string): void {
		this.sessionManager.switchTo(sessionId);
	}

	/**
	 * Create a new session.
	 */
	createSession(name?: string): SessionDescriptor {
		return this.sessionManager.createSession("user_explicit", name);
	}

	/**
	 * Get current session descriptor.
	 */
	getCurrentSession(): SessionDescriptor | undefined {
		const sessionId = this.sessionManager.getActiveSessionId();
		return sessionId ? this.sessionManager.getSession(sessionId) : undefined;
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
		this.sessionManager.dispose();
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
