/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: TypedEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentMessage } from "../../src/core/agent/types.js";
import { computeMessageStats, type SessionStats } from "../../src/core/session-stats.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../src/core/extensions/index.js";
import type { EventBase, EventType, ImageContent as EventImageContent } from "../../src/core/event-store/types.js";
import { takeOverStdout, writeRawStdout } from "../../src/core/output-guard.js";
import type { SessionFacade } from "../../src/core/session-facade.js";
import { makeSessionRef, parseSessionRef } from "../../src/core/session-ref.js";
import { executeBashWithOperations } from "../../src/core/bash-executor.js";
import { createLocalBashOperations } from "../../src/core/tools/bash.js";
import { exportFromFile } from "../../src/core/export-html/index.js";
import { buildHistoryTreeNodes } from "../../src/core/projection/history-tree.js";
import { killTrackedDetachedChildren } from "../../src/utils/shell.js";
import { startPtyServer, type PtyServer } from "../pty/pty-server.js";
import { type Theme, theme } from "../../packages/tui/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

function toEventImages(images?: unknown[]): EventImageContent[] | undefined {
	if (!images) return undefined;
	return images.map((image) => {
		const img = image as ImageContent & { mime_type?: string };
		return {
			type: "image",
			data: img.data,
			mime_type: img.mime_type ?? img.mimeType,
		};
	});
}

function getLastAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return null;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => {
			return typeof block === "object" && block !== null && "type" in block;
		})
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function getFacadeSessionEvents(facade: SessionFacade, types?: EventType[]): EventBase[] {
	const descriptor = facade.getProjection().getDescriptor();
	return facade.runtime.store.query({
		after: descriptor.event_range.start_event_id === "ORIGIN" ? undefined : descriptor.event_range.start_event_id,
		before: descriptor.event_range.end_event_id === "HEAD" ? undefined : descriptor.event_range.end_event_id,
		types,
	});
}

function getFacadeForkMessages(facade: SessionFacade): Array<{ entryId: string; text: string }> {
	return getFacadeSessionEvents(facade, ["USER_MESSAGE"])
		.map((event) => {
			const payload = event.payload as { content?: unknown };
			return { entryId: event.event_id, text: extractMessageText(payload.content) };
		})
		.filter((message) => message.text.length > 0);
}

function getFacadeLeafEventId(facade: SessionFacade): string | undefined {
	const context = facade.getProjection().buildContext();
	return context.events.at(-1)?.event_id;
}

function getFacadeSessionStats(facade: SessionFacade): SessionStats {
	const projection = facade.getProjection();
	const descriptor = projection.getDescriptor();
	const messages = projection.buildContext().messages;
	return {
		...computeMessageStats(messages),
		sessionFile: makeSessionRef(descriptor.workspace_id, descriptor.session_id),
		sessionId: descriptor.session_id,
	};
}

/** One-line preview of a message for history_tree view / diff. */
function formatMessagePreview(message: AgentMessage): string | undefined {
	const role = (message as { role?: string }).role ?? "message";
	const content = (message as { content?: unknown }).content;
	const text = extractMessageText(content).replace(/\s+/g, " ").trim();
	if (!text) {
		// Surface tool calls even when there's no text.
		const toolCalls = Array.isArray(content)
			? content.filter((b) => (b as { type?: string }).type === "toolCall").length
			: 0;
		if (toolCalls > 0) return `${role}: [${toolCalls} tool call${toolCalls === 1 ? "" : "s"}]`;
		return undefined;
	}
	const truncated = text.length > 140 ? `${text.slice(0, 140)}…` : text;
	return `${role}: ${truncated}`;
}

function resolveSessionId(facade: SessionFacade, ref: string): string {
	const parsed = parseSessionRef(ref);
	if (parsed.workspaceId && parsed.workspaceId !== facade.runtime.store.workspace_id) {
		throw new Error(`Session belongs to a different workspace: ${parsed.workspaceId}`);
	}
	return parsed.sessionId;
}

