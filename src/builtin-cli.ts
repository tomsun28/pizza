/**
 * `pizza builtin` — manage built-in extensions and built-in skills from the CLI.
 *
 * Built-in extensions live inside Pizza and are loaded by the resource loader.
 * They can be toggled from inside a session (e.g. `/browser disable`), but once
 * disabled the in-session command is gone — so this CLI command is the recovery
 * path: list them and enable/disable by id without editing settings.json by hand.
 *
 * Built-in skills are SKILL.md files shipped with Pizza. They are DISABLED by
 * default and must be enabled explicitly here (or via /settings in a session):
 *   pizza builtin enable pizza-self-optimization
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
import { getBuiltinSkillInfos, isBuiltinSkillId } from "./builtin-skills/index.js";

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
			const enabledSkills = settingsManager.getEnabledBuiltinSkills();
			const skills = getBuiltinSkillInfos();

			if (BUILTIN_EXTENSIONS.length === 0 && skills.length === 0) {
				console.log(chalk.dim("No built-in extensions or skills."));
				return true;
			}

			if (BUILTIN_EXTENSIONS.length > 0) {
				console.log(chalk.bold("Built-in extensions:"));
				for (const ext of BUILTIN_EXTENSIONS) {
					const state = disabled.has(ext.id) ? chalk.red("disabled") : chalk.green("enabled");
					console.log(`  ${ext.id.padEnd(20)} ${state}`);
				}
			}

			if (skills.length > 0) {
				if (BUILTIN_EXTENSIONS.length > 0) {
					console.log();
				}
				console.log(chalk.bold("Built-in skills:"));
				console.log(chalk.dim("  (disabled by default — enable with `pizza builtin enable <id>`)"));
				for (const skill of skills) {
					const state = enabledSkills.has(skill.id) ? chalk.green("enabled") : chalk.red("disabled");
					const description = skill.description ? `  ${chalk.dim(skill.description)}` : "";
					console.log(`  ${skill.id.padEnd(20)} ${state}${description}`);
				}
			}
			return true;
		}
		case "enable": {
			if (!id) {
				console.error(chalk.red("Missing id. Usage: pizza builtin enable <id>"));
				process.exitCode = 1;
				return true;
			}
			if (isBuiltinSkillId(id)) {
				settingsManager.setBuiltinSkillEnabled(id, true);
				console.log(chalk.green(`Enabled built-in skill: ${id}`));
				return true;
			}
			if (BUILTIN_EXTENSIONS.some((ext) => ext.id === id)) {
				settingsManager.setBuiltinExtensionDisabled(id, false);
				console.log(chalk.green(`Enabled built-in extension: ${id}`));
				return true;
			}
			console.error(chalk.red(`Unknown built-in id "${id}". Run "pizza builtin list" to see available ids.`));
			process.exitCode = 1;
			return true;
		}
		case "disable": {
			if (!id) {
				console.error(chalk.red("Missing id. Usage: pizza builtin disable <id>"));
				process.exitCode = 1;
				return true;
			}
			if (isBuiltinSkillId(id)) {
				settingsManager.setBuiltinSkillEnabled(id, false);
				console.log(chalk.green(`Disabled built-in skill: ${id}`));
				return true;
			}
			if (BUILTIN_EXTENSIONS.some((ext) => ext.id === id)) {
				settingsManager.setBuiltinExtensionDisabled(id, true);
				console.log(chalk.green(`Disabled built-in extension: ${id}`));
				return true;
			}
			console.error(chalk.red(`Unknown built-in id "${id}". Run "pizza builtin list" to see available ids.`));
			process.exitCode = 1;
			return true;
		}
		default:
			console.log(`Usage:
  pizza builtin list              List built-in extensions and skills and their state
  pizza builtin enable <id>       Enable a built-in extension or skill
  pizza builtin disable <id>      Disable a built-in extension or skill`);
			return true;
	}
}
