/**
 * Context Files (AGENTS.md)
 *
 * Context files provide project-specific instructions loaded into the system prompt.
 */

import { createSessionFacade, DefaultResourceLoader, getAgentDir } from "pizza";

// Disable context files entirely by returning an empty list in agentsFilesOverride.
const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	agentsFilesOverride: (current) => ({
		agentsFiles: [
			...current.agentsFiles,
			{
				path: "/virtual/AGENTS.md",
				content: `# Project Guidelines

## Code Style
- Use TypeScript strict mode
- No any types
- Prefer const over let`,
			},
		],
	}),
});
await loader.reload();

// Discover AGENTS.md files walking up from cwd
const discovered = loader.getAgentsFiles().agentsFiles;
console.log("Discovered context files:");
for (const file of discovered) {
	console.log(`  - ${file.path} (${file.content.length} chars)`);
}

await createSessionFacade({
	resourceLoader: loader,
	storagePath: ":memory:",
});

console.log(`Session facade created with ${discovered.length + 1} context files`);
