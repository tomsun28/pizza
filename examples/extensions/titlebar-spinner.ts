/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   pizza --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pizza";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(pizza: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = pizza.getSessionName();
	return session ? `Pizza - ${session} - ${cwd}` : `Pizza - ${cwd}`;
}

export default function (pizza: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(pizza));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = pizza.getSessionName();
			const title = session ? `${frame} Pizza - ${session} - ${cwd}` : `${frame} Pizza - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	pizza.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	pizza.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	pizza.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
