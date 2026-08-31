import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionManager } from "../src/core/projection/session-manager.js";

/**
 * Regression: saveSessionIndex used to delete every DB row not present in the
 * writing process's in-memory index ("delete stale"). With two processes on
 * the same workspace (CLI + gateway coexist by design), each persist wiped the
 * sessions the other process had created — last-writer-wins data loss.
 */
describe("session index multi-process safety", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("persisting one manager's index does not delete sessions created by another process", () => {
		dir = mkdtempSync(join(tmpdir(), "pizza-index-test-"));
		const dbPath = join(dir, "events.db");

		// Process A opens the workspace and creates a session.
		const storeA = new SqliteEventStore("ws-shared", dbPath);
		const managerA = new SessionManager(storeA, storeA);
		const sessA = managerA.createSession("user_explicit", "from-process-A");

		// Process B opens the same workspace — it loads A's index...
		const storeB = new SqliteEventStore("ws-shared", dbPath);
		const managerB = new SessionManager(storeB, storeB);
		// ...and creates its own session.
		const sessB = managerB.createSession("user_explicit", "from-process-B");

		// Process A (which knows nothing about B's session) persists again.
		const sessA2 = managerA.createSession("user_explicit", "from-process-A-2");

		// A fresh reader must see ALL sessions — nothing was deleted.
		const storeC = new SqliteEventStore("ws-shared", dbPath);
		const index = storeC.getSessionIndex();
		const ids = new Set((index?.sessions ?? []).map((s) => s.session_id));
		expect(ids.has(sessA.session_id)).toBe(true);
		expect(ids.has(sessB.session_id)).toBe(true);
		expect(ids.has(sessA2.session_id)).toBe(true);

		storeA.close();
		storeB.close();
		storeC.close();
	});

	it("generates crypto-random session ids (shape check)", () => {
		dir = mkdtempSync(join(tmpdir(), "pizza-index-test-"));
		const store = new SqliteEventStore("ws-ids", join(dir, "events.db"));
		const manager = new SessionManager(store, store);
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const desc = manager.createSession("user_explicit");
			expect(desc.session_id).toMatch(/^sess_[a-z0-9]+_[A-Za-z0-9]{8}$/);
			expect(seen.has(desc.session_id)).toBe(false);
			seen.add(desc.session_id);
		}
		store.close();
	});
});