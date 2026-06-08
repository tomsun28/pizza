/**
 * SessionFacade
 *
 * Lightweight event-sourced session entry point for modes and extensions.
 * It owns no transcript state; conversation data is read from EventStore
 * projections through EventSourcedRuntime.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { EventBase, ImageContent } from "./event-store/types.js";
import type { SubscribeOptions } from "./event-store/store.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SessionProjection } from "./projection/session-projection.js";
import type { SettingsManager } from "./settings-manager.js";
import type { ModelConfig, ToolDefinition } from "./runtime/llm-types.js";
import type { RuntimeCompactOptions } from "./runtime/runtime.js";
import { EventSourcedRuntime } from "./runtime/runtime.js";

export interface SessionFacadeConfig {
	runtime: EventSourcedRuntime;
	settingsManager: SettingsManager;
	extensionRunner?: ExtensionRunner;
	modelRegistry?: ModelRegistry;
}

export type SessionFacadeEventListener = (event: EventBase) => void;

export class SessionFacade {
	readonly runtime: EventSourcedRuntime;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly modelRegistry: ModelRegistry | undefined;

	constructor(config: SessionFacadeConfig) {
		this.runtime = config.runtime;
		this.settingsManager = config.settingsManager;
		this.extensionRunner = config.extensionRunner;
		this.modelRegistry = config.modelRegistry;
	}

	subscribe(listener: SessionFacadeEventListener, options?: SubscribeOptions): () => void {
		return this.runtime.subscribe(listener, options);
	}

	prompt(text: string, images?: ImageContent[]): Promise<void> {
		return this.runtime.prompt(text, images);
	}

	steer(text: string, images?: ImageContent[]): void {
		this.runtime.steer(text, images);
	}

	followUp(text: string, images?: ImageContent[]): void {
		this.runtime.followUp(text, images);
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

		const nextThinkingLevel = thinkingLevel ?? ("thinking_level" in model ? model.thinking_level : undefined);
		if (nextThinkingLevel !== undefined) {
			this.runtime.setThinkingLevel(nextThinkingLevel);
		}
	}

	get thinkingLevel(): string | undefined {
		return this.runtime.getThinkingLevel();
	}

	set thinkingLevel(level: string | undefined) {
		if (level !== undefined) {
			this.runtime.setThinkingLevel(level);
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
		this.runtime.dispose();
	}
}
