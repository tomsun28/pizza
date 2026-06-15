/**
 * API Keys and OAuth
 *
 * Configure API key resolution via AuthStorage and ModelRegistry.
 */

import { AuthStorage, createSessionFacade, ModelRegistry } from "pizza";

// Default: AuthStorage uses ~/.pizza/agent/auth.json
// ModelRegistry loads built-in + custom models from ~/.pizza/agent/models.json
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

{
	const { facade } = await createSessionFacade({
		storagePath: ":memory:",
		authStorage,
		modelRegistry,
	});
	console.log("Session with default auth storage and model registry");
	facade.dispose();
}

// Custom auth storage location
const customAuthStorage = AuthStorage.create("/tmp/my-app/auth.json");
const customModelRegistry = ModelRegistry.create(customAuthStorage, "/tmp/my-app/models.json");

{
	const { facade } = await createSessionFacade({
		storagePath: ":memory:",
		authStorage: customAuthStorage,
		modelRegistry: customModelRegistry,
	});
	console.log("Session with custom auth storage location");
	facade.dispose();
}

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");
{
	const { facade } = await createSessionFacade({
		storagePath: ":memory:",
		authStorage,
		modelRegistry,
	});
	console.log("Session with runtime API key override");
	facade.dispose();
}

// No models.json - only built-in models
const simpleRegistry = ModelRegistry.inMemory(authStorage);
{
	const { facade } = await createSessionFacade({
		storagePath: ":memory:",
		authStorage,
		modelRegistry: simpleRegistry,
	});
	console.log("Session with only built-in models");
	facade.dispose();
}
