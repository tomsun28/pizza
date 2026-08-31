/**
 * SessionFacade factory.
 *
 * Builds a fully wired, pure event-sourced session: EventStore (SQLite) +
 * projection SessionManager + EventSourcedRuntime, wrapped in a SessionFacade.
 *
 * This is the primary session creation API. Modes and extensions subscribe
 * directly to EventStore TypedEvents through the facade.
 */

import { join } from "node:path";
import {
	type CacheRetention,
	createAssistantMessageEventStream,
	type Model,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { APP_NAME, getAgentDir, getDocsPath, getMainMemoryDir, getMainSoulPath } from "../config.js";
import { acquireWorkspaceLock, getMainAgentGuidelines, isSoulUninitialized } from "./main-agent.js";
import type { AgentMessage, AgentTool, ThinkingLevel } from "./agent/index.js";
import { AuthStorage } from "./auth-storage.js";
import { estimateContextTokens } from "./compaction/index.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import {
	EventStoreExtensionSessionManager,
	ExtensionRunner,
	type ContextUsage,
	type LoadExtensionsResult,
	type SessionStartEvent,
	type ToolDefinition as ExtensionToolDefinition,
	type ToolInfo,
} from "./extensions/index.js";
import type { EventBase, ImageContent } from "./event-store/types.js";
import type { EventAppendInput } from "./event-store/store.js";
import { SqliteEventStore } from "./event-store/sqlite-store.js";
import { deriveWorkspaceId, ensureWorkspaceMeta, getEventDatabasePath, getWorkspaceDir } from "./event-store/workspace.js";
import { createToolRegistry } from "./intent/tool-adapter.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import { SessionManager as ProjectionSessionManager } from "./projection/session-manager.js";
import { DefaultResourceLoader, type ResourceLoader } from "./resource-loader.js";
import type { LLMClient, ToolDefinition as RuntimeToolDefinition } from "./runtime/llm-types.js";
import { buildLlmClientFromStreamFn, toModelConfig } from "./runtime/ai-client.js";
import { recoverDanglingTurnState } from "./runtime/crash-recovery.js";
import { DefaultRetryPolicy } from "./runtime/policies.js";
import { EventSourcedRuntime } from "./runtime/runtime.js";
import { SessionFacade } from "./session-facade.js";
import { isPersistableThinkingLevel, SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { allToolNames, createToolDefinition, DEFAULT_LLM_TOOLS, type ToolName } from "./tools/index.js";
import type { BashToolOptions } from "./tools/bash.js";
import type { SchedulerEngine } from "./scheduler/engine.js";
import { createHistoryTreeToolDefinition } from "./tools/history-tree.js";
import { buildSessionBreadcrumb } from "./projection/history-tree.js";
import { createSessionSplitToolDefinition } from "./tools/session-split.js";
import { createTellToolDefinition } from "./tools/tell.js";
import { wrapToolDefinitions } from "./tools/tool-definition-wrapper.js";

export interface CreateSessionFacadeOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pizza/agent */
	agentDir?: string;

	/** Auth storage for credentials. */
	authStorage?: AuthStorage;
	/** Model registry. */
	modelRegistry?: ModelRegistry;
	/** Settings manager. */
	settingsManager?: SettingsManager;
	/** Resource loader (skills/context/extensions/system prompt). */
	resourceLoader?: ResourceLoader;

	/** Model to use. Default: resolved from settings/registry. */
	model?: Model<any>;
	/** Thinking level. Default: from settings, clamped to model capabilities. */
	thinkingLevel?: ThinkingLevel;

	/**
	 * Allowlist of tool names to expose to the LLM.
	 * Default: DEFAULT_LLM_TOOLS (["cli"]) plus custom/extension tools.
	 */
	tools?: string[];
	/** Custom tools to register (in addition to built-in and extension tools). */
	customTools?: ExtensionToolDefinition[];
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;

	/** Override SQLite event database path (e.g. ":memory:" for tests). */
	storagePath?: string;
	/** Override workspace id when opening a session from another workspace. */
	workspaceId?: string;
	/** Existing projection session id to activate before prompting. */
	sessionId?: string;
	/** Existing projection session to fork into the target workspace before prompting. */
	forkFrom?: {
		workspaceId: string;
		sessionId: string;
		agentDir?: string;
	};
	/** Whether this is a continuation of an existing session (affects model selection). */
	isContinuing?: boolean;
	/** Context token budget. Default: model.contextWindow ?? 128000. */
	contextBudget?: number;

	/**
	 * Default safe-mode when settings.json does not set one. "auto" (default)
	 * gates writes/edits/unknown via per-category approvals; false restores
	 * unconditional auto-run. Modes without an approval UI (print) pass false
	 * so one-shot automation is not blocked.
	 */
	safeModeDefault?: boolean | "auto";
	/**
	 * Whether a UI capable of resolving approvals is attached (TUI dialog,
	 * desktop GUI via rpc approve). When false (headless: gateway sub-agents),
	 * NO waiting approval handler is installed — the reactor then fails closed,
	 * auto-rejecting gated tool calls with a guidance error instead of hanging
	 * forever on an approval nobody can answer. Default: true.
	 */
	approvalUi?: boolean;

	/** Whether this session is the persistent (main) agent. */
	isMainAgent?: boolean;
	/** Main agent working directory (defaults to cwd when isMainAgent). */
	mainDir?: string;
	/** Main agent memory directory (defaults to <mainDir>/memory). */
	memoryDir?: string;
}

