/**
 * Unit tests for the file attachment helpers.
 *
 * loadFileAttachment uses FileReader which isn't available in plain Node,
 * so we only test the pure functions here. The DOM-dependent bits are
 * exercised by the desktop app's E2E flow.
 */

import { describe, expect, it } from "vitest";

import {
	buildFileAttachmentRef,
	composeFileAttachmentBlock,
	IMAGE_MIME_TYPES,
	MAX_IMAGE_BYTES,
} from "../apps/web/src/lib/file-attachment";

describe("IMAGE_MIME_TYPES", () => {
	it("includes the common image formats", () => {
		expect(IMAGE_MIME_TYPES.has("image/jpeg")).toBe(true);
		expect(IMAGE_MIME_TYPES.has("image/png")).toBe(true);
		expect(IMAGE_MIME_TYPES.has("image/gif")).toBe(true);
		expect(IMAGE_MIME_TYPES.has("image/webp")).toBe(true);
	});
});

describe("MAX_IMAGE_BYTES", () => {
	it("is a positive cap (matches the read tool's resize budget)", () => {
		expect(MAX_IMAGE_BYTES).toBeGreaterThan(0);
	});
});

describe("buildFileAttachmentRef", () => {
	it("wraps an absolute path in a file tag", () => {
		expect(buildFileAttachmentRef("/abs/path/foo.txt"))
			.toBe('<file path="/abs/path/foo.txt"/>');
	});
});

describe("composeFileAttachmentBlock", () => {
	it("returns the original message when no attachments are given", () => {
		expect(composeFileAttachmentBlock("hi", [])).toBe("hi");
		expect(composeFileAttachmentBlock("", [])).toBe("");
	});

	it("appends file path references after the user message", () => {
		const out = composeFileAttachmentBlock("explain this", [
			{ absolutePath: "/abs/a.txt" },
			{ absolutePath: "/abs/b.txt" },
		]);
		expect(out).toBe("explain this" + "\n" + '<file path="/abs/a.txt"/>' + "\n" + '<file path="/abs/b.txt"/>');
	});
});
