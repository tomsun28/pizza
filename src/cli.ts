#!/usr/bin/env node
/**
 * CLI entry point for the coding agent.
 * Routes read/write/edit built-in commands to builtin-commands.ts.
 * grep, find, ls are not built-in commands — they are passed to the system shell.
 * and passes other commands to main.ts
 */
process.title = "pizza";
process.env.PIZZA_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { executeBuiltinCommand, BUILTIN_COMMANDS } from "./core/tools/builtin-commands.js";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

// Check if this is a built-in command call
const args = process.argv.slice(2);

if (args[0] === "builtin" && args.length >= 2) {
	const command = args[1] as typeof BUILTIN_COMMANDS[number];

	if (!BUILTIN_COMMANDS.includes(command)) {
		console.error(`Unknown builtin command: ${command}`);
		console.error(`Available commands: ${BUILTIN_COMMANDS.join(", ")}`);
		process.exit(1);
	}

	const commandArgs = args.slice(2);
	const cwd = process.cwd();

	executeBuiltinCommand(command, commandArgs, { cwd })
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
			console.error(`Error executing builtin command: ${error.message}`);
			process.exit(1);
		});
} else {
	main(args);
}
