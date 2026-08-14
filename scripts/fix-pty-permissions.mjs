#!/usr/bin/env node
/**
 * Ensure node-pty's `spawn-helper` binary in node_modules has execute
 * permission. npm does not preserve file modes when extracting tarballs, so
 * the prebuild's spawn-helper often lands with 0644. Without +x, posix_spawnp
 * fails and the Terminal pane can't open a shell.
 *
 * Run after `npm install` or before `dev:desktop` / `build:desktop`.
 */
import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const prebuildsRoot = path.join(repoRoot, "node_modules", "node-pty", "prebuilds");

if (!existsSync(prebuildsRoot)) {
	// node-pty not installed (or uses build/Release instead of prebuilds) — nothing to do.
	process.exit(0);
}

let fixed = 0;
for (const dir of readdirSync(prebuildsRoot)) {
	const helper = path.join(prebuildsRoot, dir, "spawn-helper");
	if (existsSync(helper)) {
		try {
			chmodSync(helper, 0o755);
			fixed++;
		} catch { /* ignore */ }
	}
}
if (fixed > 0) {
	console.log(`fix-pty-permissions: chmod +x spawn-helper in ${fixed} prebuild dir(s)`);
}
