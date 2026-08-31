/**
 * InteractiveMode queued-message facade wiring:
 * getSteeringMessagesFacade / getFollowUpMessagesFacade / clearQueueFacade must
 * read and clear the runtime's pending queue (previously hardcoded empty stubs,
 * which silently dropped the user's queued text on Esc).
 */
import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../packages/tui/interactive-mode.js";

function makeFacadeWithQueue(steering: string[], followUp: string[]) {
	let current = { steering: [...steering], followUp: [...followUp] };
	return {
		facade: {
			getQueuedMessages: () => ({ ...current }),
			clearQueuedMessages: () => {
				const cleared = current;
				current = { steering: [], followUp: [] };
				return cleared;
			},
		},
	};
}

describe("InteractiveMode queued-message facade", () => {
	test("reads steer/followUp texts from the facade", () => {
		const { facade } = makeFacadeWithQueue(["s1"], ["f1", "f2"]);
		const fakeThis = { facade };

		const getSteering = Reflect.get(InteractiveMode.prototype, "getSteeringMessagesFacade") as (this: typeof fakeThis) => readonly string[];
		const getFollowUp = Reflect.get(InteractiveMode.prototype, "getFollowUpMessagesFacade") as (this: typeof fakeThis) => readonly string[];

		expect(getSteering.call(fakeThis)).toEqual(["s1"]);
		expect(getFollowUp.call(fakeThis)).toEqual(["f1", "f2"]);
	});

	test("clearQueueFacade clears and returns the texts", () => {
		const { facade } = makeFacadeWithQueue(["s1"], ["f1"]);
		const fakeThis = { facade };

		const clear = Reflect.get(InteractiveMode.prototype, "clearQueueFacade") as (this: typeof fakeThis) => { steering: string[]; followUp: string[] };

		expect(clear.call(fakeThis)).toEqual({ steering: ["s1"], followUp: ["f1"] });
		// Second read shows the queue was actually cleared.
		const getSteering = Reflect.get(InteractiveMode.prototype, "getSteeringMessagesFacade") as (this: typeof fakeThis) => readonly string[];
		expect(getSteering.call(fakeThis)).toEqual([]);
	});

	test("restoreQueuedMessagesToEditor puts cleared texts into the editor", () => {
		const { facade } = makeFacadeWithQueue(["s1"], ["f1"]);
		const setText = vi.fn();
		const proto = InteractiveMode.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>;
		const fakeThis = {
			facade,
			editor: { getText: () => "draft", setText },
			pendingMessagesContainer: {
				clear: vi.fn(),
				addChild: vi.fn(),
			},
			compactionQueuedMessages: [],
			clearAllQueues: proto["clearAllQueues"],
			clearQueueFacade: proto["clearQueueFacade"],
			getSteeringMessagesFacade: proto["getSteeringMessagesFacade"],
			getFollowUpMessagesFacade: proto["getFollowUpMessagesFacade"],
			updatePendingMessagesDisplay: vi.fn(),
		};

		const restore = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof fakeThis,
			options?: { abort?: boolean; currentText?: string },
		) => number;

		const count = restore.call(fakeThis);
		expect(count).toBe(2);
		expect(setText).toHaveBeenCalledWith("s1\n\nf1\n\ndraft");
	});
});
