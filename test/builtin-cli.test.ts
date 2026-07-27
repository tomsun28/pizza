import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleBuiltinCommand } from "../src/builtin-cli.js";

describe("handleBuiltinCommand", () => {
	const testDir = join(process.cwd(), "test-builtin-cli-tmp");
	const agentDir = join(testDir, "agent");
	const cwd = join(testDir, "project");
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		// Force the agent dir to our temp dir.
		process.env.PIZZA_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		delete process.env.PIZZA_CODING_AGENT_DIR;
		process.chdir(originalCwd);
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("returns false for unrelated commands", async () => {
		expect(await handleBuiltinCommand(["print", "hello"])).toBe(false);
	});

	it("lists built-in extensions (enabled by default)", async () => {
		expect(await handleBuiltinCommand(["builtin", "list"])).toBe(true);
	});

	it("disables and re-enables a built-in extension, persisting to settings.json", async () => {
		process.chdir(cwd);
		await handleBuiltinCommand(["builtin", "disable", "agent-browser"]);
		// settings writes are queued; let them flush to disk.
		await new Promise((r) => setTimeout(r, 50));

		const settingsPath = join(agentDir, "settings.json");
		expect(existsSync(settingsPath)).toBe(true);
		let raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(raw.disabledBuiltinExtensions).toContain("agent-browser");

		await handleBuiltinCommand(["builtin", "enable", "agent-browser"]);
		await new Promise((r) => setTimeout(r, 50));
		raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(raw.disabledBuiltinExtensions ?? []).not.toContain("agent-browser");
	});
});
