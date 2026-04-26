/**
 * Intent Executor tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { JsonlEventStore } from "../src/core/event-store/jsonl-store.js";
import { IntentExecutor } from "../src/core/intent/executor.js";
import { IntentClassifier } from "../src/core/intent/classifier.js";
import type { ToolRegistry, ToolExecutor, ToolExecutionResult, ToolMetadata } from "../src/core/intent/types.js";
import type { RuntimeAdapter, ToolExecutionRequest } from "../src/core/runtime/types.js";

// Mock tool registry
function createMockToolRegistry(tools: Record<string, (args: Record<string, unknown>) => Promise<ToolExecutionResult>>): ToolRegistry {
	const registry: ToolRegistry = {
		get(name: string): ToolExecutor | undefined {
			const fn = tools[name];
			if (!fn) return undefined;
			return {
				execute: fn,
				getMetadata: () => ({ name, category: "file_read", defaultRisk: "safe" }) as ToolMetadata,
			};
		},
		list(): string[] {
			return Object.keys(tools);
		},
	};
	return registry;
}

describe("IntentExecutor", () => {
	const testDir = join(tmpdir(), ".test-pizza-executor", String(Date.now()));
	let store: JsonlEventStore;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		store = new JsonlEventStore("test-ws", testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should execute a safe tool without approval", async () => {
		const toolRegistry = createMockToolRegistry({
			read: async (args) => ({
				content: [{ type: "text", text: `contents of ${args.path}` }],
				is_error: false,
			}),
		});

		const classifier = new IntentClassifier();
		const executor = new IntentExecutor(store, classifier, toolRegistry);

		const result = await executor.execute({
			tool_call_id: "call_1",
			tool_name: "read",
			arguments: { path: "/some/file.ts" },
		});

		expect(result.is_error).toBe(false);
		expect(result.content[0]).toHaveProperty("text");
		expect((result.content[0] as { text: string }).text).toContain("contents of /some/file.ts");

		// Should have emitted INTENT_TOOL_CALL, TOOL_EXECUTION_START, TOOL_EXECUTION_END
		const events = store.query({ types: ["INTENT_TOOL_CALL"] });
		expect(events.length).toBe(1);

		const execEvents = store.query({ types: ["TOOL_EXECUTION_START", "TOOL_EXECUTION_END"] });
		expect(execEvents.length).toBe(2);

		executor.dispose();
	});

	it("should delegate tool execution to runtime adapter", async () => {
		const toolRegistry = createMockToolRegistry({
			read: async () => {
				throw new Error("tool registry should not execute directly");
			},
		});
		const requests: ToolExecutionRequest[] = [];
		const runtime: RuntimeAdapter = {
			runtime_id: "test_runtime",
			workspace_id: "test-ws",
			kind: "local",
			async executeTool(request) {
				requests.push(request);
				return { content: [{ type: "text", text: "from runtime" }], is_error: false };
			},
			async createCheckpoint() {
				throw new Error("not used");
			},
			async restoreCheckpoint() {},
			async getStatus() {
				return {
					runtime_id: "test_runtime",
					workspace_id: "test-ws",
					kind: "local",
					cwd: testDir,
					status: "idle",
				};
			},
		};

		const executor = new IntentExecutor(store, new IntentClassifier(), toolRegistry, undefined, runtime);
		const result = await executor.execute({
			tool_call_id: "call_runtime",
			tool_name: "read",
			arguments: { path: "file.ts" },
		});

		expect(result.is_error).toBe(false);
		expect((result.content[0] as { text: string }).text).toBe("from runtime");
		expect(requests).toEqual([
			{
				tool_call_id: "call_runtime",
				tool_name: "read",
				arguments: { path: "file.ts" },
				caused_by: expect.any(String),
			},
		]);

		executor.dispose();
	});

	it("should return error for unknown tool", async () => {
		const toolRegistry = createMockToolRegistry({});
		const classifier = new IntentClassifier({ approve_unknown: false }); // auto-approve unknown
		const executor = new IntentExecutor(store, classifier, toolRegistry);

		const result = await executor.execute({
			tool_call_id: "call_1",
			tool_name: "nonexistent",
			arguments: {},
		});

		expect(result.is_error).toBe(true);
		expect(result.error_message).toContain("Unknown tool");

		executor.dispose();
	});

	it("should handle tool execution errors gracefully", async () => {
		const toolRegistry = createMockToolRegistry({
			failing_tool: async () => {
				throw new Error("Something went wrong");
			},
		});

		const classifier = new IntentClassifier({ approve_unknown: false }); // auto-approve
		const executor = new IntentExecutor(store, classifier, toolRegistry);

		const result = await executor.execute({
			tool_call_id: "call_1",
			tool_name: "failing_tool",
			arguments: {},
		});

		expect(result.is_error).toBe(true);
		expect(result.error_message).toContain("Something went wrong");

		// Should still emit TOOL_EXECUTION_END with is_error=true
		const endEvents = store.query({ types: ["TOOL_EXECUTION_END"] });
		expect(endEvents.length).toBe(1);
		expect((endEvents[0].payload as { is_error: boolean }).is_error).toBe(true);

		executor.dispose();
	});

	it("should wait for approval on dangerous tools", async () => {
		const toolRegistry = createMockToolRegistry({
			bash: async (args) => ({
				content: [{ type: "text", text: `executed: ${args.command}` }],
				is_error: false,
			}),
		});

		const classifier = new IntentClassifier();
		const executor = new IntentExecutor(store, classifier, toolRegistry);

		// Start execution (will block waiting for approval)
		const resultPromise = executor.execute({
			tool_call_id: "call_1",
			tool_name: "bash",
			arguments: { command: "rm -rf /tmp/test" },
		});

		// Should have a pending approval
		expect(executor.pendingCount).toBe(1);

		// Find the intent event
		const intentEvents = store.query({ types: ["INTENT_TOOL_CALL"] });
		expect(intentEvents.length).toBe(1);
		const intentEventId = intentEvents[0].event_id;

		// Approve it
		store.append({
			actor_id: "user",
			type: "USER_APPROVAL",
			payload: { intent_event_id: intentEventId },
		});

		// Now the execution should complete
		const result = await resultPromise;
		expect(result.is_error).toBe(false);
		expect((result.content[0] as { text: string }).text).toContain("executed: rm -rf /tmp/test");
		expect(executor.pendingCount).toBe(0);

		executor.dispose();
	});

	it("should reject tool execution on user rejection", async () => {
		const toolRegistry = createMockToolRegistry({
			bash: async (args) => ({
				content: [{ type: "text", text: `executed: ${args.command}` }],
				is_error: false,
			}),
		});

		const classifier = new IntentClassifier();
		const executor = new IntentExecutor(store, classifier, toolRegistry);

		// Start execution (will block waiting for approval)
		const resultPromise = executor.execute({
			tool_call_id: "call_1",
			tool_name: "bash",
			arguments: { command: "rm -rf /tmp/test" },
		});

		// Find the intent event and reject it
		const intentEvents = store.query({ types: ["INTENT_TOOL_CALL"] });
		const intentEventId = intentEvents[0].event_id;

		store.append({
			actor_id: "user",
			type: "USER_REJECTION",
			payload: { intent_event_id: intentEventId },
		});

		const result = await resultPromise;
		expect(result.is_error).toBe(true);
		expect(result.error_message).toContain("rejected");
		expect(executor.pendingCount).toBe(0);

		executor.dispose();
	});

	it("should cancel all pending approvals on dispose", async () => {
		const toolRegistry = createMockToolRegistry({
			bash: async (args) => ({
				content: [{ type: "text", text: "done" }],
				is_error: false,
			}),
		});

		const classifier = new IntentClassifier();
		const executor = new IntentExecutor(store, classifier, toolRegistry);

		// Start a dangerous execution
		const resultPromise = executor.execute({
			tool_call_id: "call_1",
			tool_name: "bash",
			arguments: { command: "sudo rm -rf /" },
		});

		expect(executor.pendingCount).toBe(1);

		// Cancel all pending
		executor.cancelAllPending();
		expect(executor.pendingCount).toBe(0);

		// Should resolve as rejected
		const result = await resultPromise;
		expect(result.is_error).toBe(true);

		executor.dispose();
	});

	it("should execute direct tool calls without intent event", async () => {
		const toolRegistry = createMockToolRegistry({
			read: async (args) => ({
				content: [{ type: "text", text: `file: ${args.path}` }],
				is_error: false,
			}),
		});

		const classifier = new IntentClassifier();
		const executor = new IntentExecutor(store, classifier, toolRegistry);

		const result = await executor.executeDirect("read", { path: "/test.ts" });
		expect(result.is_error).toBe(false);
		expect((result.content[0] as { text: string }).text).toContain("file: /test.ts");

		// Should have TOOL_EXECUTION_START and TOOL_EXECUTION_END but no INTENT_TOOL_CALL
		const intentEvents = store.query({ types: ["INTENT_TOOL_CALL"] });
		expect(intentEvents.length).toBe(0);

		const execEvents = store.query({ types: ["TOOL_EXECUTION_START", "TOOL_EXECUTION_END"] });
		expect(execEvents.length).toBe(2);

		executor.dispose();
	});

	it("should record duration_ms in TOOL_EXECUTION_END", async () => {
		const toolRegistry = createMockToolRegistry({
			read: async () => {
				await new Promise((r) => setTimeout(r, 10));
				return { content: [{ type: "text", text: "done" }], is_error: false };
			},
		});

		const classifier = new IntentClassifier();
		const executor = new IntentExecutor(store, classifier, toolRegistry);

		await executor.execute({
			tool_call_id: "call_1",
			tool_name: "read",
			arguments: { path: "/test.ts" },
		});

		const endEvents = store.query({ types: ["TOOL_EXECUTION_END"] });
		expect(endEvents.length).toBe(1);
		const payload = endEvents[0].payload as { duration_ms: number };
		expect(payload.duration_ms).toBeGreaterThanOrEqual(10);

		executor.dispose();
	});
});
