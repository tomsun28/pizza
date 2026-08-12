/**
 * Dedicated unit tests for the POSIX-aware shell-word splitter
 * (`splitShellWords` / `splitShellWordsWithMeta`). This module is pure logic
 * shared by builtin command parsing and the intent classifier, but previously
 * only had indirect coverage — these tests pin down its quoting/escaping
 * semantics directly.
 */

import { describe, it, expect } from "vitest";
import { splitShellWords, splitShellWordsWithMeta } from "../src/core/shell-words.js";

describe("splitShellWords — basic splitting", () => {
	it("splits on runs of whitespace", () => {
		expect(splitShellWords("a b c")).toEqual(["a", "b", "c"]);
		expect(splitShellWords("a    b\t\tc")).toEqual(["a", "b", "c"]);
	});
	it("trims surrounding whitespace and drops empty words", () => {
		expect(splitShellWords("   a   ")).toEqual(["a"]);
		expect(splitShellWords("    ")).toEqual([]);
		expect(splitShellWords("")).toEqual([]);
	});
});

describe("splitShellWords — single quotes", () => {
	it("keeps everything literally, including backslash, and preserves spaces", () => {
		expect(splitShellWords("a 'b c' d")).toEqual(["a", "b c", "d"]);
		// backslash is literal inside single quotes — it does NOT escape the
		// closing quote, so 'a\b c' is one word "a\b c".
		expect(splitShellWords("'a\\b c'")).toEqual(["a\\b c"]);
	});
});

describe("splitShellWords — double quotes", () => {
	it("preserves internal spaces", () => {
		expect(splitShellWords('a "b c" d')).toEqual(["a", "b c", "d"]);
	});
	it("only escapes $ ` \" \\ and newline; keeps other backslashes literally", () => {
		// \" is an escaped quote
		expect(splitShellWords('x "a\\"b"')).toEqual(["x", 'a"b']);
		// \n is literal backslash-n (not a member of the double-escapable set)
		expect(splitShellWords('"a\\nb"')).toEqual(["a\\nb"]);
	});
	it("concatenates adjacent quoted and unquoted runs into one word", () => {
		expect(splitShellWords('pre"mid"post')).toEqual(["premidpost"]);
		expect(splitShellWords('a"x"y')).toEqual(["axy"]);
	});
});

describe("splitShellWords — backslash escaping (unquoted)", () => {
	it("escapes the next character", () => {
		expect(splitShellWords("a\\ b c")).toEqual(["a b", "c"]); // escaped space
		expect(splitShellWords("a\\b")).toEqual(["ab"]);
	});
	it("keeps a trailing backslash literally", () => {
		expect(splitShellWords("\\")).toEqual(["\\"]);
		expect(splitShellWords("x\\")).toEqual(["x\\"]);
	});
});

describe("splitShellWords — empty quoted regions yield empty words (POSIX)", () => {
	// Regression: previously empty quotes were dropped entirely, so `a "" b`
	// wrongly split into ["a","b"] instead of the 3-arg ["a","","b"] a real
	// shell produces.
	it("single empty quotes between words keep an empty-string argument", () => {
		expect(splitShellWords("a '' b")).toEqual(["a", "", "b"]);
	});
	it("double empty quotes between words keep an empty-string argument", () => {
		expect(splitShellWords('a "" b')).toEqual(["a", "", "b"]);
	});
	it("a sole empty-quoted value yields one empty word", () => {
		expect(splitShellWords("''")).toEqual([""]);
		expect(splitShellWords('""')).toEqual([""]);
	});
	it("an empty-quoted value adjacent to a literal concatenates", () => {
		expect(splitShellWords("''hello")).toEqual(["hello"]);
		expect(splitShellWords('x""')).toEqual(["x"]);
	});
});

describe("splitShellWordsWithMeta — quote delimiter accounting", () => {
	it("counts every consumed quote delimiter", () => {
		// 4 delimiters (2 pairs) inside one word
		expect(splitShellWordsWithMeta('secret("X", "Y")').meta.quoteDelimitersConsumed).toBe(4);
	});
	it("counts zero for bare unquoted words", () => {
		expect(splitShellWordsWithMeta("hello world foo").meta.quoteDelimitersConsumed).toBe(0);
	});
	it("counts a fully-quoted single word's pair as 2", () => {
		const { words, meta } = splitShellWordsWithMeta('"hello world"');
		expect(words).toEqual(["hello world"]);
		expect(meta.quoteDelimitersConsumed).toBe(2);
	});
	it("still accounts for an empty-quoted pair", () => {
		expect(splitShellWordsWithMeta('""').meta.quoteDelimitersConsumed).toBe(2);
	});
	it("best-effort: an unterminated quote still yields the collected content", () => {
		expect(splitShellWords("'unterminated")).toEqual(["unterminated"]);
		expect(splitShellWords('"unterminated')).toEqual(["unterminated"]);
	});
});
