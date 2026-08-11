import { existsSync } from "node:fs";
import { basename, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Capture the PATH the user's login shell would set, so processes that inherit
 * a minimal PATH (e.g. GUI/launchd-launched agents that never source
 * ~/.zprofile / ~/.bash_profile / ~/.zshrc) still find tools the user installed
 * via homebrew / cargo / nvm / etc.
 *
 * Direct port of the Rust desktop's `capture_login_shell_path()` /
 * `resolve_shell_path()` in apps/desktop/src/bridge.rs.
 *
 * Runs `<shell> -lic '<sentinel>$PATH'` with stdin wired to /dev/null and a
 * hard timeout, so a misbehaving rc file can't hang the process. The result is
 * captured once and cached for the lifetime of the process.
 */

const CAPTURE_TIMEOUT_MS = 3000;

/**
 * Marker printed immediately before the PATH. Interactive rc files routinely
 * echo banners, version-manager notices, motd, etc. to stdout; without a
 * sentinel that noise would be spliced into the PATH we hand to every child
 * process. Everything before the last marker is discarded.
 */
const SENTINEL = "__PIZZA_LOGIN_PATH__";

/** Shells whose `"$PATH"` expands to a single delimiter-separated string. */
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash", "mksh"]);

/** null = not yet captured; string = captured path; undefined = capture failed. */
let cached: string | null | undefined = null;

function runShellCapturePath(shell: string): string | undefined {
	const result = spawnSync(shell, ["-lic", `printf '%s%s' '${SENTINEL}' "$PATH"`], {
		timeout: CAPTURE_TIMEOUT_MS,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Timed out / killed / non-zero exit -> no usable PATH.
	if (result.signal || result.status !== 0) return undefined;
	const stdout = result.stdout ?? "";
	const marker = stdout.lastIndexOf(SENTINEL);
	// No marker means the shell never ran our command (or mangled it) — the
	// output is not a PATH, so refuse it rather than poisoning every child.
	if (marker < 0) return undefined;
	const path = stdout.slice(marker + SENTINEL.length).trim();
	return path.length > 0 ? path : undefined;
}

function captureLoginShellPath(): string | undefined {
	// POSIX shells only: on Windows there is no login shell to source and
	// `-lic` is meaningless.
	if (platform() === "win32") return undefined;

	// Prefer the user's configured login shell, then common fallbacks.
	const configured = process.env.SHELL;
	const candidates: string[] = [];
	if (configured) candidates.push(configured);
	for (const fallback of ["/bin/zsh", "/bin/bash"]) {
		if (!candidates.includes(fallback)) candidates.push(fallback);
	}

	for (const shell of candidates) {
		// Only Bourne-family shells: `"$PATH"` in fish/csh is a list that
		// expands space-separated, so the "PATH" we'd read back is garbage.
		if (!POSIX_SHELLS.has(basename(shell))) continue;
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
 * Join PATH-ish values in priority order, dropping empties and duplicates.
 * Earlier entries win, so callers list the environment they trust most first.
 */
export function mergePathValues(...values: Array<string | undefined>): string {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const value of values) {
		for (const dir of (value ?? "").split(delimiter)) {
			if (dir && !seen.has(dir)) {
				seen.add(dir);
				merged.push(dir);
			}
		}
	}
	return merged.join(delimiter);
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
