import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRuntimeAdapter } from "../src/core/runtime/local-runtime.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import type { ToolExecutor, ToolRegistry } from "../src/core/intent/types.js";

describe("LocalRuntimeAdapter", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	it("executes tools through the registry", async () => {
		const cwd = makeTempDir();
		const registry: ToolRegistry = {
			get(name: string): ToolExecutor | undefined {
				if (name !== "echo") return undefined;
				return {
					async execute(args) {
						return { content: [{ type: "text", text: String(args.text) }], is_error: false };
					},
					getMetadata() {
						return { name, category: "file_read", defaultRisk: "safe" };
					},
				};
			},
			list() {
				return ["echo"];
			},
		};
		const runtime = new LocalRuntimeAdapter({
			workspace_id: "ws_test",
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
		});

		const result = await runtime.executeTool({
			tool_call_id: "call_1",
			tool_name: "echo",
			arguments: { text: "hello" },
		});

		expect(result).toEqual({ content: [{ type: "text", text: "hello" }], is_error: false });
		await expect(runtime.getStatus()).resolves.toMatchObject({ status: "idle", kind: "local" });
	});

	it("creates checkpoint manifests with workspace file hashes", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "a.txt"), "alpha");
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "b.txt"), "beta");

		const runtime = new LocalRuntimeAdapter({
			workspace_id: "ws_checkpoint",
			cwd,
			agentDir: cwd,
			toolRegistry: { get: () => undefined, list: () => [] },
		});

		const checkpoint = await runtime.createCheckpoint({
			cwd,
			event_head: "evt_1",
			event_head_sequence: 42,
			label: "before edit",
		});

		expect(existsSync(checkpoint.path)).toBe(true);
		const manifest = JSON.parse(readFileSync(checkpoint.path, "utf8")) as {
			checkpoint_id: string;
			workspace_hash: string;
			files: Array<{ path: string; hash: string; size: number }>;
		};
		expect(manifest.checkpoint_id).toBe(checkpoint.checkpoint_id);
		expect(manifest.workspace_hash).toHaveLength(64);
		expect(manifest.files.map((file) => file.path)).toEqual(["a.txt", "src/b.txt"]);

		await expect(runtime.restoreCheckpoint(checkpoint)).resolves.toBeUndefined();
	});

	it("records checkpoint lifecycle events through EventSourcedRuntime", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "source.ts"), "export const value = 1;\n");

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: { get: () => undefined, list: () => [] },
			llmClient: {
				async complete() {
					return {
						content: [],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "stop",
					};
				},
			},
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		expect(runtime.store).toBeInstanceOf(SqliteEventStore);
		const checkpoint = await runtime.createCheckpoint("before change");
		await runtime.restoreCheckpoint(checkpoint);

		expect(runtime.store.query({ types: ["RUNTIME_STARTED"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["CHECKPOINT_CREATED"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["CHECKPOINT_RESTORED"] })).toHaveLength(1);
		await expect(runtime.getRuntimeStatus()).resolves.toMatchObject({ kind: "local", status: "idle" });
		runtime.dispose();
	});
});
