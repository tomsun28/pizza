/**
 * Tests for BASH_EXECUTION, CUSTOM_MESSAGE, and BRANCH_SUMMARY event projection
 * into the corresponding AgentMessage shapes.
 */

import { describe, expect, it } from "vitest";
import { eventToMessage, extractToolCalls } from "../src/core/projection/event-to-message.js";
import type { EventBase } from "../src/core/event-store/types.js";

function mkEvent(
	type: string,
	payload: Record<string, unknown>,
): EventBase {
	return {
		event_id: `evt_${Math.random().toString(36).slice(2)}`,
		workspace_id: "test",
		session_id: "test-session",
		timestamp: Date.now(),
		actor_id: "test",
		type: type as EventBase["type"],
		payload: payload as any,
	} as EventBase;
}

describe("eventToMessage — BASH_EXECUTION / CUSTOM_MESSAGE / BRANCH_SUMMARY", () => {
	it("projects event-store tool_call blocks into assistant toolCall blocks", () => {
		const msg = eventToMessage(
			mkEvent("AGENT_MESSAGE_END", {
				content: [
					{ type: "text", text: "I'll read that." },
					{ type: "tool_call", id: "call_1", name: "read", arguments: { path: "src/main.ts" } },
				],
				model: { provider: "anthropic", model_id: "claude-sonnet" },
				usage: { input: 10, output: 20, cache_read: 0, cache_write: 0, total: 30, cost: 0.001 },
				stop_reason: "tool_use",
			}),
		);

		expect(msg).not.toBeNull();
		expect(msg!.role).toBe("assistant");
		expect((msg as any).content[1]).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "src/main.ts" },
		});
		expect((msg as any).stopReason).toBe("toolUse");
	});

	it("keeps legacy assistant toolCall blocks when projecting assistant events", () => {
		const msg = eventToMessage(
			mkEvent("AGENT_MESSAGE_END", {
				content: [
					{ type: "toolCall", id: "call_legacy", name: "bash", arguments: { command: "echo hi" } },
				],
				model: { provider: "zai", model_id: "glm-5" },
				usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
				stop_reason: "tool_use",
			}),
		);

		expect((msg as any).content).toEqual([
			{ type: "toolCall", id: "call_legacy", name: "bash", arguments: { command: "echo hi" } },
		]);
	});

	it("extracts tool calls from both event-store and legacy assistant block shapes", () => {
		expect(extractToolCalls([{ type: "tool_call", id: "a", name: "read", arguments: { path: "a" } }])).toEqual([
			{ id: "a", name: "read", arguments: { path: "a" } },
		]);
		expect(extractToolCalls([{ type: "toolCall", id: "b", name: "bash", arguments: { command: "echo b" } }])).toEqual([
			{ id: "b", name: "bash", arguments: { command: "echo b" } },
		]);
	});

	it("projects BASH_EXECUTION into a BashExecutionMessage", () => {
		const msg = eventToMessage(
			mkEvent("BASH_EXECUTION", {
				command: "echo hi",
				output: "hi\n",
				stdout: "hi\n",
				stderr: "",
				exit_code: 0,
				duration_ms: 5,
				cwd: "/tmp",
				cancelled: false,
				truncated: false,
			}),
		);
		expect(msg).not.toBeNull();
		expect(msg!.role).toBe("bashExecution");
		expect((msg as any).command).toBe("echo hi");
		expect((msg as any).output).toBe("hi\n");
		expect((msg as any).exitCode).toBe(0);
		expect((msg as any).cancelled).toBe(false);
		expect((msg as any).truncated).toBe(false);
	});

	it("defaults cancelled/truncated to false when omitted", () => {
		const msg = eventToMessage(
			mkEvent("BASH_EXECUTION", { command: "ls", output: "..." }),
		);
		expect((msg as any).cancelled).toBe(false);
		expect((msg as any).truncated).toBe(false);
		expect((msg as any).output).toBe("...");
	});

	it("preserves full_output_path and exclude_from_context", () => {
		const msg = eventToMessage(
			mkEvent("BASH_EXECUTION", {
				command: "yes",
				output: "...",
				full_output_path: "/tmp/full.txt",
				exclude_from_context: true,
				truncated: true,
			}),
		);
		expect((msg as any).fullOutputPath).toBe("/tmp/full.txt");
		expect((msg as any).excludeFromContext).toBe(true);
		expect((msg as any).truncated).toBe(true);
	});

	it("projects CUSTOM_MESSAGE with string data into a CustomMessage with string content", () => {
		const msg = eventToMessage(
			mkEvent("CUSTOM_MESSAGE", {
				extension_id: "my-ext",
				kind: "note",
				data: "hello custom",
				display: true,
			}),
		);
		expect(msg).not.toBeNull();
		expect(msg!.role).toBe("custom");
		expect((msg as any).customType).toBe("my-ext:note");
		expect((msg as any).content).toBe("hello custom");
		expect((msg as any).display).toBe(true);
		expect((msg as any).details).toBeUndefined();
	});

	it("projects CUSTOM_MESSAGE with array data into content array", () => {
		const msg = eventToMessage(
			mkEvent("CUSTOM_MESSAGE", {
				extension_id: "ui",
				kind: "card",
				data: [{ type: "text", text: "block one" }],
			}),
		);
		expect((msg as any).content).toEqual([{ type: "text", text: "block one" }]);
	});

	it("projects CUSTOM_MESSAGE with object data into details", () => {
		const obj = { foo: "bar", n: 1 };
		const msg = eventToMessage(
			mkEvent("CUSTOM_MESSAGE", {
				extension_id: "x",
				kind: "y",
				data: obj,
				display: "Show this",
			}),
		);
		expect((msg as any).details).toEqual(obj);
		expect((msg as any).content).toBe("");
		expect((msg as any).display).toBe("Show this");
	});

	it("projects BRANCH_SUMMARY into a BranchSummaryMessage", () => {
		const msg = eventToMessage(
			mkEvent("BRANCH_SUMMARY", {
				summary: "Previously fixed bug X",
				from_id: "evt-123",
			}),
		);
		expect(msg).not.toBeNull();
		expect(msg!.role).toBe("branchSummary");
		expect((msg as any).summary).toBe("Previously fixed bug X");
		expect((msg as any).fromId).toBe("evt-123");
	});
});
