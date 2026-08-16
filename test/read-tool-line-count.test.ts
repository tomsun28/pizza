import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pizza-read-line-count-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	const entry = result.content.find((c) => c.type === "text");
	return entry?.text ?? "";
}

describe("read tool line count with trailing newline", () => {
	it("counts logical lines, not the phantom empty string after a final newline", async () => {
		const dir = await createTempDir();
		// "alpha\nbeta\ngamma\n" is 3 lines; the trailing \n must not count as a 4th.
		const filePath = join(dir, "trailing.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const definition = createReadToolDefinition(dir);
		const result = await definition.execute(
			"read-trailing",
			{ path: "trailing.txt", limit: 2 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		// With limit=2 there is exactly 1 logical line remaining ("gamma"),
		// and continuation points at line 3 — not a phantom line 4.
		expect(text(result)).toContain("1 more lines in file. Use offset=3 to continue.");
		expect(text(result)).not.toMatch(/2 more lines/);
	});

	it("does not suggest a continuation offset past the last real line", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "trailing.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const definition = createReadToolDefinition(dir);
		// limit=3 consumes every real line; there should be no continuation notice.
		const result = await definition.execute(
			"read-trailing-full",
			{ path: "trailing.txt", limit: 3 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(text(result)).not.toMatch(/more lines in file/);
	});

	it("rejects an offset that lands on the phantom trailing empty line", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "trailing.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const definition = createReadToolDefinition(dir);
		// The file has 3 lines. offset=4 used to silently read an empty phantom line.
		await expect(
			definition.execute("read-oob", { path: "trailing.txt", offset: 4 }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow(/beyond end of file \(3 lines total\)/);
	});

	it("reports the real line count in the out-of-bounds message", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "trailing.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const definition = createReadToolDefinition(dir);
		await expect(
			definition.execute("read-oob2", { path: "trailing.txt", offset: 99 }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow(/3 lines total/);
	});

	it("still reads a file with no trailing newline correctly (no regression)", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "notrail.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma", "utf8");

		const definition = createReadToolDefinition(dir);
		const result = await definition.execute(
			"read-notrail",
			{ path: "notrail.txt", limit: 2 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		// 3 real lines, limit=2 → 1 more line.
		expect(text(result)).toContain("1 more lines in file. Use offset=3 to continue.");
	});
});