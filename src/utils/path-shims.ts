import { accessSync, chmodSync, constants, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getPackageDir, isBunBinary } from "../config.js";
import { COMPAT_COMMANDS } from "../core/tools/compat-commands.js";

const SHIM_ENV_KEY = "PIZZA_SHIM_DIR";

export function injectPizzaPathShims(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = env[pathKey] ?? "";
	const pathWithoutOldShim = removePathEntry(currentPath, env[SHIM_ENV_KEY]);
	const missingCommands = COMPAT_COMMANDS.filter((command) => !commandExistsOnPath(command, pathWithoutOldShim));

	if (missingCommands.length === 0) {
		if (pathWithoutOldShim === currentPath && !env[SHIM_ENV_KEY]) return env;
		const cleanEnv = { ...env, [pathKey]: pathWithoutOldShim };
		delete cleanEnv[SHIM_ENV_KEY];
		return cleanEnv;
	}

	const shimDir = mkdtempSync(join(tmpdir(), "pizza-shims-"));
	for (const command of missingCommands) {
		writeShim(shimDir, command);
	}

	return {
		...env,
		[pathKey]: [shimDir, pathWithoutOldShim].filter(Boolean).join(delimiter),
		[SHIM_ENV_KEY]: shimDir,
	};
}

function removePathEntry(pathValue: string, entry: string | undefined): string {
	if (!entry) return pathValue;
	return pathValue
		.split(delimiter)
		.filter((part) => part && part !== entry)
		.join(delimiter);
}

function commandExistsOnPath(command: string, pathValue: string): boolean {
	const dirs = pathValue.split(delimiter).filter(Boolean);
	const names = executableNames(command);
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				return true;
			} catch {
				// Try the next candidate.
			}
		}
	}
	return false;
}

function executableNames(command: string): string[] {
	if (process.platform !== "win32") return [command];
	const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	const extensions = pathExt.split(";").filter(Boolean);
	return [command, ...extensions.map((ext) => `${command}${ext.toLowerCase()}`), ...extensions.map((ext) => `${command}${ext.toUpperCase()}`)];
}

function writeShim(shimDir: string, command: string): void {
	const shimPath = join(shimDir, command);
	const invocation = getCompatInvocation();
	const script = `#!/bin/sh\nexec ${invocation} ${shellQuote(command)} "$@"\n`;
	writeFileSync(shimPath, script, "utf-8");
	chmodSync(shimPath, 0o755);
}

function getCompatInvocation(): string {
	if (isBunBinary) {
		return `${shellQuote(process.execPath)} __compat`;
	}

	const packageDir = getPackageDir();
	const sourceCli = join(packageDir, "src", "cli.ts");
	const tsxLoader = join(packageDir, "node_modules", "tsx", "dist", "loader.mjs");
	const runningFromSource = import.meta.url.includes("/src/") || import.meta.url.includes("\\src\\");
	if (runningFromSource && existsSync(sourceCli) && existsSync(tsxLoader)) {
		return `${shellQuote(process.execPath)} --import ${shellQuote(tsxLoader)} ${shellQuote(sourceCli)} __compat`;
	}

	const distCli = join(packageDir, "dist", "cli.js");
	if (existsSync(distCli)) {
		return `${shellQuote(process.execPath)} ${shellQuote(distCli)} __compat`;
	}

	if (existsSync(sourceCli) && existsSync(tsxLoader)) {
		return `${shellQuote(process.execPath)} --import ${shellQuote(tsxLoader)} ${shellQuote(sourceCli)} __compat`;
	}

	return `${shellQuote(process.execPath)} ${shellQuote(distCli)} __compat`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