export interface CreateSessionFacadeResult {
	/** The created facade. */
	facade: SessionFacade;
	/** The underlying runtime (escape hatch for advanced wiring). */
	runtime: EventSourcedRuntime;
	/** Resolved model. */
	model: Model<any> | undefined;
	/** Resolved thinking level. */
	thinkingLevel: ThinkingLevel;
	/** Extensions result (for UI context setup in interactive mode). */
	extensionsResult: LoadExtensionsResult;
	/** Warning if no model could be resolved. */
	modelFallbackMessage?: string;
	/**
	 * Inject the SchedulerEngine after creation (rpc mode builds the engine
	 * once the facade exists, since dispatching needs facade.prompt()). This
	 * is what powers the agent-facing `_cron` built-in cli command.
	 */
	setSchedulerEngine?: (engine: SchedulerEngine | undefined) => void;
	/**
	 * Build and inject an LLM client after creation. Used when the facade was
	 * created without a model (first-run setup mode) and a real model is later
	 * configured via reload_providers — the runtime's llmClient starts as null
	 * and needs to be replaced before the first prompt or the reactor crashes.
	 * Returns true if a client was built and injected (i.e. a model is now
	 * available); false if there is still no model.
	 */
	setLlmClient?: () => boolean;
}

function isBuiltInToolName(name: string): name is ToolName {
	return allToolNames.has(name as ToolName);
}

function toRuntimeToolDefinition(definition: ExtensionToolDefinition): RuntimeToolDefinition {
	return {
		name: definition.name,
		description: definition.description ?? "",
		input_schema: definition.parameters as unknown as Record<string, unknown>,
	};
}

function splitUserContent(
	content: string | Array<{ type: string; [key: string]: unknown }>,
): { text: string; images?: ImageContent[] } {
	if (typeof content === "string") {
		return { text: content };
	}

	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		} else if (part.type === "image") {
			images.push(part as unknown as ImageContent);
		}
	}

	return {
		text: textParts.join("\n"),
		images: images.length > 0 ? images : undefined,
	};
}

function estimateContextUsage(model: Model<any> | undefined, messages: AgentMessage[]): ContextUsage | undefined {
	if (!model) return undefined;
	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	const estimate = estimateContextTokens(messages);
	return {
		tokens: estimate.tokens,
		contextWindow,
		percent: (estimate.tokens / contextWindow) * 100,
	};
}

function cloneContextEventForFork(event: EventBase): EventAppendInput {
	return {
		actor_id: event.actor_id,
		type: event.type,
		payload: event.payload,
		timestamp: event.timestamp,
		schema_version: event.schema_version,
	};
}

