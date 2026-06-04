/**
 * Agent — Stateful agent wrapper with queue, lifecycle, and event subscription.
 *
 * This is pizza's own Agent class, independent of pi-agent-core.
 * Built on top of the agent loop from `./agent-loop.ts`.
 */

import { streamSimple } from "@mariozechner/pi-ai";
import type {
	AssistantMessage,
	ImageContent,
	SimpleStreamOptions,
	ThinkingBudgets,
	Transport,
} from "@mariozechner/pi-ai";
import {
	EventStoreToAgentEventTranslator,
	buildLlmClientFromStreamFn,
	buildToolDefinitions,
	buildToolRegistry,
	createHookingRuntimeAdapter,
	toModelConfig,
} from "./event-sourced-adapter.js";
import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	AfterToolCallContext,
	AfterToolCallResult,
	StreamFn,
	ToolExecutionMode,
} from "./types.js";

interface ActiveRun {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown" as const,
	provider: "unknown" as const,
	baseUrl: "",
	reasoning: false,
	input: [] as string[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
};

// ============================================================================
// Pending Message Queue
// ============================================================================

class PendingMessageQueue {
	messages: AgentMessage[] = [];

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): AgentMessage[] {
		const first = this.messages[0];
		if (!first) return [];
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}
}

// ============================================================================
// Mutable Agent State (field-based, not prop-based, for direct mutation)\n// ============================================================================

