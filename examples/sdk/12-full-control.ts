/**
 * Full Control
 *
 * Replace everything - no discovery, explicit configuration.
 */

import { getModel } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	createExtensionRuntime,
	createSessionFacade,
	ModelRegistry,
	type ResourceLoader,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

// Custom auth storage location
const authStorage = AuthStorage.create("/tmp/my-agent/auth.json");

// Runtime API key override (not persisted)
if (process.env.MY_ANTHROPIC_KEY) {
	authStorage.setRuntimeApiKey("anthropic", process.env.MY_ANTHROPIC_KEY);
}

// Model registry with no custom models.json
const modelRegistry = ModelRegistry.inMemory(authStorage);

const model = getModel("anthropic", "claude-sonnet-4-20250514");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

const cwd = process.cwd();

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => `You are a minimal assistant.
Available: read, bash. Be concise.`,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
};

const { facade } = await createSessionFacade({
	cwd,
	agentDir: "/tmp/my-agent",
	model,
	thinkingLevel: "off",
	authStorage,
	modelRegistry,
	resourceLoader,
	tools: ["read", "bash"],
	storagePath: ":memory:",
	settingsManager,
});

facade.subscribe((event) => {
	if (event.type === "AGENT_MESSAGE_CHUNK") {
		const cb = event.payload?.content_block;
		if (cb?.type === "text_delta") process.stdout.write(cb.text);
	}
});

await facade.prompt("List files in the current directory.");
await facade.waitForIdle();
console.log();

facade.dispose();
