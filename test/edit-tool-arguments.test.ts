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

describe("edit tool search mode", () => {
	it("replaces unique text via op=search", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "search.txt");
		await writeFile(filePath, "line one\nconst a = 1\nline three\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"tool-search-1",
			{ path: "search.txt", edits: [{ op: "search", old: "const a = 1", new: "const a = 2" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect((result.content[0] as { type: string; text: string }).text).toContain("Successfully applied 1 edit(s)");
		expect(await readFile(filePath, "utf8")).toBe("line one\nconst a = 2\nline three\n");
	});

	it("replaces multi-line text via op=search", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "multi.txt");
		await writeFile(filePath, "header\nold line 1\nold line 2\nfooter\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"tool-search-2",
			{ path: "multi.txt", edits: [{ op: "search", old: "old line 1\nold line 2", new: "new line 1\nnew line 2" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect((result.content[0] as { type: string; text: string }).text).toContain("Successfully applied 1 edit(s)");
		expect(await readFile(filePath, "utf8")).toBe("header\nnew line 1\nnew line 2\nfooter\n");
	});

	it("fails when search text matches multiple locations", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "ambiguous.txt");
		await writeFile(filePath, "duplicate\nduplicate\n", "utf8");

		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-search-3",
				{ path: "ambiguous.txt", edits: [{ op: "search", old: "duplicate", new: "unique" }] },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("matches multiple locations");

		expect(await readFile(filePath, "utf8")).toBe("duplicate\nduplicate\n");
	});

	it("fails when search text is not found", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "notfound.txt");
		await writeFile(filePath, "hello world\n", "utf8");

		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-search-4",
				{ path: "notfound.txt", edits: [{ op: "search", old: "nonexistent", new: "found" }] },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("not found");

		expect(await readFile(filePath, "utf8")).toBe("hello world\n");
	});

	it("can mix search and anchor edits in one call", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "mixed.txt");
		await writeFile(filePath, "const a = 1\nconst b = 2\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const anchor = formatLineAnchor(1, "const a = 1");
		const result = await definition.execute(
			"tool-search-5",
			{
				path: "mixed.txt",
				edits: [
					{ op: "replace", range: anchor, new: "const a = 10" },
					{ op: "search", old: "const b = 2", new: "const b = 20" },
				],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect((result.content[0] as { type: string; text: string }).text).toContain("Successfully applied 2 edit(s)");
		expect(await readFile(filePath, "utf8")).toBe("const a = 10\nconst b = 20\n");
	});
});
