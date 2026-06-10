/**
 * Settings Configuration
 *
 * Override settings using SettingsManager.
 */

import { createSessionFacade, SettingsManager } from "@mariozechner/pi-coding-agent";

const cwd = process.cwd();

// Load current settings (merged global + project)
const settingsManagerFromDisk = SettingsManager.create(cwd);
console.log("Current settings:", JSON.stringify(settingsManagerFromDisk.getGlobalSettings(), null, 2));

// Override specific settings
const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

{
	const { facade } = await createSessionFacade({
		settingsManager,
		storagePath: ":memory:",
	});
	console.log("Session created with custom settings");
	facade.dispose();
}

// Setters update memory immediately and queue persistence writes.
// Call flush() when you need a durability boundary.
settingsManager.setDefaultThinkingLevel("low");
await settingsManager.flush();

// Surface settings I/O errors at the app layer.
const settingsErrors = settingsManager.drainErrors();
if (settingsErrors.length > 0) {
	for (const { scope, error } of settingsErrors) {
		console.warn(`Warning (${scope} settings): ${error.message}`);
	}
}

// For testing without file I/O:
const inMemorySettings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

{
	const { facade } = await createSessionFacade({
		settingsManager: inMemorySettings,
		storagePath: ":memory:",
	});
	console.log("Test session created with in-memory settings");
	facade.dispose();
}
