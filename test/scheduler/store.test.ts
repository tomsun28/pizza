import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scheduler store atomic writes", () => {
	const originalEnv = process.env.PIZZA_HOME;
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pizza-scheduler-store-"));
		process.env.PIZZA_HOME = home;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PIZZA_HOME;
		else process.env.PIZZA_HOME = originalEnv;
		rmSync(home, { recursive: true, force: true });
	});

	it("replaces an existing tasks.json atomically", async () => {
		// Re-import after PIZZA_HOME is set so getSchedulerDir() picks it up.
		const { readTasks, writeTasks } = await import("../../src/core/scheduler/store.js");
		const workspaceId = "ws-1";
		const first = [
			{
				id: "t1",
				name: "first",
				prompt: "p",
				scope: "workspace" as const,
				workspaceId,
				schedule: { mode: "every_n_minutes" as const, everyN: { n: 5, unit: "minute" as const } },
				enabled: true,
				createdAt: 1,
				updatedAt: 1,
				createdBy: "user" as const,
			},
		];
		writeTasks("workspace", workspaceId, first);
		expect(readTasks("workspace", workspaceId)).toHaveLength(1);

		// Writing again must succeed even though tasks.json already exists.
		// On platforms where fs.renameSync fails when the target exists this
		// is the operation the comment in atomicWriteJson calls out.
		const second = [
			...first,
			{
				...first[0]!,
				id: "t2",
				name: "second",
				updatedAt: 2,
			},
		];
		writeTasks("workspace", workspaceId, second);
		const all = readTasks("workspace", workspaceId);
		expect(all).toHaveLength(2);
		expect(all.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
	});
});