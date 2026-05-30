/**
 * E2E: AgentSession + EventSourcedRuntime
 *
 * Core invariant: when `useEventSourcedRuntime: true`, the full AgentSession
 * produces identical message roles and text as the legacy loop path.
 * Verified by running identical prompts with identical faux responses
 * and comparing the resulting session.messages arrays.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { createHarness, getMessageText, type Harness } from "./harness.js";

describe("AgentSession + useEventSourcedRuntime (e2e)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/**
	 * Core invariant: legacy and reactor modes produce the same message roles and text.
	 */
	it("produces identical roles and text to legacy mode (simple reply)", async () => {
		const legacy = await createHarness({ useEventSourcedRuntime: false });
		harnesses.push(legacy);
		legacy.setResponses([fauxAssistantMessage("hello from legacy")]);
		await legacy.session.prompt("hi");

		const reactor = await createHarness({ useEventSourcedRuntime: true });
		harnesses.push(reactor);
		reactor.setResponses([fauxAssistantMessage("hello from legacy")]);
		await reactor.session.prompt("hi");

		expect(reactor.session.messages.map((m) => m.role)).toEqual(
			legacy.session.messages.map((m) => m.role),
		);
		expect(getMessageText(reactor.session.messages[0]!)).toBe(getMessageText(legacy.session.messages[0]!));
		expect(getMessageText(reactor.session.messages[1]!)).toBe(getMessageText(legacy.session.messages[1]!));
	});

	/**
	 * Two sequential prompts each emit user+assistant in order.
	 */
	it("records user+assistant per prompt across multiple turns", async () => {
		const session = await createHarness({ useEventSourcedRuntime: true });
		harnesses.push(session);

		session.setResponses([fauxAssistantMessage("reply one")]);
		await session.session.prompt("first");
		session.setResponses([fauxAssistantMessage("reply two")]);
		await session.session.prompt("second");

		const roles = session.session.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
	});

	/**
	 * session.subscribe fires events (non-empty list).
	 */
	it("fires session events", async () => {
		const session = await createHarness({ useEventSourcedRuntime: true });
		harnesses.push(session);
		session.setResponses([fauxAssistantMessage("response")]);
		await session.session.prompt("hello");

		expect(session.events.length).toBeGreaterThan(0);
	});

	/**
	 * Sequential prompts produce matching role sequences in legacy and reactor modes.
	 */
	it("produces identical role sequences as legacy across two prompts", async () => {
		const legacy = await createHarness({ useEventSourcedRuntime: false });
		harnesses.push(legacy);
		legacy.setResponses([fauxAssistantMessage("one")]);
		await legacy.session.prompt("first");
		legacy.setResponses([fauxAssistantMessage("two")]);
		await legacy.session.prompt("second");

		const reactor = await createHarness({ useEventSourcedRuntime: true });
		harnesses.push(reactor);
		reactor.setResponses([fauxAssistantMessage("one")]);
		await reactor.session.prompt("first");
		reactor.setResponses([fauxAssistantMessage("two")]);
		await reactor.session.prompt("second");

		expect(reactor.session.messages.map((m) => m.role)).toEqual(legacy.session.messages.map((m) => m.role));
	});
});
