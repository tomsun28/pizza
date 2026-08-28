/**
 * Subscriber fan-out must be fault-isolated.
 *
 * `_notify` called every subscriber handler bare. Because store subscribers are
 * what drive the reactor and the UI — and because they are invoked synchronously
 * from inside `append()` — a single throwing subscriber would (a) starve every
 * subscriber registered after it and (b) propagate the exception out of
 * `append()`, tearing down whatever agent operation was writing the event.
 *
 * A rendering bug in the UI must never be able to break the agent loop, so the
 * store now isolates each handler the same way the event bus does.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import type { EventBase } from "../src/core/event-store/types.js";

describe("SqliteEventStore — subscriber isolation", () => {
	const testDir = join(tmpdir(), ".test-pizza-subscriber-isolation", String(Date.now()));
	const stores: SqliteEventStore[] = [];

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function makeStore(name: string): SqliteEventStore {
		const store = new SqliteEventStore("ws-isolation", join(testDir, `${name}.db`));
		stores.push(store);
		return store;
	}

	it("keeps delivering to later subscribers after one throws", () => {
		const store = makeStore("fanout");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const seenBefore: string[] = [];
		const seenAfter: string[] = [];

		store.subscribe((event: EventBase) => seenBefore.push(event.type));
		store.subscribe(() => {
			throw new Error("subscriber blew up");
		});
		store.subscribe((event: EventBase) => seenAfter.push(event.type));

		expect(() =>
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "hi" } }),
		).not.toThrow();

		// The subscriber registered after the faulty one still got the event.
		expect(seenBefore).toEqual(["USER_MESSAGE"]);
		expect(seenAfter).toEqual(["USER_MESSAGE"]);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("still persists the event when a subscriber throws", () => {
		const store = makeStore("persist");
		vi.spyOn(console, "error").mockImplementation(() => {});

		store.subscribe(() => {
			throw new Error("subscriber blew up");
		});

		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "persisted?" } });

		const stored = store.query({ types: ["USER_MESSAGE"] });
		expect(stored).toHaveLength(1);
		expect((stored[0].payload as { content: string }).content).toBe("persisted?");
	});

	it("isolates failures on the non-persisted streaming chunk path too", () => {
		const store = makeStore("chunk");
		vi.spyOn(console, "error").mockImplementation(() => {});

		const delivered: string[] = [];
		store.subscribe(() => {
			throw new Error("chunk subscriber blew up");
		});
		store.subscribe((event: EventBase) => delivered.push(event.type));

		expect(() =>
			store.append({ actor_id: "coder_agent", type: "AGENT_MESSAGE_CHUNK", payload: { delta: "tok" } }),
		).not.toThrow();

		expect(delivered).toEqual(["AGENT_MESSAGE_CHUNK"]);
	});
});