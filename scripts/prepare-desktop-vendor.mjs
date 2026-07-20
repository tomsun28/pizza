#!/usr/bin/env node
/**
 * Stage only the current platform-arch's vendor binaries (fd/rg) into
 * apps/desktop/vendor-bin/ so tauri bundles just that one instead of all
 * 6 platforms (~46M -> ~7M on macOS arm64).
 *
 * Runtime lookup is `vendor/bin/${process.platform}-${process.arch}/<tool>`
 * (see src/utils/tools-manager.ts), so only that subdirectory is needed.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = path.join(repoRoot, "dist", "vendor", "bin");
const stagingRoot = path.join(repoRoot, "apps", "desktop", "vendor-bin");

const key = `${process.platform}-${process.arch}`;
const srcDir = path.join(srcRoot, key);

if (!existsSync(srcDir)) {
	console.error(`prepare-desktop-vendor: source not found: ${srcDir}`);
	console.error(`  Did you run 'npm run vendor-tools' first?`);
	process.exit(1);
}

// Reset staging dir.
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

// Copy the single platform-arch subdir preserving the layout tauri bundles.
// tauri.conf.json maps: "vendor-bin/": "vendor/bin/"
// so we want stagingRoot/<key>/{fd,rg}.
cpSync(srcDir, path.join(stagingRoot, key), { recursive: true });

console.log(`prepare-desktop-vendor: staged ${key} -> ${path.relative(repoRoot, stagingRoot)}/${key}`);
