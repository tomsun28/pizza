import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.js";
import type { CronToolOptions } from "../src/core/tools/cron.js";
import type { SchedulerEngine } from "../src/core/scheduler/engine.js";
import type { ScheduledTaskSummary } from "../packages/protocol/index.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

/** A minimal stand-in for SchedulerEngine that records calls without touching disk. */
function mockEngine(list: ScheduledTaskSummary[] = []): {
	engine: SchedulerEngine;
	createCalls: any[];
} {
	const createCalls: any[] = [];
	const engine = {
		list: () => list,
		create: (input: any) => {
			createCalls.push(input);
			return {
				ok: true,
				task: {
					id: "st_mock",
					name: input.name,
					scope: "main",
					workspaceId: undefined,
					prompt: input.prompt,
					schedule: input.schedule,
					enabled: true,
					createdAt: 0,
					updatedAt: 0,
					createdBy: "intent",
					runCount: 0,
					nextRunAt: 1000,
				},
			} as any;
		},
		update: () => ({ ok: true, task: list[0] ?? { id: "st_mock", name: "mock" } }) as any,
		delete: () => ({ ok: true, id: "st_mock" }) as any,
		runNow: async () => ({ ok: true, taskId: "st_mock", at: Date.now() }) as any,
	} as unknown as SchedulerEngine;
	return { engine, createCalls };
}

describe("_cron built-in cli command", () => {
	it("is recognized as a built-in and shows help (no longer 'command not found')", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("cron-help", { command: "_cron -h" });
		const output = getTextOutput(result);
		expect(output).toContain("_cron - Manage scheduled/cron jobs");
		expect(output).toContain("Actions:");
		expect(output).toContain("Examples:");
	});

	it("degrades gracefully when no scheduler engine is configured", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("cron-list-no-engine", { command: "_cron list" });
		const output = getTextOutput(result);
		// Not available because the cli tool has no cron option wired.
		expect(output).toContain("not available");
		expect(output).toMatch(/scheduler/i);
	});

	it("routes _cron list through the cli tool to the engine", async () => {
		const { engine } = mockEngine([
			{
				id: "st_abc",
				name: "self-review",
				scope: "main",
				workspaceId: undefined,
				prompt: "review changes",
				schedule: { mode: "every_n_minutes", everyN: { n: 30 } },
				enabled: true,
				createdAt: 0,
				updatedAt: 0,
				createdBy: "intent",
				runCount: 0,
				nextRunAt: 1000,
			} as ScheduledTaskSummary,
		]);
		const cronOptions: CronToolOptions = {
			getEngine: () => engine,
			scope: "main",
			getActiveSessionId: () => "sess_1",
		};
		const tool = createBashTool(process.cwd(), { cron: cronOptions });
		const result = await tool.execute("cron-list", { command: "_cron list" });
		const output = getTextOutput(result);
		expect(output).toContain("st_abc");
		expect(output).toContain("self-review");
		expect(result.details?.builtin?.name).toBe("cron");
	});

	it("routes _cron create to the engine with a parsed schedule", async () => {
		const { engine, createCalls } = mockEngine();
		const cronOptions: CronToolOptions = {
			getEngine: () => engine,
			scope: "main",
			getActiveSessionId: () => "sess_1",
		};
		const tool = createBashTool(process.cwd(), { cron: cronOptions });
		const result = await tool.execute("cron-create", {
			command: '_cron create --schedule 30m --name "self-review" --prompt "review changes"',
		});
		const output = getTextOutput(result);
		expect(output).toContain("Created task");
		expect(createCalls).toHaveLength(1);
		expect(createCalls[0]!.schedule).toMatchObject({ mode: "every_n_minutes" });
		expect(createCalls[0]!.name).toBe("self-review");
		expect(createCalls[0]!.prompt).toBe("review changes");
	});
});
