#!/usr/bin/env node
/**
 * CLI entry point for the coding agent.
 * Routes native commands (read, write, edit, grep, find, ls) to native-commands.ts
 * and passes other commands to main.ts
 */
process.title = "pi";
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { executeNativeCommand, NATIVE_COMMANDS } from "./native-commands.js";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

// Check if this is a native command call
const args = process.argv.slice(2);

if (args[0] === "native" && args.length >= 2) {
	const command = args[1] as typeof NATIVE_COMMANDS[number];

	if (!NATIVE_COMMANDS.includes(command)) {
		console.error(`Unknown native command: ${command}`);
		console.error(`Available commands: ${NATIVE_COMMANDS.join(", ")}`);
		process.exit(1);
	}

	const commandArgs = args.slice(2);
	const cwd = process.cwd();

	executeNativeCommand(command, commandArgs, { cwd })
		.then((result) => {
			if (result.stdout) {
				console.log(result.stdout);
			}
			if (result.stderr) {
				console.error(result.stderr);
			}
			process.exit(result.exitCode);
		})
		.catch((error) => {
			console.error(`Error executing native command: ${error.message}`);
			process.exit(1);
		});
} else {
	main(args);
}
