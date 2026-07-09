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
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import { getAgentDir, getDocsPath } from "../config.js";
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
import { deriveWorkspaceId, ensureWorkspaceMeta, getEventDatabasePath, getSessionIndexPath } from "./event-store/workspace.js";
import { createToolRegistry } from "./intent/tool-adapter.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import { SessionManager as ProjectionSessionManager } from "./projection/session-manager.js";
import { DefaultResourceLoader, type ResourceLoader } from "./resource-loader.js";
import type { ToolDefinition as RuntimeToolDefinition } from "./runtime/llm-types.js";
import { buildLlmClientFromStreamFn, toModelConfig } from "./runtime/ai-client.js";
import { DefaultRetryPolicy } from "./runtime/policies.js";
import { EventSourcedRuntime } from "./runtime/runtime.js";
import { SessionFacade } from "./session-facade.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { allToolNames, createToolDefinition, DEFAULT_LLM_TOOLS, type ToolName } from "./tools/index.js";
import { createSessionSplitToolDefinition } from "./tools/session-split.js";
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
	/** Override session index path. */
	sessionIndexPath?: string;
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
	/** Context token budget. Default: model.contextWindow ?? 128000. */
	contextBudget?: number;
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
		getSessionIndexPath(source.workspaceId, sourceAgentDir),
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
 * Create a pure event-sourced SessionFacade.
 */
export async function createSessionFacade(
	options: CreateSessionFacadeOptions = {},
): Promise<CreateSessionFacadeResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);

	let resourceLoader = options.resourceLoader;
	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
	}

	// ── Resolve model + thinking level ─────────────────────────────────────
	let model = options.model;
	let modelFallbackMessage: string | undefined;

	if (!model) {
		const resolved = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
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
	if (options.storagePath !== ":memory:" && options.sessionIndexPath !== ":memory:") {
		ensureWorkspaceMeta(workspaceId, cwd, options.agentDir);
	}
	const store = new SqliteEventStore(
		workspaceId,
		options.storagePath ?? getEventDatabasePath(workspaceId, options.agentDir),
	);
	const sessionManager = new ProjectionSessionManager(
		store,
		options.sessionIndexPath ?? getSessionIndexPath(workspaceId, options.agentDir),
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
	const toolOptions = {
		read: { autoResizeImages },
		cli: { commandPrefix: shellCommandPrefix, shellPath, read: { autoResizeImages } },
	};

	let runtime: EventSourcedRuntime | undefined;
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

		// Always include the session_split tool
		const sessionSplitDef = createSessionSplitToolDefinition();
		definitions.set(sessionSplitDef.name, sessionSplitDef as unknown as ExtensionToolDefinition);
		sources.set(sessionSplitDef.name, createSyntheticSourceInfo(`<builtin:${sessionSplitDef.name}>`, { source: "builtin" }));

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

		return buildSystemPrompt({
			cwd,
			skills: resourceLoader.getSkills().skills,
			contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
			customPrompt: resourceLoader.getSystemPrompt(),
			appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt.join("\n\n") : undefined,
			selectedTools: definitions.map((definition) => definition.name),
			toolSnippets,
			promptGuidelines,
		});
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
				return true;
			},
			getThinkingLevel: () => thinkingLevel,
			setThinkingLevel: (level) => {
				thinkingLevel = level;
				runtime?.setThinkingLevel(level);
			},
		},
		{
			getModel: () => model,
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
	const llmClient = model
		? buildLlmClientFromStreamFn(model, async (m, context, opts) => {
				const auth = await modelRegistry.getApiKeyAndHeaders(m);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				return streamSimple(m, context, {
					...opts,
					apiKey: auth.apiKey,
					headers: auth.headers ?? opts?.headers,
				});
			}, {
				thinkingBudgets: settingsManager.getThinkingBudgets(),
				transport: settingsManager.getTransport(),
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
			})
		: undefined;

	// ── Runtime ────────────────────────────────────────────────────────────
	runtime = new EventSourcedRuntime({
		cwd,
		agentDir,
		store,
		sessionManager,
		threadId: currentThreadId(),
		toolRegistry: createToolRegistry(tools),
		llmClient: llmClient as NonNullable<typeof llmClient>,
		systemPrompt,
		model: toModelConfig(model ?? ({ provider: "none", id: "none" } as Model<any>), thinkingLevel),
		tools: activeToolDefinitions.map(toRuntimeToolDefinition),
		// The default facade currently has no approval UI handler, so keep coding tools usable.
		// Direct runtime/classifier consumers get the stricter defaults unless they opt out.
		classifierConfig: {
			require_approval_writes: false,
			require_approval_edits: false,
			require_approval_unknown: false,
		},
		retryAssistantErrorCompletions: true,
		retryPolicy: new DefaultRetryPolicy({ capDelayMs: settingsManager.getRetrySettings().maxDelayMs }),
		contextBudget: options.contextBudget ?? model?.contextWindow ?? 128000,
	});

	const extensionEventUnsubscribe = extensionRunner.bindEventStore(store);
	await extensionRunner.emit(options.sessionStartEvent ?? { type: "session_start", reason: "startup" });

	const facade = new SessionFacade({
		runtime,
		settingsManager,
		modelRegistry,
		extensionRunner,
		resourceLoader,
		disposers: [extensionEventUnsubscribe],
	});

	return { facade, runtime, model, thinkingLevel, extensionsResult, modelFallbackMessage };
}
