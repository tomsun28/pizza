/**
 * `pizza builtin` — manage built-in extensions from the CLI.
 *
 * Built-in extensions live inside Pizza and are loaded by the resource loader.
 * They can be toggled from inside a session (e.g. `/browser disable`), but once
 * disabled the in-session command is gone — so this CLI command is the recovery
 * path: list them and enable/disable by id without editing settings.json by hand.
 *
 * Usage:
 *   pizza builtin list
 *   pizza builtin enable <id>
 *   pizza builtin disable <id>
 */
import chalk from "chalk";
import { getAgentDir } from "./config.js";
import { SettingsManager } from "./core/settings-manager.js";
import { BUILTIN_EXTENSIONS } from "./builtin-extensions/index.js";

export async function handleBuiltinCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "builtin") {
		return false;
	}
	const rest = args.filter((a) => !a.startsWith("-"));
	// The first positional is "builtin" (the dispatcher token). The subcommand follows.
	const subcommand = rest[1]?.toLowerCase();
	const id = rest[2];

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);

	switch (subcommand) {
		case "list": {
			const disabled = settingsManager.getDisabledBuiltinExtensions();
			if (BUILTIN_EXTENSIONS.length === 0) {
				console.log(chalk.dim("No built-in extensions."));
				return true;
			}
			for (const ext of BUILTIN_EXTENSIONS) {
				const state = disabled.has(ext.id) ? chalk.red("disabled") : chalk.green("enabled");
				console.log(`  ${ext.id.padEnd(20)} ${state}`);
			}
			return true;
		}
		case "enable": {
			if (!id) {
				console.error(chalk.red("Missing extension id. Usage: pizza builtin enable <id>"));
				process.exitCode = 1;
				return true;
			}
			settingsManager.setBuiltinExtensionDisabled(id, false);
			console.log(chalk.green(`Enabled built-in extension: ${id}`));
			return true;
		}
		case "disable": {
			if (!id) {
				console.error(chalk.red("Missing extension id. Usage: pizza builtin disable <id>"));
				process.exitCode = 1;
				return true;
			}
			settingsManager.setBuiltinExtensionDisabled(id, true);
			console.log(chalk.green(`Disabled built-in extension: ${id}`));
			return true;
		}
		default:
			console.log(`Usage:
  pizza builtin list              List built-in extensions and their state
  pizza builtin enable <id>       Enable a built-in extension
  pizza builtin disable <id>      Disable a built-in extension`);
			return true;
	}
}
