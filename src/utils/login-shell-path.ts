import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Capture the PATH the user's login shell would set, so processes that inherit
 * a minimal PATH (e.g. GUI/launchd-launched agents that never source
 * ~/.zprofile / ~/.bash_profile / ~/.zshrc) still find tools the user installed
 * via homebrew / cargo / nvm / etc.
 *
 * Direct port of the Rust desktop's `capture_login_shell_path()` /
 * `resolve_shell_path()` in apps/desktop/src/bridge.rs.
 *
 * Runs `<shell> -lic 'printf %s "$PATH"'` with stdin wired to /dev/null and a
 * hard timeout, so a misbehaving rc file can't hang the process. The result is
 * captured once and cached for the lifetime of the process.
 */

const CAPTURE_TIMEOUT_MS = 3000;

/** null = not yet captured; string = captured path; undefined = capture failed. */
let cached: string | null | undefined = null;

function runShellCapturePath(shell: string): string | undefined {
	const result = spawnSync(shell, ["-lic", "printf %s \"$PATH\""], {
		timeout: CAPTURE_TIMEOUT_MS,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Timed out / killed / non-zero exit -> no usable PATH.
	if (result.signal || result.status !== 0) return undefined;
	const path = (result.stdout ?? "").trim();
	return path.length > 0 ? path : undefined;
}

function captureLoginShellPath(): string | undefined {
	// Prefer the user's configured login shell, then common fallbacks.
	const configured = process.env.SHELL;
	const candidates: string[] = [];
	if (configured) candidates.push(configured);
	for (const fallback of ["/bin/zsh", "/bin/bash"]) {
		if (!candidates.includes(fallback)) candidates.push(fallback);
	}

	for (const shell of candidates) {
		try {
			if (!existsSync(shell)) continue;
		} catch {
			continue;
		}
		const path = runShellCapturePath(shell);
		if (path) return path;
	}
	return undefined;
}

/**
 * Resolve the login-shell PATH, captured once and cached for the process.
 * Returns undefined if no shell produced a PATH (caller should then keep the
 * inherited PATH).
 */
export function resolveLoginShellPath(): string | undefined {
	if (cached === null) {
		cached = captureLoginShellPath() ?? undefined;
	}
	return cached ?? undefined;
}