function prepareForkedSession(options: {
	store: SqliteEventStore;
	sessionManager: ProjectionSessionManager;
	agentDir: string;
	source: NonNullable<CreateSessionFacadeOptions["forkFrom"]>;
}): void {
	const { store, sessionManager, agentDir, source } = options;
	if (source.workspaceId === store.workspace_id) {
		sessionManager.forkFromSession(source.sessionId);
		return;
	}

	const sourceAgentDir = source.agentDir ?? agentDir;
	const sourceStore = new SqliteEventStore(
		source.workspaceId,
		getEventDatabasePath(source.workspaceId, sourceAgentDir),
		"session_fork_source",
	);
	const sourceSessionManager = new ProjectionSessionManager(
		sourceStore,
		sourceStore,
	);
	try {
		const sourceProjection = sourceSessionManager.getSessionProjection(source.sessionId);
		if (!sourceProjection) {
			throw new Error(`Session not found: ${source.sessionId}`);
		}

		const sourceDescriptor = sourceProjection.getDescriptor();
		const forkAtEventId =
			sourceDescriptor.event_range.end_event_id === "HEAD"
				? sourceStore.head ?? sourceDescriptor.event_range.start_event_id
				: sourceDescriptor.event_range.end_event_id;
		const forked = sessionManager.createSession("fork", sourceDescriptor.name, {
			parentSessionId: source.sessionId,
		});
		store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: source.sessionId,
				fork_at_event_id: forkAtEventId,
			},
			thread_id: forked.thread_id,
		});
		store.appendBatch(sourceProjection.buildContext().events.map(cloneContextEventForFork));
	} finally {
		sourceSessionManager.dispose();
		sourceStore.close();
	}
}

/**
 * Detect the provider error that says budget-based thinking is unsupported
 * and adaptive thinking (thinking.type "adaptive" + output_config.effort)
 * must be used instead. Newer Claude models behind relays emit this while
 * arbitrary model ids may not be in pi-ai's built-in adaptive-thinking index,
 * so we learn it from the provider itself instead of matching model names.
 */
function isAdaptiveThinkingRejection(event: unknown): boolean {
	if ((event as { type?: string })?.type !== "error") return false;
	const message =
		(event as { error?: { errorMessage?: unknown } })?.error?.errorMessage ??
		(event as { errorMessage?: unknown })?.errorMessage;
	if (typeof message !== "string") return false;
	return message.includes("thinking.type.enabled") && message.includes("is not supported");
}

/**
 * Wrap a stream call with a one-shot adaptive-thinking fallback.
 *
 * When the provider rejects budget-based thinking for a model that isn't
 * flagged `compat.forceAdaptiveThinking`, retry once with the flag enabled and
 * remember the decision in the registry so subsequent requests go straight to
 * adaptive. No model id is hardcoded: any current or future model that answers
 * with this error is handled, and models that accept budget thinking (or that
 * were explicitly configured) are untouched.
 */
