/**
 * Cross-component channel for prefilling the Composer's input from elsewhere in
 * the UI (e.g. the Git tab's read-only branch list offering to "switch in
 * chat"). The Composer and the triggering widget are far apart in the tree
 * (RightDock vs the routed view) with no shared parent state, so a lightweight
 * window CustomEvent avoids prop-drilling through several components.
 *
 * The event is namespaced and carries the target `workspace` so a Composer in
 * one workspace ignores a prefill meant for another.
 */
export const COMPOSER_PREFILL_EVENT = "pizza:composer-prefill";

export interface ComposerPrefillDetail {
	/** Workspace (cwd) the prefill is targeting. */
	workspace: string;
	/** Text to drop into the Composer input. */
	text: string;
}

/** Emit a prefill request from anywhere in the app. */
export function prefillComposer(workspace: string, text: string): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<ComposerPrefillDetail>(COMPOSER_PREFILL_EVENT, {
			detail: { workspace, text },
		}),
	);
}
