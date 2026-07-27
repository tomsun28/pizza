/**
 * Built-in extension: agent-browser
 *
 * Registers `agent-browser` (https://github.com/vercel-labs/agent-browser) — a fast
 * native-Rust browser automation CLI — as a first-class capability of Pizza.
 *
 * Design alignment with Pizza:
 * - Pizza exposes a single execution tool (`cli`). `agent-browser` stays a shell
 *   command invoked through `cli`, exactly like `git`/`npm`. This extension does
 *   NOT register a separate tool.
 * - It injects a concise usage skill into the system prompt via `before_agent_start`
 *   so the model knows how to drive the CLI.
 * - It exposes a `/browser` command for install / uninstall / status / disable /
 *   enable, so the lifecycle is user-controllable.
 *
 * Enable/disable state is persisted in `settings.json` under
 * `disabledBuiltinExtensions` (read by the resource loader on session start).
 */

import { getAgentDir, SettingsManager } from "../../index.js";
import { AGENT_BROWSER_SKILL_CONTENT } from "./skill-content.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";

/** Stable id used in `settings.disabledBuiltinExtensions`. */
export const AGENT_BROWSER_EXTENSION_ID = "agent-browser";

/** Result of checking whether `agent-browser` is installed and runnable. */
interface BrowserAvailability {
	installed: boolean;
	version?: string;
}

export async function checkBrowserAvailable(cwd: string): Promise<BrowserAvailability> {
	const { execCommand } = await import("../../core/exec.js");
	try {
		const result = await execCommand("agent-browser", ["--version"], cwd, { timeout: 8000 });
		if (result.code === 0) {
			return { installed: true, version: result.stdout.trim() || undefined };
		}
	} catch {
		// not on PATH or spawn failed
	}
	return { installed: false };
}

/** Run `agent-browser install` (downloads Chrome for Testing). */
export async function runAgentBrowserInstall(cwd: string): Promise<{ ok: boolean; message: string }> {
	const { execCommand } = await import("../../core/exec.js");
	const npmInstall = await execCommand("npm", ["install", "-g", "agent-browser"], cwd, {
		timeout: 180_000,
	});
	if (npmInstall.code !== 0) {
		return {
			ok: false,
			message: `npm install -g agent-browser failed (exit ${npmInstall.code})${
				npmInstall.stderr ? `:\n${npmInstall.stderr.trim()}` : ""
			}`,
		};
	}
	const browserInstall = await execCommand("agent-browser", ["install"], cwd, {
		timeout: 300_000,
	});
	if (browserInstall.code !== 0) {
		return {
			ok: false,
			message: `agent-browser installed, but Chrome download failed (exit ${browserInstall.code})${
				browserInstall.stderr ? `:\n${browserInstall.stderr.trim()}` : ""
			}\nYou can retry with: agent-browser install`,
		};
	}
	return { ok: true, message: "agent-browser installed and Chrome for Testing downloaded." };
}

/** Run `npm uninstall -g agent-browser`. */
export async function runAgentBrowserUninstall(cwd: string): Promise<{ ok: boolean; message: string }> {
	const { execCommand } = await import("../../core/exec.js");
	const result = await execCommand("npm", ["uninstall", "-g", "agent-browser"], cwd, {
		timeout: 120_000,
	});
	if (result.code !== 0) {
		return {
			ok: false,
			message: `npm uninstall -g agent-browser failed (exit ${result.code})${
				result.stderr ? `:\n${result.stderr.trim()}` : ""
			}`,
		};
	}
	return { ok: true, message: "agent-browser CLI uninstalled." };
}

/** Persist enable/disable for this built-in extension in settings.json. */
function persistDisabled(cwd: string, disabled: boolean): void {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(cwd, agentDir);
	settings.setBuiltinExtensionDisabled(AGENT_BROWSER_EXTENSION_ID, disabled);
}
function notify(ctx: ExtensionCommandContext, message: string, type?: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type ?? "info");
	} else {
		// Non-interactive (print/RPC) — echo so the result is visible.
		console.log(message);
	}
}

const USAGE = `Usage:
  /browser install     Install agent-browser CLI + Chrome for Testing
  /browser uninstall   Uninstall the agent-browser CLI
  /browser status      Show install status
  /browser disable     Disable this built-in extension (persists across sessions)
  /browser enable      Re-enable this built-in extension
  /browser help        Show this help`;

export const createAgentBrowserExtension: ExtensionFactory = (pizza: ExtensionAPI) => {
	// Inject the usage skill into the system prompt at the start of every agent turn.
	pizza.on("before_agent_start", (event) => {
		const skill = AGENT_BROWSER_SKILL_CONTENT;
		const sep = event.systemPrompt.endsWith("\n") ? "\n" : "\n\n";
		return { systemPrompt: event.systemPrompt + sep + skill };
	});

	pizza.registerCommand("browser", {
		description: "Manage the built-in agent-browser browser automation CLI.",
		async handler(args, ctx) {
			const subcommand = (args.trim().split(/\s+/)[0] || "help").toLowerCase();
			const cwd = ctx.cwd;

			switch (subcommand) {
				case "install": {
					notify(ctx, "Installing agent-browser…", "info");
					const result = await runAgentBrowserInstall(cwd);
					notify(ctx, result.message, result.ok ? "info" : "error");
					return;
				}
				case "uninstall": {
					notify(ctx, "Uninstalling agent-browser…", "info");
					const result = await runAgentBrowserUninstall(cwd);
					notify(ctx, result.message, result.ok ? "info" : "error");
					if (result.ok) {
						notify(ctx, "Tip: the built-in extension is still registered. Use /browser disable to hide it, or /browser enable to keep it.", "info");
					}
					return;
				}
				case "status": {
					const available = await checkBrowserAvailable(cwd);
					const lines = [
						`Built-in extension: ${AGENT_BROWSER_EXTENSION_ID} (enabled)`,
						`CLI installed: ${available.installed ? "yes" : "no"}${available.version ? ` (${available.version})` : ""}`,
					];
					if (!available.installed) {
						lines.push("Run /browser install to install it.");
					}
					notify(ctx, lines.join("\n"), "info");
					return;
				}
				case "disable": {
					persistDisabled(cwd, true);
					notify(ctx, "agent-browser built-in extension disabled. Reloading…", "info");
					await ctx.reload();
					return;
				}
				case "enable": {
					persistDisabled(cwd, false);
					notify(ctx, "agent-browser built-in extension enabled. Reloading…", "info");
					await ctx.reload();
					return;
				}
				case "help":
				default: {
					notify(ctx, USAGE, "info");
					return;
				}
			}
		},
	});
};
