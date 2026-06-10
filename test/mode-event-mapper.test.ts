import { describe, expect, it } from "vitest";
import type { EventBase, EventType } from "../src/core/event-store/types.js";
import { mapTypedEventToModeEvents } from "../src/modes/event-mapper.js";

let sequence = 0;

function mkEvent(type: EventType, payload: unknown): EventBase {
	sequence++;
	return {
		sequence,
		event_id: `evt-${sequence}`,
		workspace_id: "workspace",
		runtime_id: "runtime",
		actor_id: "runtime",
		timestamp: 1000 + sequence,
		type,
		payload,
	};
}

const usage = { input: 1, output: 2, cache_read: 0, cache_write: 0, total: 3, cost: 0 };

describe("ModeEventMapper", () => {
	it("maps assistant streaming and committed messages", () => {
		expect(mapTypedEventToModeEvents(mkEvent("AGENT_MESSAGE_START", {
			model: { provider: "test", model_id: "model" },
		}))).toEqual([{
			type: "streaming_message_started",
			eventId: "evt-1",
			model: { provider: "test", model_id: "model" },
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("AGENT_MESSAGE_CHUNK", {
			chunk: { kind: "text_delta", contentIndex: 0, delta: "hello" },
		}))).toEqual([{
			type: "streaming_message_updated",
			eventId: "evt-2",
			chunk: { kind: "text_delta", contentIndex: 0, delta: "hello" },
			delta: "hello",
		}]);

		const actions = mapTypedEventToModeEvents(mkEvent("AGENT_MESSAGE_END", {
			content: [{ type: "text", text: "done" }],
			model: { provider: "test", model_id: "model" },
			usage,
			stop_reason: "stop",
		}));

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ type: "message_committed", eventId: "evt-3" });
		expect(actions[0]?.type === "message_committed" ? actions[0].message.role : undefined).toBe("assistant");
	});

	it("maps tool execution events and commits tool result messages", () => {
		expect(mapTypedEventToModeEvents(mkEvent("TOOL_EXECUTION_START", {
			tool_call_id: "call_1",
			tool_name: "echo",
			arguments: { text: "hi" },
		}))).toEqual([{
			type: "tool_started",
			eventId: "evt-4",
			toolCallId: "call_1",
			toolName: "echo",
			args: { text: "hi" },
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("TOOL_EXECUTION_UPDATE", {
			tool_call_id: "call_1",
			update: "halfway",
			progress: 0.5,
		}))).toEqual([{
			type: "tool_updated",
			eventId: "evt-5",
			toolCallId: "call_1",
			update: "halfway",
			progress: 0.5,
		}]);

		const actions = mapTypedEventToModeEvents(mkEvent("TOOL_EXECUTION_END", {
			tool_call_id: "call_1",
			tool_name: "echo",
			result: [{ type: "text", text: "hi" }],
			is_error: false,
		}));

		expect(actions[0]).toMatchObject({
			type: "tool_finished",
			eventId: "evt-6",
			toolCallId: "call_1",
			toolName: "echo",
			isError: false,
		});
		expect(actions[1]).toMatchObject({ type: "message_committed", eventId: "evt-6" });
	});

	it("maps non-stream message-producing events", () => {
		const user = mapTypedEventToModeEvents(mkEvent("USER_MESSAGE", { content: "hello" }));
		expect(user[0]).toMatchObject({
			type: "message_committed",
			message: { role: "user", content: "hello" },
		});

		const bash = mapTypedEventToModeEvents(mkEvent("BASH_EXECUTION", {
			command: "npm test",
			output: "ok",
			exit_code: 0,
			duration_ms: 12,
			cwd: "/repo",
		}));
		expect(bash[0]).toMatchObject({
			type: "message_committed",
			message: { role: "bashExecution", command: "npm test", output: "ok", exitCode: 0 },
		});

		const custom = mapTypedEventToModeEvents(mkEvent("CUSTOM_MESSAGE", {
			extension_id: "ext",
			kind: "notice",
			data: "custom text",
			display: true,
		}));
		expect(custom[0]).toMatchObject({
			type: "message_committed",
			message: { role: "custom", customType: "ext:notice", content: "custom text", display: true },
		});

		const branch = mapTypedEventToModeEvents(mkEvent("BRANCH_SUMMARY", {
			summary: "branch summary",
			from_id: "entry-1",
		}));
		expect(branch[0]).toMatchObject({
			type: "message_committed",
			message: { role: "branchSummary", summary: "branch summary", fromId: "entry-1" },
		});

		const file = mapTypedEventToModeEvents(mkEvent("FILE_MUTATION_APPLIED", {
			path: "src/main.ts",
			operation: "modify",
		}));
		expect(file[0]).toMatchObject({
			type: "message_committed",
			message: { role: "custom", customType: "runtime:file_mutation" },
		});
	});

	it("maps turn, compaction, retry, and model actions", () => {
		expect(mapTypedEventToModeEvents(mkEvent("AGENT_TURN_START", { message_count: 3 }))).toEqual([{
			type: "turn_started",
			eventId: "evt-12",
			messageCount: 3,
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("AGENT_TURN_COMPLETED", {
			reason: "error",
			error_message: "failed",
		}))).toEqual([{
			type: "turn_completed",
			eventId: "evt-13",
			reason: "error",
			errorMessage: "failed",
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("COMPACTION_START", {
			token_count: 100,
			target_tokens: 50,
		}))).toEqual([{
			type: "compaction_started",
			eventId: "evt-14",
			tokenCount: 100,
			targetTokens: 50,
		}]);

		const compaction = mapTypedEventToModeEvents(mkEvent("COMPACTION_END", {
			summary: "summary",
			first_kept_event_id: "evt-keep",
			tokens_before: 100,
			tokens_after: 20,
		}));
		expect(compaction[0]).toMatchObject({
			type: "compaction_finished",
			eventId: "evt-15",
			summary: "summary",
		});
		expect(compaction[1]).toMatchObject({ type: "message_committed", eventId: "evt-15" });

		expect(mapTypedEventToModeEvents(mkEvent("RETRY_SCHEDULED", {
			attempt: 2,
			max_attempts: 3,
			delay_ms: 25,
			error_message: "retry me",
		}))).toEqual([{
			type: "retry_scheduled",
			eventId: "evt-16",
			attempt: 2,
			maxAttempts: 3,
			delayMs: 25,
			errorMessage: "retry me",
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("MODEL_CHANGED", {
			provider: "next",
			model_id: "next-model",
			previous_provider: "old",
			previous_model_id: "old-model",
		}))).toEqual([{
			type: "model_changed",
			eventId: "evt-17",
			provider: "next",
			modelId: "next-model",
			previousProvider: "old",
			previousModelId: "old-model",
		}]);
	});

	it("maps abort, config, and error actions", () => {
		expect(mapTypedEventToModeEvents(mkEvent("COMPACTION_ABORTED", {
			reason: "cancelled",
			message: "not now",
		}))).toEqual([{
			type: "compaction_aborted",
			eventId: "evt-18",
			reason: "cancelled",
			message: "not now",
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("RETRY_ABORTED", {
			attempt: 2,
			reason: "max_attempts",
			error_message: "done retrying",
		}))).toEqual([{
			type: "retry_aborted",
			eventId: "evt-19",
			attempt: 2,
			reason: "max_attempts",
			errorMessage: "done retrying",
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("THINKING_LEVEL_CHANGED", {
			level: "high",
			previous_level: "low",
		}))).toEqual([{
			type: "thinking_level_changed",
			eventId: "evt-20",
			level: "high",
			previousLevel: "low",
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("RUNTIME_ERROR", {
			error: "runtime failed",
			stack: "runtime stack",
		}))).toEqual([{
			type: "runtime_error",
			eventId: "evt-21",
			error: "runtime failed",
			stack: "runtime stack",
		}]);

		expect(mapTypedEventToModeEvents(mkEvent("AGENT_ERROR", {
			error: "agent failed",
			stack: "agent stack",
			retryable: true,
		}))).toEqual([{
			type: "agent_error",
			eventId: "evt-22",
			error: "agent failed",
			stack: "agent stack",
			retryable: true,
		}]);
	});

	it("ignores typed events that have no mode-facing action", () => {
		expect(mapTypedEventToModeEvents(mkEvent("SESSION_CREATED", {
			session_id: "sess_1",
			created_by: "user_explicit",
		}))).toEqual([]);
	});
});
