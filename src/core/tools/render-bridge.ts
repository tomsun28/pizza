/**
 * Tool render bridge — the seam that inverts core → tui into tui → core.
 *
 * Core tool definitions implement renderCall/renderResult, which need TUI
 * helpers (the active theme, keybinding hints, diff rendering, syntax
 * highlighting, visual truncation). Importing those from packages/tui at
 * module scope made core depend on the TUI package at runtime — blocking
 * headless/server bundles that never render.
 *
 * The bridge holds those helpers behind installable implementations:
 *
 *   - A UI entry (interactive mode / any renderer host) calls
 *     installToolRenderBridge() with the real TUI-backed implementations.
 *   - Headless processes (gateway, rpc, print) never install it and get the
 *     plain fallbacks: no ANSI, no truncation, diffs verbatim — correct for
 *     non-terminal consumers and dependency-free.
 */

import type { Theme } from "../../../packages/tui/theme/theme.js";

export interface ToolRenderBridge {
	/** Currently active theme. */
	theme: Pick<Theme, "fg" | "bg" | "bold">;
	/** Format a keybinding hint (e.g. "to expand (ctrl+x)"). */
	keyHint(keybinding: string, description: string): string;
	/** Truncate text to a maximum number of visual lines. Returns the kept
	 * visual lines and how many earlier lines were skipped. */
	truncateToVisualLines(text: string, maxLines: number, maxWidth: number, paddingX?: number): { visualLines: string[]; skippedCount: number };
	/** Render a unified diff (may colorize when a UI is attached). */
	renderDiff(diffText: string, options?: { filePath?: string }): string;
	/** Syntax-highlight code, returning styled lines (plain when headless). */
	highlightCode(code: string, lang?: string): string[];
	/** Resolve a highlight language from a file path. */
	getLanguageFromPath(filePath: string): string | undefined;
}

/** Plain, ANSI-free fallback used when no UI installed a bridge. */
const plainTheme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const plainHighlight = (code: string): string[] => code.split("\n");

const fallbackBridge: ToolRenderBridge = {
	theme: plainTheme as unknown as ToolRenderBridge["theme"],
	keyHint: (_keybinding, description) => description,
	truncateToVisualLines: (text, maxLines) => {
		const lines = text.split("\n");
		return { visualLines: lines.slice(-maxLines), skippedCount: Math.max(0, lines.length - maxLines) };
	},
	renderDiff: (diffText) => diffText,
	highlightCode: plainHighlight,
	getLanguageFromPath: () => undefined,
};

let installed: ToolRenderBridge | undefined;

/** Install UI-backed render implementations. Called by TUI entry points. */
export function installToolRenderBridge(bridge: ToolRenderBridge): void {
	installed = bridge;
}

/** The active render bridge (plain fallback until a UI installs one). */
export function toolRenderBridge(): ToolRenderBridge {
	return installed ?? fallbackBridge;
}