/**
 * EventStoreToAgentEventTranslator streaming tests.
 *
 * Verifies that AGENT_MESSAGE_CHUNK events from the EventStore translate
 * into the legacy `message_update` AgentEvent stream with the correct
 * `assistantMessageEvent` shape (text/thinking/toolcall deltas) and
 * accumulating `partial` message content.
 */

import { describe, expect, it } from "vitest";
import { EventStoreToAgentEventTranslator } from "../src/core/agent/event-sourced-adapter.js";
import type { EventBase } from "../src/core/event-store/types.js";

function mkEvent(
	type: string,
	payload: Record<string, unknown>,
	overrides: Partial<EventBase> = {},
): EventBase {
	return {
		event_id: `evt_${Math.random().toString(36).slice(2)}`,
		workspace_id: "test",
		session_id: "test-session",
		timestamp: Date.now(),
		actor_id: "test",
		type: type as EventBase["type"],
		payload: payload as any,
		...overrides,
	} as EventBase;
}

describe("EventStoreToAgentEventTranslator streaming", () => {
	it("emits message_update with text_delta accumulating partial text", () => {
		const t = new EventStoreToAgentEventTranslator();

		// Start
		t.translate(mkEvent("USER_MESSAGE", { content: "hi" }));
		t.translate(mkEvent("AGENT_MESSAGE_START", { model: { provider: "test", model_id: "x" } }));

		const a = t.translate(
			mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", contentIndex: 0, delta: "Hello " } }),
		);
		const b = t.translate(
			mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", contentIndex: 0, delta: "world" } }),
		);

		// First chunk should emit message_start then message_update
		expect(a.map((e) => e.type)).toEqual(["message_start", "message_update"]);
		expect(b.map((e) => e.type)).toEqual(["message_update"]);

		const update1 = a[1] as Extract<typeof a[number], { type: "message_update" }>;
		expect(update1.assistantMessageEvent.type).toBe("text_delta");
		expect((update1.assistantMessageEvent as any).delta).toBe("Hello ");
		expect((update1.message as any).content[0]).toEqual({ type: "text", text: "Hello " });

		const update2 = b[0] as Extract<typeof b[number], { type: "message_update" }>;
		expect((update2.assistantMessageEvent as any).delta).toBe("world");
		// Accumulated partial text
		expect((update2.message as any).content[0]).toEqual({ type: "text", text: "Hello world" });
	});

	it("emits message_update with thinking_delta", () => {
		const t = new EventStoreToAgentEventTranslator();

		t.translate(mkEvent("AGENT_MESSAGE_START", { model: { provider: "test", model_id: "x" } }));
		const a = t.translate(
			mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "thinking_delta", contentIndex: 0, delta: "let me think" } }),
		);

		const update = a.find((e) => e.type === "message_update")!;
		expect((update as any).assistantMessageEvent.type).toBe("thinking_delta");
		expect((update as any).message.content[0]).toEqual({ type: "thinking", thinking: "let me think" });
	});

	it("emits message_update with toolcall_start and toolcall_delta", () => {
		const t = new EventStoreToAgentEventTranslator();

		t.translate(mkEvent("AGENT_MESSAGE_START", { model: { provider: "test", model_id: "x" } }));

		const a = t.translate(
			mkEvent("AGENT_MESSAGE_CHUNK", {
				chunk: { kind: "toolcall_start", contentIndex: 0, tool_call_id: "tc-1", tool_name: "edit" },
			}),
		);
		const b = t.translate(
			mkEvent("AGENT_MESSAGE_CHUNK", {
				chunk: { kind: "toolcall_delta", contentIndex: 0, delta: '{"path"' },
			}),
		);
		const c = t.translate(
			mkEvent("AGENT_MESSAGE_CHUNK", {
				chunk: { kind: "toolcall_delta", contentIndex: 0, delta: ':"foo"}' },
			}),
		);

		expect(a.map((e) => e.type)).toEqual(["message_start", "message_update"]);
		expect((a[1] as any).assistantMessageEvent.type).toBe("toolcall_start");

		const finalUpdate = c.find((e) => e.type === "message_update")!;
		const partial = (finalUpdate as any).message;
		expect(partial.content[0]).toMatchObject({ type: "toolCall", id: "tc-1", name: "edit", arguments: { path: "foo" } });
	});

	it("interleaves thinking → text → tool call content blocks in order", () => {
		const t = new EventStoreToAgentEventTranslator();
		t.translate(mkEvent("AGENT_MESSAGE_START", { model: { provider: "test", model_id: "x" } }));
		t.translate(mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "thinking_delta", contentIndex: 0, delta: "reason" } }));
		t.translate(mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", contentIndex: 1, delta: "answer" } }));
		const last = t.translate(
			mkEvent("AGENT_MESSAGE_CHUNK", {
				chunk: { kind: "toolcall_start", contentIndex: 2, tool_call_id: "tc-1", tool_name: "edit" },
			}),
		);

		const update = last.find((e) => e.type === "message_update")!;
		const blocks = (update as any).message.content;
		expect(blocks.map((b: any) => b.type)).toEqual(["thinking", "text", "toolCall"]);
	});

	it("clears streaming state on AGENT_MESSAGE_END so the next message starts fresh", () => {
		const t = new EventStoreToAgentEventTranslator();
		t.translate(mkEvent("AGENT_MESSAGE_START", { model: { provider: "test", model_id: "x" } }));
		t.translate(mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", contentIndex: 0, delta: "first" } }));

		t.translate(
			mkEvent("AGENT_MESSAGE_END", {
				content: [{ type: "text", text: "first" }],
				model: { provider: "test", model_id: "x" },
				usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
				stop_reason: "stop",
			}),
		);

		// Start of next assistant message
		t.translate(mkEvent("AGENT_MESSAGE_START", { model: { provider: "test", model_id: "x" } }));
		const a = t.translate(
			mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", contentIndex: 0, delta: "second" } }),
		);
		const update = a.find((e) => e.type === "message_update")!;
		expect((update as any).message.content[0]).toEqual({ type: "text", text: "second" });
	});

	it("emits message_start only once per assistant message even across many deltas", () => {
		const t = new EventStoreToAgentEventTranslator();
		t.translate(mkEvent("AGENT_MESSAGE_START", { model: { provider: "test", model_id: "x" } }));

		const all = [
			t.translate(mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", contentIndex: 0, delta: "a" } })),
			t.translate(mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", contentIndex: 0, delta: "b" } })),
			t.translate(mkEvent("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", contentIndex: 0, delta: "c" } })),
		].flat();

		const starts = all.filter((e) => e.type === "message_start");
		const updates = all.filter((e) => e.type === "message_update");
		expect(starts).toHaveLength(1);
		expect(updates).toHaveLength(3);
	});
});
