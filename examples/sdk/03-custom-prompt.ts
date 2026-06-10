/**
 * Custom System Prompt
 *
 * Shows how to replace or modify the default system prompt.
 */

import { createSessionFacade, DefaultResourceLoader, getAgentDir } from "@mariozechner/pi-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();

// Option 1: Replace prompt entirely
const loader1 = new DefaultResourceLoader({
	cwd,
	agentDir,
	systemPromptOverride: () => `You are a helpful assistant that speaks like a pirate.
Always end responses with "Arrr!"`,
	// Needed to avoid DefaultResourceLoader appending APPEND_SYSTEM.md from ~/.pizza/agent or <cwd>/.pi.
	appendSystemPromptOverride: () => [],
});
await loader1.reload();

const { facade: facade1 } = await createSessionFacade({
	resourceLoader: loader1,
	storagePath: ":memory:",
});

facade1.subscribe((event) => {
	if (event.type === "AGENT_MESSAGE_CHUNK") {
		const cb = event.payload?.content_block;
		if (cb?.type === "text_delta") process.stdout.write(cb.text);
	}
});

console.log("=== Replace prompt ===");
await facade1.prompt("What is 2 + 2?");
console.log("\n");

// Option 2: Append instructions to the default prompt
const loader2 = new DefaultResourceLoader({
	cwd,
	agentDir,
	appendSystemPromptOverride: (base) => [
		...base,
		"## Additional Instructions\n- Always be concise\n- Use bullet points when listing things",
	],
});
await loader2.reload();

const { facade: facade2 } = await createSessionFacade({
	resourceLoader: loader2,
	storagePath: ":memory:",
});

facade2.subscribe((event) => {
	if (event.type === "AGENT_MESSAGE_CHUNK") {
		const cb = event.payload?.content_block;
		if (cb?.type === "text_delta") process.stdout.write(cb.text);
	}
});

console.log("=== Modify prompt ===");
await facade2.prompt("List 3 benefits of TypeScript.");
console.log();
