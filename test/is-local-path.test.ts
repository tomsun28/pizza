import { describe, expect, it } from "vitest";
import { isLocalPath } from "../src/utils/paths.js";

describe("isLocalPath", () => {
	describe("non-local package sources and URL protocols", () => {
		const nonLocal = [
			"npm:pkg@1.0.0",
			"npm:@scope/pkg",
			"git://github.com/user/repo.git",
			// Canonical npm git dependency forms (git+ transport). These must be
			// treated as remote sources, not local filesystem paths.
			"git+ssh://git@github.com/user/repo.git",
			"git+https://github.com/user/repo.git",
			"git+http://github.com/user/repo.git",
			"github:user/repo",
			"file:./local-package",
			"file:../sibling",
			"http://example.com/x",
			"https://example.com/x",
			"ssh://git@example.com/user/repo",
		];
		for (const value of nonLocal) {
			it(`returns false for ${JSON.stringify(value)}`, () => {
				expect(isLocalPath(value)).toBe(false);
			});
		}

		it("ignores leading whitespace when detecting a protocol", () => {
			expect(isLocalPath("  git+https://github.com/user/repo.git")).toBe(false);
		});
	});

	describe("local paths and bare names", () => {
		const local = [
			"./local",
			"../sibling",
			"/abs/path",
			"bare-name",
			"@scope/name", // bare scoped name, not an npm: spec
			"packages/local-package",
		];
		for (const value of local) {
			it(`returns true for ${JSON.stringify(value)}`, () => {
				expect(isLocalPath(value)).toBe(true);
			});
		}
	});
});
