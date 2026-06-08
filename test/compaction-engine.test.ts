import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { CompactionEngine } from "../src/core/compaction/compaction-engine.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";

function createProjection(store: SqliteEventStore): SessionProjection {
	const descriptor: SessionDescriptor = {
		session_id: "sess_test",
		workspace_id: store.workspace_id,
		event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
		created_by: "user_explicit",
		created_at: Date.now(),
	};
	return new SessionProjection(store, descriptor);
}

function appendAssistant(store: SqliteEventStore, text: string): void {
	store.append({
		actor_id: "coder_agent",
		type: "AGENT_MESSAGE_END",
		payload: {
			content: [{ type: "text", text }],
			model: { provider: "test", model_id: "test" },
			usage: { input: 100, output: 50, cache_read: 0, cache_write: 0, total: 150, cost: 0 },
			stop_reason: "stop",
		},
	});
}

describe("CompactionEngine", () => {
	it("generates a summary and returns an event boundary without deleting events", async () => {
		const store = new SqliteEventStore("compaction-engine", ":memory:");
		const oldMessage = "old context ".repeat(80);
		const first = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: oldMessage } });
		appendAssistant(store, "old answer ".repeat(40));
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "recent request" } });
		appendAssistant(store, "recent answer");

		let prompt = "";
		const llmClient: LLMClient = {
			async complete(request): Promise<LLMResponse> {
				const message = request.messages[0];
				prompt = typeof message.content === "string" ? message.content : message.content.map((block) => "text" in block ? block.text : "").join("\n");
				return {
					content: [{ type: "text", text: "## Goal\nSummarized old context" }],
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const engine = new CompactionEngine({
			store,
			projection: createProjection(store),
			llmClient,
			model: { provider: "test", model_id: "test" },
			settings: { keepRecentTokens: 10 },
		});

		const result = await engine.compact("manual", new AbortController().signal);

		expect(result.summary).toContain("Summarized old context");
		expect(result.first_kept_event_id).toBe(kept.event_id);
		expect(result.tokens_before).toBeGreaterThan(0);
		expect(result.tokens_after).toBeGreaterThan(0);
		expect(store.get(first.event_id)).toBeDefined();
		expect(prompt).toContain("<conversation>");
		expect(prompt).toContain(oldMessage.trim());
		store.close();
	});

	it("updates an existing compaction summary on subsequent compactions", async () => {
		const store = new SqliteEventStore("compaction-engine-previous", ":memory:");
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "kept old request" } });
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Previous summary",
				first_kept_event_id: kept.event_id,
				tokens_before: 5000,
				tokens_after: 500,
			},
		});
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "new context ".repeat(80) } });
		appendAssistant(store, "new answer ".repeat(40));
		const recent = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "recent request" } });
		appendAssistant(store, "recent answer");

		let prompt = "";
		const llmClient: LLMClient = {
			async complete(request): Promise<LLMResponse> {
				const message = request.messages[0];
				prompt = typeof message.content === "string" ? message.content : message.content.map((block) => "text" in block ? block.text : "").join("\n");
				return {
					content: [{ type: "text", text: "Updated summary" }],
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const engine = new CompactionEngine({
			store,
			projection: createProjection(store),
			llmClient,
			model: { provider: "test", model_id: "test" },
			settings: { keepRecentTokens: 10 },
		});

		const result = await engine.compact("threshold", new AbortController().signal);

		expect(result.summary).toBe("Updated summary");
		expect(result.first_kept_event_id).toBe(recent.event_id);
		expect(prompt).toContain("<previous-summary>");
		expect(prompt).toContain("Previous summary");
		store.close();
	});
});