function createMutableAgentState(
	initial?: Partial<Pick<AgentState, "systemPrompt" | "model" | "thinkingLevel" | "tools" | "messages">>,
): AgentState & {
	set tools(v: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	set messages(v: AgentMessage[]);
	get messages(): AgentMessage[];
} {
	let _tools = initial?.tools?.slice() ?? [];
	let _messages = initial?.messages?.slice() ?? [];

	return {
		systemPrompt: initial?.systemPrompt ?? "",
		model: initial?.model ?? (DEFAULT_MODEL as any),
		thinkingLevel: initial?.thinkingLevel ?? "off",
		get tools() {
			return _tools;
		},
		set tools(v: AgentTool<any>[]) {
			_tools = v.slice();
		},
		get messages() {
			return _messages;
		},
		set messages(v: AgentMessage[]) {
			_messages = v.slice();
		},
		isStreaming: false,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	} as AgentState & {
		set tools(v: AgentTool<any>[]);
		get tools(): AgentTool<any>[];
		set messages(v: AgentMessage[]);
		get messages(): AgentMessage[];
	};
}

// ============================================================================
// Agent Options
// ============================================================================

export interface AgentOptions {
	initialState?: Partial<Pick<AgentState, "systemPrompt" | "model" | "thinkingLevel" | "tools" | "messages">>;
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
}

// ============================================================================
// Agent
// ============================================================================

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: AgentState & {
		set tools(v: AgentTool<any>[]);
		get tools(): AgentTool<any>[];
		set messages(v: AgentMessage[]);
		get messages(): AgentMessage[];
	};

	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => void | Promise<void>>();

	private readonly steeringQueue = new PendingMessageQueue();
	private readonly followUpQueue = new PendingMessageQueue();

	streamFn: StreamFn;
	getApiKey?: AgentOptions["getApiKey"];
	onPayload?: AgentOptions["onPayload"];
	onResponse?: AgentOptions["onResponse"];
	beforeToolCall?: AgentOptions["beforeToolCall"];
	afterToolCall?: AgentOptions["afterToolCall"];

	private activeRun?: ActiveRun;

	/** Session identifier forwarded to providers for cache-aware backends. */
	sessionId?: string;

	/** Optional per-level thinking token budgets forwarded to the stream function. */
	thinkingBudgets?: ThinkingBudgets;

	/** Preferred transport forwarded to the stream function. */
	transport: Transport;

	/** Optional cap for provider-requested retry delays. */
	maxRetryDelayMs?: number;

	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	toolExecution: ToolExecutionMode;

	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);

		this.streamFn = options.streamFn ?? streamSimple;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;

		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "sse";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.toolExecution = options.toolExecution ?? "parallel";
	}

	// ─── Reactor mode ──────────────────────────────────────────────────────

	private _eventTranslator?: EventStoreToAgentEventTranslator;
	private _runtimeAbortController?: AbortController;
	private _runtime?: import("../runtime/runtime.js").EventSourcedRuntime;

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
		// Forward to the live runtime if one is active
		if (this._runtime) {
			this._runtime.steer(this._extractText(message));
		}
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
		// Forward to the live runtime if one is active
		if (this._runtime) {
			this._runtime.followUp(this._extractText(message));
		}
	}

	/** Extract plain text from an AgentMessage's content field. */
	private _extractText(message: AgentMessage): string {
		const c = (message as any).content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) return c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
		return "";
	}
	/** Remove all queued steering messages. */

	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/**
	 * Abort the current run, if one is active.
	 *
	 * Emits USER_INTERRUPT into the EventStore so the
	 * reactor cleanly aborts in-flight tool execution and ends the turn,
	 * rather than leaving the runtime hanging.
	 */
	abort(): void {
		this.activeRun?.abortController.abort();
		this._runtime?.abort();
	}
	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		this._state.messages = [] as any;
		this._state.isStreaming = false;
		(this._state as any).streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/**
	 * Start a new prompt from text, a single message, or a batch of messages.
	 */
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		// Set activeRun BEFORE awaiting so the double-prompt guard works
		const ac = new AbortController();
		let resolveActive = () => {};
		this.activeRun = { promise: new Promise((r) => { resolveActive = r; }), resolve: resolveActive, abortController: ac };
		this._state.isStreaming = true;
		try {
			await this.runPromptViaReactor(messages);
		} finally {
			this._state.isStreaming = false;
			(this._state as any).streamingMessage = undefined;
			this._state.pendingToolCalls = new Set<string>();
			this.activeRun?.resolve();
			this.activeRun = undefined;
		}
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}
		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				// Drain any queued steering messages as new prompts
				for (const msg of queuedSteering) {
					await this.prompt(msg);
				}
				return;
			}
			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				// Drain any queued follow-up messages as new prompts
				for (const msg of queuedFollowUps) {
					await this.prompt(msg);
				}
				return;
			}
			throw new Error("Cannot continue from message role: assistant");
		}
		// Continue from user/tool-result message - start a new reactor turn
		await this.prompt([]);
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) return input;
		if (typeof input !== "string") return [input as AgentMessage];
		const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text: input }];
		if (images?.length) content.push(...images);
		return [{ role: "user", content, timestamp: Date.now() } as AgentMessage];
	}

	/**
	 * Reduce internal state from events, then await all listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle after awaited `agent_end` listeners settle.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				(this._state as any).streamingMessage = event.message;
				break;
			case "message_update":
				(this._state as any).streamingMessage = event.message;
				break;
			case "message_end":
				(this._state as any).streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;
			case "tool_execution_start": {
				const pending = new Set(this._state.pendingToolCalls);
				pending.add(event.toolCallId);
				this._state.pendingToolCalls = pending;
				break;
			}
			case "tool_execution_end": {
				const pending = new Set(this._state.pendingToolCalls);
				pending.delete(event.toolCallId);
				this._state.pendingToolCalls = pending;
				break;
			}
			case "turn_end":
				if (event.message.role === "assistant" && (event.message as any).errorMessage) {
					this._state.errorMessage = (event.message as any).errorMessage;
				}
				break;
			case "agent_end":
				(this._state as any).streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}

		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}

	// =========================================================================
	// Reactor-mode execution path
	// =========================================================================

	/**
	 * Run a prompt through the EventSourcedRuntime instead of the legacy loop.
	 *
	 * Translates EventStore events back into the legacy AgentEvent stream so
	 * subscribers (AgentSession, etc.) see the same shape as before.
	 */
	private async runPromptViaReactor(messages: AgentMessage[]): Promise<void> {
		const runtime = await this.ensureRuntime();
		this._runtime = runtime;
		const translator = new EventStoreToAgentEventTranslator();
		this._eventTranslator = translator;

		// activeRun + isStreaming are set by prompt() before calling us.
		const abortController = this.activeRun!.abortController;
		this._runtimeAbortController = abortController;
		this._state.errorMessage = undefined;

		const pendingListenerCalls: Array<Promise<void>> = [];

		const dispatchToListeners = async (event: AgentEvent) => {
			const signal = abortController.signal;
			for (const l of this.listeners) {
				const maybe = l(event, signal);
				if (maybe instanceof Promise) {
					pendingListenerCalls.push(maybe);
				}
			}
			// Maintain Agent-side state mirrors
			switch (event.type) {
				case "message_start":
					(this._state as any).streamingMessage = event.message;
					break;
				case "message_update":
					(this._state as any).streamingMessage = event.message;
					break;
				case "message_end":
					(this._state as any).streamingMessage = undefined;
					this._state.messages.push(event.message);
					break;
				case "tool_execution_start": {
					const pending = new Set(this._state.pendingToolCalls);
					pending.add(event.toolCallId);
					this._state.pendingToolCalls = pending;
					break;
				}
				case "tool_execution_end": {
					const pending = new Set(this._state.pendingToolCalls);
					pending.delete(event.toolCallId);
					this._state.pendingToolCalls = pending;
					break;
				}
				case "turn_end":
					if (event.message.role === "assistant" && (event.message as any).errorMessage) {
						this._state.errorMessage = (event.message as any).errorMessage;
					}
					break;
			}
		};

		// Subscribe to EventStore and translate events live
		const unsub = runtime.store.subscribe((storeEvent) => {
			const agentEvents = translator.translate(storeEvent);
			for (const ae of agentEvents) {
				void dispatchToListeners(ae);
			}
		});

		// Extract user text and images from messages
		const userMessages = messages.filter((m) => m.role === "user");
		const userText = userMessages
			.map((m) => {
				if (typeof (m as any).content === "string") return (m as any).content;
				return ((m as any).content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
			})
			.join("\n\n");

		// Extract images from user messages
		const images: ImageContent[] = [];
		for (const m of userMessages) {
			const content = (m as any).content;
			if (Array.isArray(content)) {
				for (const c of content) {
					if (c.type === "image") {
						images.push(c as ImageContent);
					}
				}
			}
		}

		// Forward any follow-up messages queued before prompt() was called.
		// These were enqueued in Agent.followUpQueue but the runtime didn't exist yet.
		const preQueuedFollowUps = this.followUpQueue.drain();
		for (const msg of preQueuedFollowUps) {
			runtime.followUp(this._extractText(msg));
		}

		try {
			await runtime.prompt(userText, images.length > 0 ? (images as any) : undefined);
			await Promise.all(pendingListenerCalls);
		} catch (err) {
			this._state.errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			unsub();
			this._runtimeAbortController = undefined;
			this._eventTranslator = undefined;
			this._runtime = undefined;
		}
	}

	/**
	 * Lazily construct an EventSourcedRuntime from this Agent's configuration.
	 * Uses an in-memory SQLite store for now (tied to a tmp DB file unless caller pre-wires).
	 */
	/** Cached in-memory store. Persists across prompts. */
	private _eventStore?: import("../event-store/sqlite-store.js").SqliteEventStore;

	private async ensureRuntime(): Promise<import("../runtime/runtime.js").EventSourcedRuntime> {
		const { EventSourcedRuntime } = await import("../runtime/runtime.js");
		const { SqliteEventStore } = await import("../event-store/sqlite-store.js");

		if (!this._state.model) {
			throw new Error("useEventSourcedRuntime: state.model must be set before prompt()");
		}

		// Lazily create the in-memory store once (persists across prompts).
		if (!this._eventStore) {
			this._eventStore = new SqliteEventStore("in-memory", ":memory:");
		}

		// Build LLM client + tool registry with latest state each prompt so changes
		// to state.tools / streamFn / model take effect.
		const llmClient = buildLlmClientFromStreamFn(this._state.model as any, this.streamFn, {
			getApiKey: this.getApiKey,
			thinkingBudgets: this.thinkingBudgets,
			transport: this.transport,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
		});

		const toolRegistry = buildToolRegistry(this._state.tools as AgentTool<any>[]);
		const toolDefs = buildToolDefinitions(this._state.tools as AgentTool<any>[]);

		// Build runtime adapter with optional beforeToolCall/afterToolCall hooks.
		const { LocalRuntimeAdapter } = await import("../runtime/local-runtime.js");
		const baseAdapter = new LocalRuntimeAdapter({
			workspace_id: this._eventStore.workspace_id,
			cwd: process.cwd(),
			toolRegistry,
		});
		const runtimeAdapter =
			this.beforeToolCall || this.afterToolCall
				? createHookingRuntimeAdapter(baseAdapter, {
						beforeToolCall: this.beforeToolCall as any,
						afterToolCall: this.afterToolCall as any,
					}, () => this._state)
				: baseAdapter;

		return new EventSourcedRuntime({
			cwd: process.cwd(),
			store: this._eventStore,
			toolRegistry,
			runtimeAdapter,
			llmClient,
			systemPrompt: this._state.systemPrompt,
			model: toModelConfig(this._state.model as any, this._state.thinkingLevel),
			tools: toolDefs,
			classifierConfig: { approve_unknown: false },
			retryPolicy: new (await import("../runtime/policies.js")).DefaultRetryPolicy({
				capDelayMs: this.maxRetryDelayMs,
			}),
		});
	}
}
