/**
 * meta.json must be replaced atomically.
 *
 * Every Pizza process that appends a message event touches
 * `<workspace>/meta.json` to refresh `last_accessed_at`, while other processes
 * (e.g. `_tell list` enumerating known workspaces) read it concurrently. A plain
 * writeFileSync truncates in place, so a reader could catch the file mid-write,
 * fail to parse it, and conclude the workspace was corrupt. rename(2) is atomic:
 * readers see either the old contents or the new, never a partial file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "../src/core/event-store/workspace.js";

describe("atomicWriteJson", () => {
	const testDir = join(tmpdir(), `pizza-atomic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const target = join(testDir, "meta.json");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("creates the file with pretty-printed JSON", () => {
		atomicWriteJson(target, { workspace_id: "ws_1", last_accessed_at: 42 });

		const parsed = JSON.parse(readFileSync(target, "utf8"));
		expect(parsed).toEqual({ workspace_id: "ws_1", last_accessed_at: 42 });
		// Pretty-printed, matching the previous writeFileSync formatting.
		expect(readFileSync(target, "utf8")).toContain("\n  ");
	});

	it("replaces existing contents completely (no leftover tail)", () => {
		// A long previous value: an in-place truncating write that failed midway
		// could leave trailing bytes from the old document.
		writeFileSync(target, JSON.stringify({ padding: "x".repeat(5000) }, null, 2));
		atomicWriteJson(target, { small: true });

		const raw = readFileSync(target, "utf8");
		expect(JSON.parse(raw)).toEqual({ small: true });
		expect(raw).not.toContain("padding");
	});

	it("leaves no temp files behind", () => {
		for (let i = 0; i < 5; i++) {
			atomicWriteJson(target, { i });
		}
		expect(readdirSync(testDir)).toEqual(["meta.json"]);
	});

	it("always leaves a parseable file across many rewrites", () => {
		// Stand-in for concurrent writers: after every write the file must be
		// complete and valid, never half-written.
		for (let i = 0; i < 50; i++) {
			atomicWriteJson(target, { last_accessed_at: i, blob: "y".repeat(i * 40) });
			const parsed = JSON.parse(readFileSync(target, "utf8"));
			expect(parsed.last_accessed_at).toBe(i);
		}
	});

	it("throws and cleans up its temp file when the target dir is gone", () => {
		const missing = join(testDir, "nope", "meta.json");
		expect(() => atomicWriteJson(missing, { a: 1 })).toThrow();
		// The temp file lives beside the target, so nothing to clean up here —
		// assert we did not create the directory as a side effect.
		expect(existsSync(join(testDir, "nope"))).toBe(false);
	});
});