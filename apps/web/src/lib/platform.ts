/**
 * Platform detection helpers — zero-dependency so they can be imported
 * from test-transitive paths (transport.ts → file-attachment.ts) without
 * pulling in clsx/tailwind-merge, which are web-only and not installed
 * in the root package.json that CI uses for `npm test`.
 */

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * True on macOS (and iOS WebViews). Used to decide whether to reserve
 * space for the macOS traffic-light window controls — the Tauri window
 * uses titleBarStyle "Overlay", which only exists on macOS; Windows/Linux
 * render a normal title bar, so no padding is needed there.
 */
export function isMac(): boolean {
	if (typeof navigator === "undefined") return false;
	const p = navigator.platform ?? "";
	const ua = navigator.userAgent ?? "";
	return /Mac|iPhone|iPad|iPod/.test(p) || /Macintosh/.test(ua);
}

/** True when the UI must reserve space for macOS overlay window controls. */
export function hasMacTrafficLights(): boolean {
	return isTauri() && isMac();
}
