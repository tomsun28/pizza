import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.js";

/** Strip ANSI escape sequences for visible-text checks. */
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Check if a rendered line is a plain border (all ─ characters). */
function isPlainBorder(line: string): boolean {
	const stripped = stripAnsi(line);
	return stripped.length > 2 && /^─+$/.test(stripped);
}

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}

	/**
	 * Override render to add cyber-style corner brackets on border lines.
	 * The parent Editor renders plain ─── lines; we replace the first and
	 * last simple border lines with angular corners (┌┐ / └┘).
	 * Scroll indicators and content lines are passed through unchanged.
	 */
	render(width: number): string[] {
		const lines = super.render(width);
		if (width < 4 || lines.length < 2) return lines;

		// Top border: first line if it's a plain border
		if (isPlainBorder(lines[0]!)) {
			lines[0] = this.borderColor("┌") + this.borderColor("─").repeat(width - 2) + this.borderColor("┐");
		}

		// Bottom border: scan backwards from end for the last plain border
		for (let i = lines.length - 1; i >= 1; i--) {
			if (isPlainBorder(lines[i]!)) {
				lines[i] = this.borderColor("└") + this.borderColor("─").repeat(width - 2) + this.borderColor("┘");
				break;
			}
		}

		return lines;
	}
}