function getFacadeSessionState(facade: SessionFacade, ptyPort?: number): RpcSessionState {
	const projection = facade.getProjection();
	const descriptor = projection.getDescriptor();
	const messages = projection.buildContext().messages;
	const resolvedModel = facade.modelRegistry?.find(facade.model.provider, facade.model.model_id);
	const contextWindow = (resolvedModel as { contextWindow?: number } | undefined)?.contextWindow ?? 0;

	// Context usage estimate — uses the last assistant usage when available,
	// falling back to a rough char/4 estimate for trailing messages.
	let contextUsage: RpcSessionState["contextUsage"];
	if (contextWindow > 0) {
		let tokens: number | null = null;
		// Find last assistant usage to get an accurate context token count.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as { role?: string; usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; stopReason?: string };
			if (msg.role === "assistant" && msg.usage && msg.stopReason !== "aborted" && msg.stopReason !== "error") {
				const u = msg.usage;
				tokens = u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				// Add rough estimate for any messages after the last usage.
				for (let j = i + 1; j < messages.length; j++) {
					tokens += estimateMessageTokens(messages[j] as AgentMessage);
				}
				break;
			}
		}
		if (tokens === null) {
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateMessageTokens(message as AgentMessage);
			}
			tokens = estimated;
		}
		contextUsage = {
			tokens,
			contextWindow,
			percent: (tokens / contextWindow) * 100,
		};
	}

	// Cumulative token usage across all assistant messages.
	let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
	for (const msg of messages) {
		const m = msg as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
		if (m.role === "assistant" && m.usage) {
			const u = m.usage;
			totalInput += u.input ?? 0;
			totalOutput += u.output ?? 0;
			totalCacheRead += u.cacheRead ?? 0;
			totalCacheWrite += u.cacheWrite ?? 0;
			totalCost += u.cost?.total ?? 0;
		}
	}
	const tokenUsage = { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost };

	return {
		model: resolvedModel,
		thinkingLevel: (facade.thinkingLevel ?? "off") as RpcSessionState["thinkingLevel"],
		isStreaming: facade.isRunning,
		isCompacting: false,
		sessionFile: makeSessionRef(descriptor.workspace_id, descriptor.session_id),
		sessionId: descriptor.session_id,
		autoCompactionEnabled: facade.settingsManager.getCompactionEnabled(),
		messageCount: messages.length,
		pendingMessageCount: 0,
		safeMode: facade.runtime.isSafeMode,
		ptyPort,
		contextUsage,
		tokenUsage,
	};
}

/** Rough token estimate for a message (chars / 4). Used when no usage data is available. */
function estimateMessageTokens(msg: AgentMessage): number {
	const content = "content" in msg ? (msg as { content?: unknown }).content : undefined;
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((c) => (c as { type?: string }).type === "text").map((c) => (c as { text?: string }).text ?? "").join("")
			: "";
	return Math.ceil(text.length / 4);
}

/**
 * Run RPC mode against the event-sourced facade.
 * Events are emitted as raw EventStore TypedEvent JSON lines.
 */
