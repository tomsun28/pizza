// Module-level per-workspace draft store. Survives Composer unmounts (the
// workspace-switch loading screen unmounts the whole AgentView), so unsent
// input is restored when the user switches back. Images/files are kept in
// memory only; plain text is also mirrored to localStorage so drafts survive
// an app restart.
import type { ComposerImage } from "@/components/Composer";
import type { LoadedFileAttachment } from "@/lib/file-attachment";

export interface ComposerDraft {
	input: string;
	images: ComposerImage[];
	files: LoadedFileAttachment[];
}

const draftsByWs = new Map<string, ComposerDraft>();
const DRAFT_STORAGE_KEY = "pizza.composer.drafts";

export function saveDraft(ws: string, draft: Pick<ComposerDraft, "input" | "images" | "files">): void {
	draftsByWs.set(ws, { input: draft.input, images: draft.images, files: draft.files });
	try {
		const stored: Record<string, string> = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "{}");
		if (draft.input.trim()) {
			stored[ws] = draft.input;
		} else {
			delete stored[ws];
		}
		localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(stored));
	} catch {
		// localStorage unavailable (private mode/quota) — memory store still works.
	}
}

/** Remove a workspace draft (memory + localStorage). Called when the
 *  workspace itself is deleted so stale drafts never accumulate. */
export function clearComposerDraft(ws: string): void {
	draftsByWs.delete(ws);
	try {
		const stored: Record<string, string> = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "{}");
		if (ws in stored) {
			delete stored[ws];
			localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(stored));
		}
	} catch {
		// ignore
	}
}

export function loadDraft(ws: string): ComposerDraft {
	const memory = draftsByWs.get(ws);
	if (memory) return memory;
	// No in-memory draft (e.g. app restarted): fall back to persisted text.
	let input = "";
	try {
		const stored: Record<string, string> = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "{}");
		input = stored[ws] ?? "";
	} catch {
		// ignore
	}
	return { input, images: [], files: [] };
}