import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
	truncateTail,
} from "../src/core/tools/truncate.js";

describe("truncate", () => {
	describe("formatSize", () => {
		it("formats bytes below 1KB as plain bytes", () => {
			expect(formatSize(0)).toBe("0B");
			expect(formatSize(1)).toBe("1B");
			expect(formatSize(1023)).toBe("1023B");
		});

		it("formats 1KB boundaries in kilobytes with one decimal", () => {
			expect(formatSize(1024)).toBe("1.0KB");
			expect(formatSize(2048)).toBe("2.0KB");
		});

		it("formats sizes at and above 1MB in megabytes", () => {
			expect(formatSize(1024 * 1024)).toBe("1.0MB");
			expect(formatSize(1024 * 1024 * 5)).toBe("5.0MB");
		});
	});

	describe("truncateHead", () => {
		it("returns content unchanged when under both limits", () => {
			const content = "line1\nline2\nline3";
			const result = truncateHead(content);
			expect(result.content).toBe(content);
			expect(result.truncated).toBe(false);
			expect(result.truncatedBy).toBeNull();
			expect(result.outputLines).toBe(result.totalLines);
			expect(result.firstLineExceedsLimit).toBe(false);
		});

		it("reports the applied limits", () => {
			const result = truncateHead("x", { maxLines: 10, maxBytes: 100 });
			expect(result.maxLines).toBe(10);
			expect(result.maxBytes).toBe(100);
		});

		it("keeps the first N lines when the line limit is hit", () => {
			const result = truncateHead("a\nb\nc\nd\ne", { maxLines: 2 });
			expect(result.content).toBe("a\nb");
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("lines");
			expect(result.outputLines).toBe(2);
			expect(result.totalLines).toBe(5);
			expect(result.lastLinePartial).toBe(false);
		});

		it("keeps complete lines when the byte limit is hit", () => {
			// "ab"(2) + "\n"(1) + "cd"(2) = 5 bytes fits; "ef" would overflow.
			const result = truncateHead("ab\ncd\nef", { maxLines: 100, maxBytes: 5 });
			expect(result.content).toBe("ab\ncd");
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("bytes");
			expect(result.outputLines).toBe(2);
			expect(result.lastLinePartial).toBe(false);
		});

		it("returns empty content when the first line alone exceeds the byte limit", () => {
			const result = truncateHead("toolongline\nshort", { maxBytes: 5 });
			expect(result.content).toBe("");
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("bytes");
			expect(result.firstLineExceedsLimit).toBe(true);
			expect(result.outputLines).toBe(0);
		});

		it("does not flag firstLineExceedsLimit when the first line exactly equals the byte limit", () => {
			// The check is strictly greater-than, so an exact match is allowed through.
			const result = truncateHead("abcde", { maxBytes: 5 });
			expect(result.firstLineExceedsLimit).toBe(false);
			expect(result.truncated).toBe(false);
		});

		it("handles empty content without truncating", () => {
			const result = truncateHead("");
			expect(result.content).toBe("");
			expect(result.truncated).toBe(false);
			expect(result.totalLines).toBe(1);
		});
	});

	describe("truncateTail", () => {
		it("returns content unchanged when under both limits", () => {
			const content = "x\ny";
			const result = truncateTail(content);
			expect(result.content).toBe(content);
			expect(result.truncated).toBe(false);
			expect(result.truncatedBy).toBeNull();
		});

		it("keeps the last N lines when the line limit is hit", () => {
			const result = truncateTail("a\nb\nc\nd\ne", { maxLines: 2 });
			expect(result.content).toBe("d\ne");
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("lines");
			expect(result.outputLines).toBe(2);
			expect(result.totalLines).toBe(5);
		});

		it("keeps the tail that fits within the byte limit", () => {
			const result = truncateTail("a\nb\nc\nd\ne", { maxBytes: 5 });
			expect(result.content).toBe("c\nd\ne");
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("bytes");
			expect(result.outputLines).toBe(3);
		});

		it("keeps a single trailing line with no preceding newline", () => {
			const result = truncateTail("one\ntwo\nthree", { maxLines: 1 });
			expect(result.content).toBe("three");
			expect(result.outputLines).toBe(1);
			expect(result.truncated).toBe(true);
		});

		it("returns a partial last line when a single line exceeds the byte limit", () => {
			const result = truncateTail("x".repeat(20), { maxBytes: 5 });
			expect(result.content).toBe("xxxxx");
			expect(result.lastLinePartial).toBe(true);
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("bytes");
			expect(result.outputBytes).toBe(5);
		});

		it("lands on a valid UTF-8 boundary when partially truncating multi-byte content", () => {
			// Three 4-byte emoji = 12 bytes. With maxBytes 6 the tail must keep the
			// last whole character (4 bytes) rather than splitting a surrogate pair.
			const result = truncateTail("😀😁😂", { maxBytes: 6 });
			expect(result.content).toBe("😂");
			expect(result.lastLinePartial).toBe(true);
			expect(result.outputBytes).toBe(4);
		});
	});

	describe("truncateLine", () => {
		it("returns short lines unchanged", () => {
			const result = truncateLine("hi");
			expect(result.text).toBe("hi");
			expect(result.wasTruncated).toBe(false);
		});

		it("does not truncate a line that exactly matches the max length", () => {
			const line = "x".repeat(GREP_MAX_LINE_LENGTH);
			const result = truncateLine(line);
			expect(result.wasTruncated).toBe(false);
			expect(result.text).toBe(line);
		});

		it("truncates long lines and appends a marker", () => {
			const result = truncateLine("x".repeat(GREP_MAX_LINE_LENGTH + 10));
			expect(result.wasTruncated).toBe(true);
			expect(result.text.startsWith("x".repeat(GREP_MAX_LINE_LENGTH))).toBe(true);
			expect(result.text.endsWith("[truncated]")).toBe(true);
		});

		it("honours a custom max length", () => {
			const result = truncateLine("abcdef", 3);
			expect(result.wasTruncated).toBe(true);
			expect(result.text).toBe("abc... [truncated]");
		});
	});

	describe("defaults", () => {
		it("exposes sensible default limits", () => {
			expect(DEFAULT_MAX_LINES).toBe(2000);
			expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
		});
	});
});