export function streamWithAdaptiveThinkingFallback(
	model: Model<any>,
	registry: { rememberAdaptiveThinking(model: Model<any>): Model<any> },
	call: (model: Model<any>) => ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
	// Already adaptive (explicit config or learned earlier): nothing to fall back from.
	if ((model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true) {
		return call(model);
	}

	const out = createAssistantMessageEventStream();
	void (async () => {
		let iterator = call(model)[Symbol.asyncIterator]();
		let retried = false;
		try {
			while (true) {
				const { value: event, done } = await iterator.next();
				if (done || !event) return;
				if (!retried && isAdaptiveThinkingRejection(event)) {
					retried = true;
					const patched = registry.rememberAdaptiveThinking(model);
					iterator = call(patched)[Symbol.asyncIterator]();
					continue; // drop the error event and stream the retry instead
				}
				out.push(event);
				if (event.type === "done" || event.type === "error") return;
			}
		} catch (error) {
			out.push({ type: "error", error } as any);
		}
	})();
	return out;
}

/**
 * Create a pure event-sourced SessionFacade.
 */
export async function createSessionFacade(
	options: CreateSessionFacadeOptions = {},
): Promise<CreateSessionFacadeResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const isMainAgent = options.isMainAgent ?? false;
	const mainDir = options.mainDir ?? cwd;
	const memoryDir = options.memoryDir ?? (isMainAgent ? getMainMemoryDir(mainDir) : undefined);

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);

	let resourceLoader = options.resourceLoader;
	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			isMainAgent,
			mainDir: isMainAgent ? mainDir : undefined,
			memoryDir,
		});
		await resourceLoader.reload();
	}

	// ── Resolve model + thinking level ─────────────────────────────────────
	let model = options.model;
	let modelFallbackMessage: string | undefined;

	if (!model) {
		const resolved = await findInitialModel({
			scopedModels: [],
			isContinuing: options.isContinuing ?? false,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = resolved.model;
		if (!model) {
			modelFallbackMessage = `No models available. Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}. Then use /model to select a model.`;
		}
	}

	let thinkingLevel: ThinkingLevel =
		options.thinkingLevel ?? settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	if (!model || !model.reasoning) {
		thinkingLevel = "off";
	}

	// ── EventStore + projection SessionManager ─────────────────────────────
	const workspaceId = options.workspaceId ?? deriveWorkspaceId(cwd);
	if (options.storagePath !== ":memory:") {
		ensureWorkspaceMeta(workspaceId, cwd, options.agentDir);
	}
	// Best-effort workspace lock: if another Pizza process is already driving
	// this workspace, we log a warning but still proceed — the lock is advisory,
	// not a hard gate. This allows the CLI and the desktop gateway to coexist
	// on the same workspace without blocking each other.
	let workspaceLock = null;
	if (!isMainAgent && options.storagePath !== ":memory:" && agentDir) {
		workspaceLock = acquireWorkspaceLock(getWorkspaceDir(workspaceId, agentDir));
		if (!workspaceLock) {
			console.warn(`Warning: workspace ${workspaceId} (cwd ${cwd}) is already in use by another Pizza process. Proceeding anyway.`);
		}
	}
	const store = new SqliteEventStore(
		workspaceId,
		options.storagePath ?? getEventDatabasePath(workspaceId, options.agentDir),
	);
	// Compensate turn state left dangling by a crashed previous process
	// (unclosed TOOL_EXECUTION_START, tool_calls with no result, missing
	// AGENT_TURN_COMPLETED). Only safe when we are the sole workspace driver:
	// with a concurrent live process an in-flight tool is indistinguishable
	// from a crashed one.
	if (workspaceLock || isMainAgent || options.storagePath === ":memory:") {
		try {
			const recovered = recoverDanglingTurnState(store);
			if (recovered.compensated_tool_call_ids.length > 0) {
				console.warn(
					`Recovered ${recovered.compensated_tool_call_ids.length} tool call(s) interrupted by a previous crash.`,
				);
			}
		} catch (error) {
			console.warn(`Crash recovery scan failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const sessionManager = new ProjectionSessionManager(
		store,
		store,
	);
	if (options.forkFrom) {
		prepareForkedSession({ store, sessionManager, agentDir, source: options.forkFrom });
	} else if (options.sessionId) {
		sessionManager.switchTo(options.sessionId);
	}

	// ── Extensions + tools ─────────────────────────────────────────────────
	const projection = sessionManager.getActiveSession();
	const extensionSessionManager = new EventStoreExtensionSessionManager({
		store,
		projection,
		cwd,
		sessionManager,
	});
	const extensionsResult = resourceLoader.getExtensions();
	const extensionRunner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		cwd,
		extensionSessionManager,
		modelRegistry,
	);

	const requestedToolNames = options.tools ?? [...DEFAULT_LLM_TOOLS];
	const allowedToolNames = options.tools ? new Set(options.tools) : undefined;
	const shellCommandPrefix = settingsManager.getShellCommandPrefix();
	const shellPath = settingsManager.getShellPath();
	const autoResizeImages = settingsManager.getImageAutoResize();
	const cliToolOptions: BashToolOptions = { commandPrefix: shellCommandPrefix, shellPath, read: { autoResizeImages } };
	// The `tell` built-in command (agent-to-agent messaging via the gateway) is
	// wired into the cli tool for both the main agent and workspace agents — it
	// needs the agent dir to ensure/start the gateway and discover workspaces.
	if (agentDir) {
		cliToolOptions.tell = { agentDir, mainDir };
	}
	// The `skill` built-in command is wired into the cli tool whenever skills
	// are available — it lets the LLM discover and load skills on demand via
	// `_skill list` / `_skill load` / `_skill read` instead of having the full
	// skills list injected into the system prompt.
	// Registered when the session knows about any skill, including ones the user
	// has disabled — otherwise re-enabling a skill mid-session would have no
	// command to run until the next restart.
	const knownSkillCount = resourceLoader.getSkillCatalog
		? resourceLoader.getSkillCatalog().filter((entry) => entry.enabled || entry.builtinId === undefined).length
		: resourceLoader.getSkills().skills.length;
	if (knownSkillCount > 0) {
		cliToolOptions.skill = { getSkills: () => resourceLoader.getSkills().skills };
	}
	// The `cron` built-in command (scheduled prompts) is wired into the cli
	// tool with a LAZY engine getter. The SchedulerEngine is created later
	// (in rpc mode, after this facade exists — it needs facade.prompt() to
	// dispatch turns), so we hand out a mutable slot that rpc mode fills via
	// the `setSchedulerEngine` escape hatch on the result. Until then
	// getEngine() returns undefined and `_cron` degrades gracefully.
	let schedulerEngineSlot: SchedulerEngine | undefined;
	const cronScope: "main" | "workspace" = isMainAgent ? "main" : "workspace";
	cliToolOptions.cron = {
		getEngine: () => schedulerEngineSlot,
		scope: cronScope,
		getActiveSessionId: () => sessionManager.getActiveSessionId(),
	};
	const toolOptions = {
		read: { autoResizeImages },
		cli: cliToolOptions,
	};

	let runtime: EventSourcedRuntime | undefined;
	// Live model getter: reads the runtime's current model config + registry so
	// that model switches (via /model, RPC set_model, or extensions) are reflected
	// in both LLM API calls and ctx.model for tools. Falls back to the closure
	// `model` if the registry lookup fails (e.g. the model was removed).
	const getModelLive = (): Model<any> | undefined => {
		const cfg = runtime?.getModel();
		if (cfg) {
			const resolved = modelRegistry.find(cfg.provider, cfg.model_id);
			if (resolved) return resolved;
		}
		return model;
	};
	let activeToolDefinitions: ExtensionToolDefinition[] = [];
	let availableToolDefinitions: ExtensionToolDefinition[] = [];
	let availableToolSources = new Map<string, ToolInfo["sourceInfo"]>();
	let systemPrompt = "";

	const includeTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);
	const buildAvailableTools = (): void => {
		const definitions = new Map<string, ExtensionToolDefinition>();
		const sources = new Map<string, ToolInfo["sourceInfo"]>();

		for (const name of requestedToolNames) {
			if (!isBuiltInToolName(name) || !includeTool(name)) continue;
			const definition = createToolDefinition(name, cwd, toolOptions);
			definitions.set(definition.name, definition);
			sources.set(definition.name, createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }));
		}

		for (const tool of extensionRunner.getAllRegisteredTools()) {
			if (!includeTool(tool.definition.name)) continue;
			definitions.set(tool.definition.name, tool.definition);
			sources.set(tool.definition.name, tool.sourceInfo);
		}

		for (const definition of options.customTools ?? []) {
			if (!includeTool(definition.name)) continue;
			definitions.set(definition.name, definition);
			sources.set(definition.name, createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }));
		}
		availableToolDefinitions = Array.from(definitions.values());
		availableToolSources = sources;
	};

	const buildPromptForTools = (definitions: ExtensionToolDefinition[]): string => {
		const appendSystemPrompt = resourceLoader.getAppendSystemPrompt();
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const definition of definitions) {
			const snippet = definition.promptSnippet?.trim();
			if (snippet) {
				toolSnippets[definition.name] = snippet;
			}
			for (const guideline of definition.promptGuidelines ?? []) {
				const normalized = guideline.trim();
				if (normalized) {
					promptGuidelines.push(normalized);
				}
			}
		}

		// read/write/edit/session_split/history_tree/tell are built-in
		// cli commands routed internally by the cli tool, not separate tools; ensure
		// their prompt guidelines are included whenever the cli tool is active, so the
		// model sees how to use each built-in under the single cli tool.
		if (definitions.some((definition) => definition.name === "cli" || definition.name === "bash")) {
			// Only promptGuidelines is consumed below; type loosely to avoid
			// renderCall contravariance between the concrete tool definitions.
			const builtinDefs: Array<{ promptGuidelines?: string[] }> = [
				createToolDefinition("read", cwd, toolOptions),
				createToolDefinition("write", cwd, toolOptions),
				createToolDefinition("edit", cwd, toolOptions),
				createSessionSplitToolDefinition(),
				createHistoryTreeToolDefinition(),
			];
			if (agentDir) {
				builtinDefs.push(createTellToolDefinition({ agentDir, mainDir }));
			}
			for (const builtinDef of builtinDefs) {
				for (const guideline of builtinDef.promptGuidelines ?? []) {
					const normalized = guideline.trim();
					if (normalized) {
						promptGuidelines.push(normalized);
					}
				}
			}
		}

		// Main-agent identity + long-term memory index + guidelines.
		const soulFile = isMainAgent ? resourceLoader.getSoulFile?.() : undefined;
		const longTermMemory = isMainAgent ? resourceLoader.getLongTermMemory?.() : undefined;
		let mainAgentBanner: string | undefined;
		if (isMainAgent && memoryDir) {
			const soulPath = mainDir ? getMainSoulPath(mainDir) : undefined;
			const soulUninitialized = soulFile && soulPath
				? isSoulUninitialized(soulFile.content, APP_NAME)
				: false;
			if (soulUninitialized && soulPath) {
				mainAgentBanner = `IMPORTANT — ACTION REQUIRED BEFORE ANSWERING:\nYour soul file (${soulPath}) is a placeholder. Your identity, values, and voice are all marked [NOT YET DEFINED]. Before you answer the user's question, you MUST first ask them to define who you are: what name should you go by, what role should you play, what tone should you use, what values should you hold? Tell the user they can describe it in conversation (and you will write it to the soul file) or edit the file directly. This is mandatory — do not skip it. After the user has defined your soul, never repeat this request.`;
			}
			for (const guideline of getMainAgentGuidelines(memoryDir, { soulPath, soulUninitialized })) {
				promptGuidelines.push(guideline);
			}
		}

		let prompt = buildSystemPrompt({
			cwd,
			skills: resourceLoader.getSkills().skills,
			contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
			customPrompt: resourceLoader.getSystemPrompt(),
			appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt.join("\n\n") : undefined,
			selectedTools: definitions.map((definition) => definition.name),
			toolSnippets,
			promptGuidelines,
			soulFile,
			longTermMemory,
			mainAgentBanner,
		});

		// Append session-position breadcrumb (~15-40 tokens) so the model
		// always knows where it is in the branch tree without calling
		// history_tree list every turn.
		const breadcrumb = buildSessionBreadcrumb(
			sessionManager.listSessions(),
			sessionManager.getActiveSessionId(),
		);
		if (breadcrumb) {
			prompt += `\n${breadcrumb}`;
		}

		return prompt;
	};

	const applyActiveTools = (toolNames?: string[]): void => {
		buildAvailableTools();
		const activeNames = toolNames ? new Set(toolNames) : undefined;
		activeToolDefinitions = activeNames
			? availableToolDefinitions.filter((definition) => activeNames.has(definition.name))
			: [...availableToolDefinitions];
		systemPrompt = buildPromptForTools(activeToolDefinitions);

		if (runtime) {
			runtime.setTools(activeToolDefinitions.map(toRuntimeToolDefinition));
			runtime.setSystemPrompt(systemPrompt);
		}
	};

	/**
	 * Rebuild the system prompt with the current session-position breadcrumb.
	 * Called by the reactor on session boundary events (split/fork/jump) so
	 * the breadcrumb stays in sync without a full tool rebuild.
	 */
	const refreshSystemPromptWithBreadcrumb = (): string => {
		if (isMainAgent) {
			resourceLoader.refreshMainAgentResources?.();
		}
		systemPrompt = buildPromptForTools(activeToolDefinitions);
		if (runtime) {
			runtime.setSystemPrompt(systemPrompt);
		}
		return systemPrompt;
	};

	const getToolInfos = (): ToolInfo[] =>
		availableToolDefinitions.map((definition) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo:
				availableToolSources.get(definition.name) ??
				createSyntheticSourceInfo(`<tool:${definition.name}>`, { source: "unknown" }),
		}));

	const currentSessionId = (): string => sessionManager.getActiveSessionId() ?? projection.getDescriptor().session_id;
	const currentThreadId = (): string => sessionManager.getActiveThreadId() ?? projection.getDescriptor().thread_id;
	const appendSessionEntry = (entry: { type: string; [key: string]: unknown }): void => {
		store.append({
			actor_id: "runtime",
			type: "SESSION_ENTRY_APPENDED",
			payload: {
				session_id: currentSessionId(),
				entry: {
					id: `entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					parentId: store.head ?? null,
					timestamp: new Date().toISOString(),
					...entry,
				},
				leaf_id: store.head ?? null,
			},
			thread_id: currentThreadId(),
		});
	};

	applyActiveTools();

	extensionRunner.bindCore(
		{
			sendMessage: (message, options) => {
			store.append({
				actor_id: "runtime",
				type: "CUSTOM_MESSAGE",
				payload: {
					extension_id: "sdk",
					kind: message.customType,
					data: message.details ?? message.content,
					display: message.display,
				},
				thread_id: currentThreadId(),
			});

				if (!runtime || (!options?.triggerTurn && !options?.deliverAs)) return;
				const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
				if (options?.deliverAs === "steer") {
					runtime.steer(text);
				} else if (options?.deliverAs === "followUp") {
					runtime.followUp(text);
				} else if (options?.triggerTurn) {
					void runtime.prompt(text).catch((err) => {
						extensionRunner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			},
			sendUserMessage: (content, options) => {
				if (!runtime) return;
				const { text, images } = splitUserContent(content as Parameters<typeof splitUserContent>[0]);
				if (runtime.isRunning) {
					if (options?.deliverAs === "steer") {
						runtime.steer(text, images);
					} else {
						runtime.followUp(text, images);
					}
					return;
				}
				void runtime.prompt(text, images).catch((err) => {
					extensionRunner.emitError({
						extensionPath: "<runtime>",
						event: "send_user_message",
						error: err instanceof Error ? err.message : String(err),
					});
				});
			},
			appendEntry: (customType, data) => appendSessionEntry({ type: "custom", customType, data }),
			setSessionName: (name) => {
				sessionManager.renameSession(currentSessionId(), name);
				appendSessionEntry({ type: "session_info", name });
			},
			getSessionName: () => extensionSessionManager.getSessionName(),
			setLabel: (entryId, label) => appendSessionEntry({ type: "label", targetId: entryId, label }),
			getActiveTools: () => activeToolDefinitions.map((definition) => definition.name),
			getAllTools: getToolInfos,
			setActiveTools: (toolNames) => applyActiveTools(toolNames),
			refreshTools: () => applyActiveTools(activeToolDefinitions.map((definition) => definition.name)),
			getCommands: () =>
				extensionRunner.getRegisteredCommands().map((command) => ({
					name: command.invocationName,
					description: command.description,
					source: "extension",
					sourceInfo: command.sourceInfo,
				})),
			setModel: async (nextModel) => {
				if (!modelRegistry.hasConfiguredAuth(nextModel)) return false;
				model = nextModel;
				runtime?.setModel(nextModel.provider, nextModel.id);
				// Persist as global default so the next sidecar launch picks it
				// up. Best-effort: a settings-write failure must not break the
				// in-progress turn (in-memory state is already updated above).
				try {
					settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
				} catch (e) {
					console.warn(
						`[pizza] failed to persist model preference (${nextModel.provider}/${nextModel.id}): ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				return true;
			},
			getThinkingLevel: () => thinkingLevel,
			setThinkingLevel: (level) => {
				thinkingLevel = level;
				runtime?.setThinkingLevel(level);
				// Same best-effort persistence as setModel above. Levels that
				// settings.json can't represent (e.g. pi-ai's "max") are skipped.
				if (isPersistableThinkingLevel(level)) {
					try {
						settingsManager.setDefaultThinkingLevel(level);
					} catch (e) {
						console.warn(
							`[pizza] failed to persist thinking-level preference (${level}): ${e instanceof Error ? e.message : String(e)}`,
						);
					}
				}
			},
		},
		{
			getModel: getModelLive,
			isIdle: () => !runtime?.isRunning,
			getSignal: () => runtime?.signal,
			abort: () => runtime?.abort(),
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => estimateContextUsage(model, runtime?.getProjection().buildContext().messages ?? []),
			compact: (options) => {
				runtime?.compact({ reason: "manual" });
				void options;
			},
			getSystemPrompt: () => runtime?.getSystemPrompt() ?? systemPrompt,
		},
		{
			registerProvider: (name, config) => modelRegistry.registerProvider(name, config),
			unregisterProvider: (name) => modelRegistry.unregisterProvider(name),
		},
	);

	const tools: AgentTool[] = wrapToolDefinitions(
		availableToolDefinitions,
		() => extensionRunner.createContext(),
	);

	// ── LLM client (AI stream function -> reactor LLMClient) ───────────────
	// Built as a function so it can be (re)created when a model becomes
	// available after startup (first-run setup: the sidecar boots with no API
	// key → no model → llmClient is null; reload_providers later resolves a
	// real model and calls setLlmClient to inject a freshly-built client).
	const buildLlmClient = (): LLMClient =>
		buildLlmClientFromStreamFn(getModelLive, async (m, context, opts) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(m);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			// Prompt cache retention: per-model/provider models.json config wins,
			// then the global setting. Left undefined when nothing is configured
			// so pi-ai applies its own default ("short"). "none" suppresses
			// cache_control for relays that reject cached requests.
			const streamOptions = {
				...opts,
				apiKey: auth.apiKey,
				headers: auth.headers ?? opts?.headers,
				...((): { cacheRetention?: CacheRetention } => {
					const retention = modelRegistry.getCacheRetention(m) ?? settingsManager.getCacheRetention();
					return retention ? { cacheRetention: retention } : {};
				})(),
			};
			// OAuth providers may carry a per-credential baseUrl (e.g. GitHub Copilot)
			return streamWithAdaptiveThinkingFallback(m, modelRegistry, patched =>
				streamSimple(auth.baseUrl ? { ...patched, baseUrl: auth.baseUrl } : patched, context, streamOptions),
			);
		}, {
			thinkingBudgets: settingsManager.getThinkingBudgets(),
			transport: settingsManager.getTransport(),
			// Read the live thinking level from the runtime, which is the single
			// source of truth. Both `/thinking` (facade.thinkingLevel setter) and
			// the extensions setThinkingLevel() API end up calling
			// runtime.setThinkingLevel(), so this captures every update path.
			getThinkingLevel: () => runtime?.getThinkingLevel(),
			onPayload: async (payload: unknown) => {
				if (!extensionRunner.hasHandlers("before_provider_request")) {
					return payload;
				}
				return extensionRunner.emitBeforeProviderRequest(payload);
			},
			onResponse: async (response: { status: number; headers: Record<string, string> }) => {
				if (!extensionRunner.hasHandlers("after_provider_response")) {
					return;
				}
				await extensionRunner.emit({
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
				});
			},
		});
	const llmClient = model ? buildLlmClient() : undefined;

	const approvalSettings = settingsManager.getApprovalSettings();
	// ── Runtime ────────────────────────────────────────────────────────────
	runtime = new EventSourcedRuntime({
		cwd,
		agentDir,
		store,
		sessionManager,
		threadId: currentThreadId,
		toolRegistry: createToolRegistry(tools),
		llmClient: llmClient as NonNullable<typeof llmClient>,
		systemPrompt,
		model: toModelConfig(model ?? ({ provider: "none", id: "none" } as Model<any>), thinkingLevel),
		tools: activeToolDefinitions.map(toRuntimeToolDefinition),
		// Safe mode is the master toggle for tool approval. Unset defaults to
		// "auto" (per-category gates below decide; getSafeModeSettingWithDefault
		// returns undefined for auto). Explicit true gates every risky call;
		// explicit false auto-runs everything. Print mode passes
		// safeModeDefault: false — a one-shot user-invoked command must not
		// block on approvals it has no UI to answer.
		classifierConfig: {
			safe_mode: settingsManager.getSafeModeSettingWithDefault(options.safeModeDefault ?? "auto"),
			require_approval_writes: approvalSettings.writes,
			require_approval_edits: approvalSettings.edits,
			require_approval_shell_moderate: approvalSettings.shellModerate,
			require_approval_unknown: approvalSettings.unknown,
		},
		// The facade has no built-in approval dialog; the UI (TUI / web / desktop)
		// discovers pending approvals via the INTENT_TOOL_CALL event and resolves
		// them through runtime.approve()/reject(). This no-op handler keeps the
		// reactor waiting so safe mode can be toggled live. Headless callers
		// (approvalUi: false — gateway sub-agents) get NO handler: the reactor
		// then auto-rejects gated calls with a guidance error (fail closed)
		// instead of waiting forever on an approval nobody can answer.
		approvalHandler:
			options.approvalUi === false
				? undefined
				: {
						requestApproval: () => {},
						cancelApproval: () => {},
					},
		retryAssistantErrorCompletions: true,
		retryPolicy: new DefaultRetryPolicy({ capDelayMs: settingsManager.getRetrySettings().maxDelayMs }),
		contextBudget: options.contextBudget ?? model?.contextWindow ?? 128000,
		refreshSystemPrompt: refreshSystemPromptWithBreadcrumb,
	});

	const extensionEventUnsubscribe = extensionRunner.bindEventStore(store);
	await extensionRunner.emit(options.sessionStartEvent ?? { type: "session_start", reason: "startup" });

	const facade = new SessionFacade({
		runtime,
		settingsManager,
		modelRegistry,
		extensionRunner,
		resourceLoader,
		disposers: workspaceLock ? [extensionEventUnsubscribe, workspaceLock.release] : [extensionEventUnsubscribe],
	});

	return {
		facade,
		runtime,
		model,
		thinkingLevel,
		extensionsResult,
		modelFallbackMessage,
		/** Let rpc mode inject the SchedulerEngine once it is created. */
		setSchedulerEngine: (engine: SchedulerEngine | undefined) => {
			schedulerEngineSlot = engine;
		},
		/** Build + inject an LLM client once a model becomes available. */
		setLlmClient: () => {
			const liveModel = getModelLive();
			if (!liveModel) return false;
			runtime?.setLlmClient(buildLlmClient());
			return true;
		},
	};
}
