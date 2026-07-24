import { describe, expect, it } from "vitest";
import { detectChainedBuiltin } from "../src/core/tools/bash.js";

describe("detectChainedBuiltin", () => {
	it("returns the built-in when chained after &&", () => {
		expect(detectChainedBuiltin("sed -i '' x && _read src/main.ts 88 8")).toBe("_read");
	});

	it("returns the built-in when chained after ;", () => {
		expect(detectChainedBuiltin("echo hi; _write out.txt hello")).toBe("_write");
	});

	it("returns the built-in when chained after |", () => {
		expect(detectChainedBuiltin("echo hi | _edit f.ts replace 1#a x")).toBe("_edit");
	});

	it("returns the built-in when chained after ||", () => {
		expect(detectChainedBuiltin("false || _history_tree list")).toBe("_history_tree");
	});

	it("returns the built-in for the trailing segment after the last operator", () => {
		expect(detectChainedBuiltin("a && b && _session_split topic")).toBe("_session_split");
	});

	it("ignores a built-in that is the FIRST word (that one routes through normal parsing)", () => {
		expect(detectChainedBuiltin("_read src/main.ts")).toBeNull();
	});

	it("does not false-positive on content that merely contains the word", () => {
		// _read appears only as data / inside quotes / as a search pattern — not as a
		// command after an operator. These should not be flagged.
		expect(detectChainedBuiltin("grep _read file.txt")).toBeNull();
		expect(detectChainedBuiltin("echo '_read is great' && true")).toBeNull();
		expect(detectChainedBuiltin("printf '%s' _read")).toBeNull();
	});

	it("is case-insensitive", () => {
		expect(detectChainedBuiltin("foo && _READ x")).toBe("_read");
	});

	it("is not fooled by a quoted operator", () => {
		// The && is inside quotes, so the whole thing is one segment whose first word
		// is echo — no built-in chained after an operator.
		expect(detectChainedBuiltin("echo 'a && _read'")).toBeNull();
	});

	it("recognizes _delegate_agent", () => {
		expect(detectChainedBuiltin("foo && _delegate_agent list")).toBe("_delegate_agent");
	});

	it("returns null for a normal shell command", () => {
		expect(detectChainedBuiltin("grep -rn foo . | head")).toBeNull();
		expect(detectChainedBuiltin("git status && git diff")).toBeNull();
	});
});
