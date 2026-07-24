import { describe, it, expect } from "vitest";
import { parseBuiltinToolInput } from "../src/core/tools/builtin-commands.js";

describe("parseBuiltinToolInput — delegate_agent", () => {
	it("parses `delegate_agent list`", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["list"]);
		expect(result).toEqual({ command: "delegate_agent", input: { action: "list" } });
	});

	it("parses `delegate_agent run <cwd> <task>` positionally", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "/proj", "fix", "the", "bug"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "fix the bug" },
		});
	});

	it("parses `delegate_agent run --cwd <path> --task <text>` flags", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "--cwd", "/proj", "--task", "do something"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "do something" },
		});
	});

	it("parses `delegate_agent run` with --timeout", () => {
		const result = parseBuiltinToolInput("_delegate_agent", [
			"run",
			"--cwd",
			"/proj",
			"--task",
			"go",
			"--timeout",
			"60000",
		]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "go", timeout: 60000 },
		});
	});

	it("uses short flags -d / -t", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "-d", "/proj", "-t", "quick"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "quick" },
		});
	});

	it("flags override positionals for cwd, positional remainder fills task", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "/ignored", "leftover", "--cwd", "/real"]);
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/real", task: "leftover" },
		});
	});

	it("treats heredoc as the task for run", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run", "/proj"], "long\ntask\nbody");
		expect(result).toEqual({
			command: "delegate_agent",
			input: { action: "run", cwd: "/proj", task: "long\ntask\nbody" },
		});
	});

	it("rejects an unknown action", () => {
		expect(() => parseBuiltinToolInput("_delegate_agent", ["explode"])).toThrow(/unknown action/);
	});

	it("requires an action", () => {
		expect(() => parseBuiltinToolInput("_delegate_agent", [])).toThrow(/action required/);
	});

	it("run with no cwd/task yields an action with undefined cwd/task", () => {
		const result = parseBuiltinToolInput("_delegate_agent", ["run"]);
		expect(result).toEqual({ command: "delegate_agent", input: { action: "run" } });
	});
});
