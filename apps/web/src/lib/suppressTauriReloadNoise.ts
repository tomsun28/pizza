/**
 * Suppresses a benign, framework-level error that Tauri's injected IPC script
 * throws during a page reload.
 *
 * When the webview reloads while Rust is still emitting events (e.g. `rpc_event`
 * / `rpc_response`) to callback ids that were just torn down, Tauri's internal
 * dispatcher evaluates `listeners[eventId].handlerId` on an already-removed
 * entry and throws. It surfaces as an unhandled promise rejection we cannot
 * attach a `.catch` to, because it originates inside `@tauri-apps/api`'s core
 * message handler rather than our code. It is harmless — the page is reloading.
 *
 * We match on the distinctive `handlerId` signature so real application errors
 * are never hidden.
 */
function isTauriReloadArtifact(reason: unknown): boolean {
	const message =
		reason instanceof Error
			? reason.message
			: typeof reason === "string"
				? reason
				: "";
	return message.includes("listeners[eventId].handlerId") || message.includes("handlerId");
}

export function installTauriReloadNoiseSuppressor(): void {
	if (typeof window === "undefined") return;

	window.addEventListener("unhandledrejection", (event) => {
		if (isTauriReloadArtifact(event.reason)) {
			event.preventDefault();
		}
	});
}
