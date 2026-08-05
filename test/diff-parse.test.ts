import { describe, expect, test } from "vitest";
import { parseUnifiedDiff, diffStat } from "../apps/web/src/lib/diff.js";

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,6 +10,7 @@ function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
`;

describe("parseUnifiedDiff", () => {
	test("classifies metadata, hunk, context, add and delete rows", () => {
		const rows = parseUnifiedDiff(SAMPLE);
		expect(rows.filter((r) => r.kind === "meta").map((r) => r.text)).toEqual([
			"diff --git a/src/app.ts b/src/app.ts",
			"index 1234567..89abcde 100644",
			"--- a/src/app.ts",
			"+++ b/src/app.ts",
		]);
		expect(rows.filter((r) => r.kind === "hunk")).toHaveLength(1);
		expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual([
			"const b = 3;",
			"const c = 4;",
		]);
		expect(rows.filter((r) => r.kind === "del").map((r) => r.text)).toEqual(["const b = 2;"]);
	});

	test("assigns old/new line numbers from the hunk header", () => {
		const rows = parseUnifiedDiff(SAMPLE).filter((r) => r.kind !== "meta" && r.kind !== "hunk");
		// Hunk starts at old line 10 / new line 10.
		expect(rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
			["ctx", 10, 10],
			["del", 11, null],
			["add", null, 11],
			["add", null, 12],
			["ctx", 12, 13],
		]);
	});

	test("strips the phantom trailing context row from the final newline", () => {
		const rows = parseUnifiedDiff(SAMPLE);
		expect(rows[rows.length - 1]!.text).toBe("return a;");
	});

	test("handles hunk headers without explicit line counts", () => {
		const rows = parseUnifiedDiff("@@ -5 +7 @@\n-old\n+new\n");
		expect(rows.find((r) => r.kind === "del")?.oldNo).toBe(5);
		expect(rows.find((r) => r.kind === "add")?.newNo).toBe(7);
	});

	test("treats 'no newline at end of file' markers as metadata", () => {
		const rows = parseUnifiedDiff("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
		expect(rows.filter((r) => r.kind === "meta")).toHaveLength(1);
		// The marker must not consume a line number.
		expect(rows.find((r) => r.kind === "add")?.newNo).toBe(1);
	});
});

describe("diffStat", () => {
	test("counts additions and deletions, ignoring +++/--- headers", () => {
		expect(diffStat(SAMPLE)).toEqual({ added: 2, removed: 1 });
	});

	test("returns zeros for an empty diff", () => {
		expect(diffStat("")).toEqual({ added: 0, removed: 0 });
	});
});
