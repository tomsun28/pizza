import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type CloneCommandContext = {
	facade: {
		runtime: {
			fork: (entryId: string) => Promise<{ cancelled: boolean }>;
			store?: { head: string | null };
		};
	};
	sessionManager: { getLeafId: () => string | null };
	handleRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	handleCloneCommand(this: CloneCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /clone", () => {
	it("clones the current leaf into a new session", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const handleRuntimeSessionChange = vi.fn(async () => {});
		const renderCurrentSessionState = vi.fn();
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();

		const context: CloneCommandContext = {
			facade: {
				runtime: {
					fork,
					store: { head: "leaf-123" },
				},
			},
			sessionManager: { getLeafId: () => "leaf-123" },
			handleRuntimeSessionChange,
			renderCurrentSessionState,
			editor: { setText },
			showStatus,
			showError,
			ui: { requestRender },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).toHaveBeenCalledWith("leaf-123");
		expect(renderCurrentSessionState).toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
		expect(showStatus).toHaveBeenCalledWith("Cloned to new session");
		expect(showError).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("shows a status message when there is nothing to clone", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: CloneCommandContext = {
			facade: {
				runtime: {
					fork,
					store: { head: null },
				},
			},
			sessionManager: { getLeafId: () => null },
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			showStatus,
			showError,
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Nothing to clone yet");
		expect(showError).not.toHaveBeenCalled();
	});
});
