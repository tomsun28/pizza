/**
 * Private temp-file allocation for tool output logs.
 *
 * Previously bash output overflow logs were written straight into the shared
 * tmpdir() with a predictable "pizza-bash-*" prefix and default (umask)
 * permissions — on multi-user machines that is an information leak (command
 * output often contains file contents and secrets) and a symlink-attack
 * surface (an attacker can pre-create the predictably-named path).
 *
 * All overflow logs now live in a per-process directory created with
 * mkdtemp (0700 on POSIX), and files are opened with mode 0600.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let privateTempDir: string | undefined;

/** Lazily create the per-process private temp dir (mkdtemp → 0700). */
function getPrivateTempDir(): string {
	if (!privateTempDir) {
		privateTempDir = mkdtempSync(join(tmpdir(), "pizza-"));
	}
	return privateTempDir;
}

/** Unpredictable log path inside the private per-process temp dir. */
export function makePrivateLogPath(prefix: string): string {
	return join(getPrivateTempDir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
}

/** File mode for overflow logs — owner read/write only. */
export const PRIVATE_LOG_MODE = 0o600;