export async function runRpcModeWithFacade(facade: SessionFacade): Promise<never> {
	takeOverStdout();
	let unsubscribe: (() => void) | undefined;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	let ptyServer: PtyServer | undefined;
	// Start the local PTY-over-WebSocket server for the Terminal pane. We await
	// only the socket bind (fast, never blocks on node-pty, which loads lazily
	// per connection) so `ptyPort` is ready before the first get_state. Any
	// failure is non-fatal — ptyPort stays undefined and the pane degrades.
	try {
		ptyServer = await startPtyServer({ cwd: process.cwd() });
	} catch { /* PTY server unavailable; terminal pane degrades */ }

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};
	const waitForCompactionEnd = (): Promise<{ summary: string; first_kept_event_id: string; tokens_before: number }> => {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error("Compaction timed out"));
			}, 30000);
			const unsub = facade.subscribe((event) => {
				if (event.type === "COMPACTION_END") {
					clearTimeout(timer);
					unsub();
					resolve(event.payload as { summary: string; first_kept_event_id: string; tokens_before: number });
				}
			});
			facade.compact({ reason: "manual" });
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	let detachInput = () => {};

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		await Promise.resolve(facade.dispose());
		await ptyServer?.close().catch(() => {});
		detachInput();
		process.stdin.pause();
		process.exit(exitCode);
	}

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			case "prompt":
				void facade.prompt(command.message, toEventImages(command.images)).catch((e: unknown) => {
					output(error(id, "prompt", e instanceof Error ? e.message : String(e)));
				});
				return success(id, "prompt");

			case "steer":
				facade.steer(command.message, toEventImages(command.images));
				return success(id, "steer");

			case "follow_up":
				facade.followUp(command.message, toEventImages(command.images));
				return success(id, "follow_up");

			case "abort":
				facade.abort();
				return success(id, "abort");

			case "get_state":
				return success(id, "get_state", getFacadeSessionState(facade, ptyServer?.port));

			case "set_model": {
				const models = facade.modelRegistry?.getAvailable() ?? [];
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				facade.setModel(model);
				return success(id, "set_model", model);
			}

			case "get_available_models": {
				// Return ALL models, annotated with hasAuth so the UI can show
				// unconfigured models as disabled rather than hiding them.
				const registry = facade.modelRegistry;
				const all = registry?.getAll() ?? [];
				const models = all.map((m) => ({
					id: m.id,
					name: m.name,
					api: m.api,
					provider: m.provider,
					reasoning: (m as { reasoning?: boolean }).reasoning,
					contextWindow: (m as { contextWindow?: number }).contextWindow,
					hasAuth: registry ? registry.hasConfiguredAuth(m) : true,
				}));
				return success(id, "get_available_models", { models });
			}

			case "cycle_model": {
				const models = facade.modelRegistry?.getAvailable() ?? [];
				if (models.length === 0) {
					return success(id, "cycle_model", null);
				}
				const current = facade.model;
				const currentIndex = models.findIndex(
					(model) => model.provider === current.provider && model.id === current.model_id,
				);
				if (models.length === 1 && currentIndex === 0) {
					return success(id, "cycle_model", null);
				}
				const model = models[(currentIndex + 1) % models.length] ?? models[0]!;
				facade.setModel(model);
				return success(id, "cycle_model", {
					model,
					thinkingLevel: (facade.thinkingLevel ?? "off") as RpcSessionState["thinkingLevel"],
					isScoped: false,
				});
			}

			case "set_thinking_level":
				facade.thinkingLevel = command.level;
				return success(id, "set_thinking_level");

			case "cycle_thinking_level": {
				const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
				const current = facade.thinkingLevel ?? "off";
				const index = levels.findIndex((level) => level === current);
				const level = levels[(index + 1) % levels.length] ?? "off";
				facade.thinkingLevel = level;
				return success(id, "cycle_thinking_level", { level });
			}

			case "compact": {
				const result = await waitForCompactionEnd();
				return success(id, "compact", {
					summary: result.summary,
					firstKeptEntryId: result.first_kept_event_id,
					tokensBefore: result.tokens_before,
				});
			}

			case "get_messages":
				return success(id, "get_messages", { messages: facade.getProjection().buildContext().messages });

			case "get_last_assistant_text":
				return success(id, "get_last_assistant_text", {
					text: getLastAssistantText(facade.getProjection().buildContext().messages),
				});

			case "rewind": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "rewind", "Projection session manager is not available");
				}
				if (command.targetEventId) {
					const event = facade.runtime.store.get(command.targetEventId);
					if (!event) {
						return error(id, "rewind", `Event not found: ${command.targetEventId}`);
					}
					sessionManager.forkAt(command.targetEventId);
				}
				// No target: no-op, eternal conversation auto-continues
				const desc = facade.getProjection().getDescriptor();
				return success(id, "rewind", { cancelled: false, sessionId: desc.session_id });
			}

			case "switch_session": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "switch_session", "Projection session manager is not available");
				}
				sessionManager.switchTo(resolveSessionId(facade, command.sessionPath));
				return success(id, "switch_session", { cancelled: false });
			}

			case "fork": {
				const event = facade.runtime.store.get(command.entryId);
				if (!event) {
					return error(id, "fork", `Event not found: ${command.entryId}`);
				}
				facade.runtime.fork(command.entryId);
				return success(id, "fork", {
					text: event.type === "USER_MESSAGE" ? extractMessageText((event.payload as { content?: unknown }).content) : "",
					cancelled: false,
				});
			}

			case "clone": {
				const leafId = getFacadeLeafEventId(facade);
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				facade.runtime.fork(leafId);
				return success(id, "clone", { cancelled: false });
			}

			case "get_fork_messages":
				return success(id, "get_fork_messages", { messages: getFacadeForkMessages(facade) });

			case "get_session_stats":
				return success(id, "get_session_stats", getFacadeSessionStats(facade));

			case "set_auto_compaction":
				facade.settingsManager.setCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");

			case "get_commands": {
				const commands: RpcSlashCommand[] =
					facade.extensionRunner?.getRegisteredCommands().map((command) => ({
						name: command.invocationName,
						description: command.description,
						source: "extension" as const,
						sourceInfo: command.sourceInfo,
					})) ?? [];
				return success(id, "get_commands", { commands });
			}

			case "history_tree": {
				const sessionManager = facade.runtime.sessionManager;
				if (!sessionManager) {
					return error(id, "history_tree", "Projection session manager is not available");
				}
				const store = facade.runtime.store;
				switch (command.action) {
					case "list": {
						let nodes = buildHistoryTreeNodes(
							sessionManager.listSessions(),
							sessionManager.getActiveSessionId(),
							store,
						);
						if (command.query) {
							const q = command.query.toLowerCase();
							nodes = nodes.filter(
								(n) =>
									n.name?.toLowerCase().includes(q) ||
									n.snippet?.toLowerCase().includes(q) ||
									n.session_id.toLowerCase().includes(q),
							);
						}
						return success(id, "history_tree", { action: "list", nodes });
					}
					case "view": {
						const projection = sessionManager.getSessionProjection(command.sessionId);
						if (!projection) {
							return success(id, "history_tree", { action: "view", view: null });
						}
						const descriptor = projection.getDescriptor();
						const previews = projection
							.buildContext()
							.messages.map((m) => formatMessagePreview(m))
							.filter((line): line is string => line !== undefined);
						const maxMessages = command.maxMessages ?? 40;
						return success(id, "history_tree", {
							action: "view",
							view: {
								session_id: descriptor.session_id,
								name: descriptor.name,
								messages: previews.slice(-maxMessages),
								message_count: previews.length,
							},
						});
					}
					case "jump": {
						const result = sessionManager.jumpToSession(command.sessionId, command.reason);
						return success(id, "history_tree", {
							action: "jump",
							session_id: result.descriptor.session_id,
							reopened: result.reopened,
						});
					}
					case "fork": {
						const desc = sessionManager.forkFromSession(command.sessionId);
						return success(id, "history_tree", { action: "fork", session_id: desc.session_id });
					}
					case "rename": {
						sessionManager.renameSession(command.sessionId, command.name);
						return success(id, "history_tree", { action: "rename", ok: true });
					}
					default: {
						const unknown = command as { action?: string };
						return error(id, "history_tree", `Unknown history_tree action: ${unknown.action}`);
					}
				}
			}

			case "get_events": {
				const store = facade.runtime.store;
				const eventTypes = command.eventTypes as EventType[] | undefined;
				const events = command.sessionScoped
					? getFacadeSessionEvents(facade, eventTypes)
					: store.query({ types: eventTypes });
				const limit = command.limit ?? 1000;
				const sliced = events.length > limit ? events.slice(-limit) : events;
				return success(id, "get_events", {
					events: sliced.map((e) => ({
						event_id: e.event_id,
						type: e.type,
						timestamp: e.timestamp,
						actor_id: e.actor_id,
						caused_by: e.caused_by,
						thread_id: e.thread_id,
						payload: e.payload,
					})),
				});
			}

			case "set_auto_retry":
				return success(id, "set_auto_retry");

			case "abort_retry":
				facade.abort();
				return success(id, "abort_retry");

			case "bash": {
				const operations = createLocalBashOperations();
				const result = await executeBashWithOperations(command.command, process.cwd(), operations);
				return success(id, "bash", result);
			}

			case "abort_bash":
				return success(id, "abort_bash");

			case "export_html": {
				const descriptor = facade.getProjection().getDescriptor();
				const sessionRef = makeSessionRef(descriptor.workspace_id, descriptor.session_id);
				const path = await exportFromFile(sessionRef, command.outputPath);
				return success(id, "export_html", { path });
			}

			case "set_steering_mode":
				return success(id, "set_steering_mode");

			case "set_follow_up_mode":
				return success(id, "set_follow_up_mode");
			case "approve":
				facade.runtime.approve(command.intentEventId);
				return success(id, "approve");

			case "reject":
				facade.runtime.reject(command.intentEventId);
				return success(id, "reject");

			case "set_safe_mode": {
				const enabled = !!command.enabled;
				facade.runtime.setSafeMode(enabled);
				facade.settingsManager.setSafeMode(enabled);
				return success(id, "set_safe_mode", { safeMode: facade.runtime.isSafeMode });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
			}
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
		}
	};

	unsubscribe = facade.subscribe((event) => output(event));
	registerSignalHandlers();

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);
	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	return new Promise(() => {});
}
