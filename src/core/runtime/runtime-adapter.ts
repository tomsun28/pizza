/**
 * Runtime Adapter
 *
 * Adapts EventSourcedRuntime to the AgentSessionRuntime interface
 * used by interactive-mode and other UI layers.
 *
 * This enables gradual migration from the legacy AgentSession-based
 * runtime to the new event-sourced runtime.
 */

import type { AgentSession } from "../agent-session.js";
import type { AgentSessionServices } from "../agent-session-services.js";
import type { AgentSessionRuntime } from "../agent-session-runtime.js";
import type { SessionManager as LegacySessionManager } from "../session-manager.js";
import type { EventStore } from "../event-store/store.js";
import type { LLMClient, ModelConfig, ToolDefinition } from "./llm-types.js";
import type { ToolRegistry, ApprovalHandler } from "../intent/types.js";
import { createEventSourcedRuntime, type EventSourcedRuntimeConfig } from "./runtime.js";
import { createToolRegistry } from "../intent/tool-adapter.js";

// ============================================================================
// Compatibility Layer
// ============================================================================

/**
 * EventSourcedRuntimeHost - holds both legacy AgentSessionRuntime and new EventSourcedRuntime.
 *
 * This is a bridge layer that allows interactive-mode to work with the new
 * event-sourced runtime while we gradually migrate away from AgentSession.
 *
	 * Session operations (switch, new, fork) delegate to the legacy runtime.
 * Event-sourced features (timeline, projections, checkpoints) use the new runtime.
 */
export class EventSourcedRuntimeHost {
	constructor(
		private legacyRuntime: AgentSessionRuntime,
		private _eventSourcedRuntime: ReturnType<typeof createEventSourcedRuntime>,
	) {}

	// Legacy runtime delegation (session management)
	get session() {
		return this.legacyRuntime.session;
	}

	get services() {
		return this.legacyRuntime.services;
	}

	get cwd() {
		return this.legacyRuntime.cwd;
	}

	get diagnostics() {
		return this.legacyRuntime.diagnostics;
	}

	get modelFallbackMessage() {
		return this.legacyRuntime.modelFallbackMessage;
	}

	get eventStore() {
		return this.legacyRuntime.eventStore;
	}

	setRebindSession(rebind?: (session: AgentSession) => Promise<void>): void {
		this.legacyRuntime.setRebindSession(rebind);
	}

	async switchSession(
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: any) => Promise<void> },
	) {
		return this.legacyRuntime.switchSession(sessionPath, options);
	}

	async newSession(options?: any) {
		return this.legacyRuntime.newSession(options);
	}

	async fork(entryId: string, options?: any) {
		return this.legacyRuntime.fork(entryId, options);
	}

	async dispose() {
		this._eventSourcedRuntime.dispose();
		await this.legacyRuntime.dispose();
	}

	// New event-sourced runtime features
	get eventSourcedRuntime() {
		return this._eventSourcedRuntime;
	}

	getTimeline(options?: any) {
		return this._eventSourcedRuntime.getTimeline(options);
	}

	async createCheckpoint(label?: string) {
		return this._eventSourcedRuntime.createCheckpoint(label);
	}

	async restoreCheckpoint(checkpoint: any) {
		return this._eventSourcedRuntime.restoreCheckpoint(checkpoint);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Factory options for creating an EventSourcedRuntimeHost.
 */
export interface CreateEventSourcedRuntimeHostOptions {
	/** Legacy AgentSessionRuntime (already created) */
	legacyRuntime: AgentSessionRuntime;
	/** LLM client */
	llmClient: LLMClient;
	/** System prompt */
	systemPrompt: string;
	/** Model configuration */
	model: ModelConfig;
	/** Tools available to the agent (AgentTool instances) */
	tools: Array<{ name: string; description?: string; parameters: any }>;
	/** Approval handler for UI */
	approvalHandler?: ApprovalHandler;
	/** Context token budget */
	contextBudget?: number;
}

/**
 * Create an EventSourcedRuntimeHost from the legacy components.
 *
 * This factory bridges the gap between the old AgentSession-based
 * architecture and the new event-sourced runtime.
 *
 * Usage in main.ts:
 *   const host = await createEventSourcedRuntimeHost({
 *     cwd,
 *     agentDir,
 *     session: created.session,
 *     services: services,
 *     llmClient: ...,
 *     systemPrompt: ...,
 *     model: ...,
 *     tools: sessionOptions.tools,
 *   });
 *   const runtime = host as AgentSessionRuntime; // compatible interface
 */
export async function createEventSourcedRuntimeHost(
	options: CreateEventSourcedRuntimeHostOptions,
): Promise<EventSourcedRuntimeHost> {
	const { legacyRuntime, llmClient, systemPrompt, model, tools, approvalHandler, contextBudget } = options;
	const { session, services } = legacyRuntime;

	// Use the EventStore from the legacy runtime (it already has one)
	const eventStore = legacyRuntime.eventStore;

	// Convert AgentTool[] to ToolRegistry
	const toolRegistry = createToolRegistry(tools as any);

	// Create RuntimeAdapter (uses LocalRuntimeAdapter for now)
	const { LocalRuntimeAdapter } = await import("./local-runtime.js");
	const runtimeAdapter = new LocalRuntimeAdapter({
		workspace_id: eventStore.workspace_id,
		cwd: legacyRuntime.cwd,
		toolRegistry,
	});

	// Create IntentClassifier with optional config
	const { IntentClassifier } = await import("../intent/classifier.js");
	const classifier = new IntentClassifier({
		approve_writes: false,
		approve_edits: false,
		approve_shell_moderate: false,
		approve_unknown: true,
	});

	// Convert tools to ToolDefinition format
	const toolDefinitions: ToolDefinition[] = tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters,
	}));

	// Create EventSourcedRuntime
	const runtime = createEventSourcedRuntime(
		eventStore,
		undefined as any, // TODO: SessionManager bridge - for now pass undefined
		{
			agentDir: services.agentDir,
			classifierConfig: {
				approve_writes: false,
				approve_edits: false,
				approve_shell_moderate: false,
				approve_unknown: true,
			},
			toolRegistry,
			runtimeAdapter,
			approvalHandler,
			llmClient,
			systemPrompt,
			model,
			tools: toolDefinitions,
			contextBudget: contextBudget ?? 100000,
		},
	);

	return new EventSourcedRuntimeHost(legacyRuntime, runtime);
}
