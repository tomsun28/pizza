/**
 * File attachment helpers.
 *
 * Files dropped/picked by the user are either:
 * - images         → kept as base64 inline attachments (the LLM sees the pixels)
 * - non-image files → uploaded to <cwd>/.pizza/uploads/<ws>/<session>/<uuid>-<name>
 *                     via the `save_upload` RPC; the agent receives a path reference
 *                     and uses its own file tools (read, bash, python-docx, ...)
 *                     to read them.
 *
 * The DOM-bound bits (FileReader, DragEvent wiring) live in the React
 * component. This module is pure helpers + the small async wrappers that
 * talk to the sidecar via sendCommandAwait.
 */

import { sendCommandAwait } from "./transport";

/** Hard upper bound for image attachments; the sidecar / image-resize path
 *  handles anything under this.  */
export const MAX_IMAGE_BYTES = 2000 * 2000 * 4;

/** MIME types we treat as inline images. */
export const IMAGE_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

/** A loaded image ready to be sent as an `ImageContent` over RPC. */
export interface LoadedImageAttachment {
	kind: "image";
	/** base64 payload, no data-URL prefix. */
	data: string;
	mimeType: string;
	/** Original file name, for display. */
	name: string;
	/** Data URL for in-chat preview. */
	preview: string;
	/** File size in bytes. */
	size: number;
}

/**
 * A non-image file path reference. The sidecar's `save_upload` handler
 * wrote the original bytes to <cwd>/.pizza/uploads/<ws>/<session>/<uuid>-<name>;
 * the agent receives the absolute path and decides how to read it.
 */
export interface LoadedFileAttachment {
	kind: "file";
	/** Absolute path the agent can read with file tools. */
	absolutePath: string;
	/** Path relative to the workspace cwd, for display ("uploads/.../name.pdf"). */
	relativePath: string;
	/** Best-effort MIME (may be empty when the OS didn't supply one). */
	mimeType: string;
	/** Original file name (basename). */
	name: string;
	/** File size in bytes. */
	size: number;
}

/** A file we intentionally rejected (too large, save error, etc.). */
export interface RejectedAttachment {
	kind: "rejected";
	name: string;
	size: number;
	mimeType: string;
	reason: string;
}

export type LoadedAttachment = LoadedImageAttachment | LoadedFileAttachment;
export type AnyAttachment = LoadedAttachment | RejectedAttachment;

// ---------------------------------------------------------------------------
// FileReader helpers — browser/DOM only.
// ---------------------------------------------------------------------------

/** Read a File as a base64 data URL (data:<mime>;base64,<data>). */
export function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === "string") resolve(reader.result);
			else reject(new Error("FileReader returned non-string"));
		};
		reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
		reader.readAsDataURL(file);
	});
}

/** Read a File as raw base64 (no data-URL prefix). */
export function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error("FileReader returned non-string"));
				return;
			}
			const comma = reader.result.indexOf(",");
			resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
		};
		reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
		reader.readAsDataURL(file);
	});
}

// ---------------------------------------------------------------------------
// Main entry point — loadFileAttachment.
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB hard cap

/**
 * Process a single File: image → base64 inline; non-image → upload via the
 * sidecar's save_upload RPC and return a path reference. Anything that
 * fails becomes a RejectedAttachment for the UI to surface.
 */
export async function loadFileAttachment(file: File): Promise<AnyAttachment> {
	const name = file.name || "untitled";
	const size = file.size;
	const declaredMime = file.type || "";

	// Images stay as base64 inline attachments so the LLM sees the pixels.
	if (declaredMime && IMAGE_MIME_TYPES.has(declaredMime)) {
		try {
			const dataUrl = await readFileAsDataUrl(file);
			const comma = dataUrl.indexOf(",");
			const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
			return {
				kind: "image",
				data,
				mimeType: declaredMime,
				name,
				preview: dataUrl,
				size,
			};
		} catch (e) {
			return {
				kind: "rejected",
				name,
				size,
				mimeType: declaredMime,
				reason: e instanceof Error ? e.message : String(e),
			};
		}
	}

	// Anything else: upload to <cwd>/.pizza/uploads/<ws>/<session>/<uuid>-<name>.
	if (size > MAX_FILE_BYTES) {
		return {
			kind: "rejected",
			name,
			size,
			mimeType: declaredMime,
			reason: `File too large: ${(size / 1024 / 1024).toFixed(1)}MB exceeds 100MB limit`,
		};
	}

	let dataB64: string;
	try {
		dataB64 = await readFileAsBase64(file);
	} catch (e) {
		return {
			kind: "rejected",
			name,
			size,
			mimeType: declaredMime,
			reason: e instanceof Error ? e.message : String(e),
		};
	}

	try {
		const r = await sendCommandAwait<{
			absolutePath: string;
			relativePath: string;
			size: number;
		}>({
			type: "save_upload",
			filename: name,
			mimeType: declaredMime || "application/octet-stream",
			dataB64,
		}, 120_000);
		if (!r.data) {
			return {
				kind: "rejected",
				name,
				size,
				mimeType: declaredMime,
				reason: "Server returned an empty response",
			};
		}
		return {
			kind: "file",
			absolutePath: r.data.absolutePath,
			relativePath: r.data.relativePath,
			mimeType: declaredMime || "application/octet-stream",
			name,
			size: r.data.size,
		};
	} catch (e) {
		return {
			kind: "rejected",
			name,
			size,
			mimeType: declaredMime,
			reason: e instanceof Error ? e.message : String(e),
		};
	}
}

// ---------------------------------------------------------------------------
// Message composition — pure.
// ---------------------------------------------------------------------------

/** Build a single `<file path="…"/>` reference. */
export function buildFileAttachmentRef(absolutePath: string): string {
	return `<file path="${absolutePath}"/>`;
}

/**
 * Append a list of `<file path="…"/>` references after the user message,
 * one per line. We keep this as a pure helper so conversation history
 * tools can re-derive the same string from a stored message.
 */
export function composeFileAttachmentBlock(
	originalMessage: string,
	files: ReadonlyArray<{ absolutePath: string }>,
): string {
	if (files.length === 0) return originalMessage;
	const refs = files.map((f) => buildFileAttachmentRef(f.absolutePath)).join("\n");
	const trimmed = originalMessage.trimEnd();
	return trimmed ? `${trimmed}\n${refs}` : refs;
}
