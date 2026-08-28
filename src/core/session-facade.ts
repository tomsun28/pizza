/**
 * SessionFacade
 *
 * Lightweight event-sourced session entry point for modes and extensions.
 * It owns no transcript state; conversation data is read from EventStore
 * projections through EventSourcedRuntime.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { EventBase, ImageContent, FileAttachment } from "./event-store/types.js";
import type { SubscribeOptions } from "./event-store/store.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionProjection } from "./projection/session-projection.js";
import type { SettingsManager } from "./settings-manager.js";
import { isPersistableThinkingLevel } from "./settings-manager.js";
import type { ModelConfig, ToolDefinition } from "./runtime/llm-types.js";
import type { RuntimeCompactOptions } from "./runtime/runtime.js";
import { EventSourcedRuntime } from "./runtime/runtime.js";

export interface SessionFacadeConfig {
	runtime: EventSourcedRuntime;
	settingsManager: SettingsManager;
	extensionRunner?: ExtensionRunner;
	modelRegistry?: ModelRegistry;
	resourceLoader?: ResourceLoader;
	disposers?: Array<() => void>;
}

export type SessionFacadeEventListener = (event: EventBase) => void;

/** Render queued content (string or content blocks) as display text. */
function queuedContentToText(content: string | unknown[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
				return (block as { text: string }).text;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}


export class SessionFacade {
	readonly runtime: EventSourcedRuntime;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly modelRegistry: ModelRegistry | undefined;
	readonly resourceLoader: ResourceLoader | undefined;
	private disposers: Array<() => void>;
	private disposed = false;

	constructor(config: SessionFacadeConfig) {
		this.runtime = config.runtime;
		this.settingsManager = config.settingsManager;
		this.extensionRunner = config.extensionRunner;
		this.modelRegistry = config.modelRegistry;
		this.resourceLoader = config.resourceLoader;
		this.disposers = config.disposers ?? [];
	}

	subscribe(listener: SessionFacadeEventListener, options?: SubscribeOptions): () => void {
		return this.runtime.subscribe(listener, options);
	}

	prompt(text: string, images?: ImageContent[], files?: FileAttachment[]): Promise<void> {
		return this.runtime.prompt(text, images, files);
	}

	steer(text: string, images?: ImageContent[], files?: FileAttachment[]): void {
		this.runtime.steer(text, images, files);
	}

	followUp(text: string, images?: ImageContent[], files?: FileAttachment[]): void {
		this.runtime.followUp(text, images, files);
	}

	/** Queued steer/follow-up texts (for pending-message display). Empty when idle. */
	getQueuedMessages(): { steering: string[]; followUp: string[] } {
		const entries = this.runtime.pendingFollowUps;
		return {
			steering: entries.filter((e) => e.kind === "steer").map((e) => queuedContentToText(e.content)),
			followUp: entries.filter((e) => e.kind === "followUp").map((e) => queuedContentToText(e.content)),
		};
	}

	/** Clear the runtime's pending queue; returns the cleared texts by kind. */
	clearQueuedMessages(): { steering: string[]; followUp: string[] } {
		const cleared = this.runtime.clearQueuedFollowUps();
		return {
			steering: cleared.steering.map((e) => queuedContentToText(e.content)),
			followUp: cleared.followUp.map((e) => queuedContentToText(e.content)),
		};
	}

	abort(): void {
		this.runtime.abort();
	}

	compact(options?: RuntimeCompactOptions): void {
		this.runtime.compact(options);
	}

	waitForIdle(): Promise<void> {
		return this.runtime.waitForIdle();
	}

	get isRunning(): boolean {
		return this.runtime.isRunning;
	}

	get signal(): AbortSignal | undefined {
		return this.runtime.signal;
	}

	getProjection(): SessionProjection {
		return this.runtime.getProjection();
	}

	get model(): ModelConfig {
		return this.runtime.getModel();
	}

	set model(model: ModelConfig) {
		this.setModel(model);
	}

	setModel(model: ModelConfig | Model<any>, thinkingLevel?: string): void {
		const modelId = "model_id" in model ? model.model_id : model.id;
		this.runtime.setModel(model.provider, modelId);
		this.persistModel(model.provider, modelId);

		const nextThinkingLevel = thinkingLevel ?? ("thinking_level" in model ? model.thinking_level : undefined);
		if (nextThinkingLevel !== undefined) {
			this.runtime.setThinkingLevel(nextThinkingLevel);
			this.persistThinkingLevel(nextThinkingLevel);
		}
	}

	get thinkingLevel(): string | undefined {
		return this.runtime.getThinkingLevel();
	}

	set thinkingLevel(level: string | undefined) {
		if (level !== undefined) {
			this.runtime.setThinkingLevel(level);
			this.persistThinkingLevel(level);
		}
	}

	/**
	 * Persist the user's model choice as the global default so the next sidecar
	 * launch picks it up. Best-effort: a settings-write error is warned but never
	 * thrown, because the in-memory state has already been updated by
	 * `runtime.setModel` above and we don't want to break the current turn over
	 * a disk-side failure.
	 */
	private persistModel(provider: string, modelId: string): void {
		try {
			this.settingsManager.setDefaultModelAndProvider(provider, modelId);
		} catch (e) {
			console.warn(
				`[pizza] failed to persist model preference (${provider}/${modelId}): ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
		}
	}

	/**
	 * Persist the user's thinking-level choice as the global default. Same
	 * best-effort semantics as {@link persistModel}. The `as never` cast avoids
	 * pulling the ThinkingLevel union into this file just for the setter type.
	 */
	private persistThinkingLevel(level: string): void {
		try {
			this.settingsManager.setDefaultThinkingLevel(level as never);
		} catch (e) {
			console.warn(
				`[pizza] failed to persist thinking-level preference (${level}): ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
		}
	}

	get tools(): ToolDefinition[] {
		return this.runtime.getTools();
	}

	set tools(tools: ToolDefinition[]) {
		this.runtime.setTools(tools);
	}

	get systemPrompt(): string {
		return this.runtime.getSystemPrompt();
	}

	set systemPrompt(prompt: string) {
		this.runtime.setSystemPrompt(prompt);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const dispose of this.disposers.splice(0)) {
			dispose();
		}
		this.runtime.dispose();
	}
}