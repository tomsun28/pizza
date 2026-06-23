import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { formatLineAnchor } from "../src/core/tools/line-anchors.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pizza-edit-arguments-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool arguments", () => {
	it("keeps top-level edit fields out of the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).not.toHaveProperty("range");
		expect(definition.parameters.properties).not.toHaveProperty("new");
	});

	it("passes through valid range edits unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ op: "replace", range: "1#aa", new: "b" }],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toBe(input);
	});

	it("passes through non-object input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("prepared args execute correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "range.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "range.txt",
			edits: [{ op: "replace", range: formatLineAnchor(1, "before"), new: "after" }],
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully applied 1 edit(s) in range.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});

	it("parses edits from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([{ op: "replace", range: "1#aa", new: "b" }]),
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ op: "replace", range: "1#aa", new: "b" }],
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: "not json",
		});
	});
});
