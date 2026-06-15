/**
 * Minimal SDK Usage
 *
 * Uses all defaults: discovers skills, extensions, tools, context files
 * from cwd and ~/.pizza/agent. Model chosen from settings or first available.
 */

import { createSessionFacade } from "pizza";

const { facade } = await createSessionFacade();

facade.subscribe((event) => {
	if (event.type === "AGENT_MESSAGE_CHUNK" && event.payload.content_block.type === "text_delta") {
		process.stdout.write(event.payload.content_block.text);
	}
});

await facade.prompt("What files are in the current directory?");
await facade.waitForIdle();
const messages = facade.getProjection().buildContext();
messages.forEach((msg) => {
	console.log(msg);
});
console.log();
