/**
 * Unified-diff parsing for the DiffViewer. Kept out of the component module so
 * React Fast Refresh keeps working, and so the parser stays unit-testable.
 */

export type DiffRowKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffRow {
	kind: DiffRowKind;
	/** Line number in the pre-image (old file); null for additions/headers. */
	oldNo: number | null;
	/** Line number in the post-image (new file); null for deletions/headers. */
	newNo: number | null;
	/** Line text with the leading +/-/space marker stripped (kept for hunks). */
	text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Prefixes of git/unified-diff metadata lines that carry no line numbers. */
const META_PREFIXES = [
	"diff ",
	"index ",
	"--- ",
	"+++ ",
	"old mode",
	"new mode",
	"similarity index",
	"dissimilarity index",
	"rename ",
	"copy ",
	"deleted file",
	"new file",
	"Binary files",
	"\\ No newline",
];

/**
 * Parse a unified diff into rows carrying real old/new line numbers, so the
 * viewer can render a two-column gutter like GitHub / VS Code rather than a
 * flat 1..N count (which would be meaningless for a diff).
 */
export function parseUnifiedDiff(text: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (const line of text.split("\n")) {
		const hunk = HUNK_RE.exec(line);
		if (hunk) {
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
			continue;
		}
		if (META_PREFIXES.some((p) => line.startsWith(p))) {
			rows.push({ kind: "meta", oldNo: null, newNo: null, text: line });
			continue;
		}
		if (line.startsWith("+")) {
			rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
		} else if (line.startsWith("-")) {
			rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
		} else {
			// Context line (leading space), or a trailing empty line.
			rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
		}
	}
	// Drop the phantom trailing context row produced by the final newline.
	const last = rows[rows.length - 1];
	if (last && last.kind === "ctx" && last.text === "") rows.pop();
	return rows;
}

/** Count added/removed lines in a unified diff (for the "+N −M" stat badge). */
export function diffStat(text: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}
