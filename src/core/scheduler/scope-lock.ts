/**
 * Cross-process scheduler scope lock.
 *
 * Problem: multiple Pizza processes (e.g. an orphaned agent from a previous
 * GUI run plus a freshly spawned one) can load the SAME scope's tasks.json
 * and each run a live SchedulerEngine — every task then fires once per
 * process ("double dispatch"), and whichever process persists last wins,
 * silently reverting external edits.
 *
 * Fix: a per-scope lock file (`scheduler/engine.lock`) containing the owner
 * pid + a heartbeat timestamp. Only the lock holder schedules timers; other
 * engines run in "passive" mode (CRUD still works — it writes tasks.json,
 * which the active engine re-reads before each fire).
 *
 * Staleness: a lock is stale when the owner pid is dead OR the heartbeat is
 * older than STALE_MS (covers zombie/unkillable-pid edge cases). The holder
 * refreshes the heartbeat every HEARTBEAT_MS.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 90_000;

interface LockFile {
	pid: number;
	acquiredAt: number;
	heartbeatAt: number;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means the process exists but we can't signal it.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLock(path: string): LockFile | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as LockFile;
		if (typeof parsed.pid !== "number" || typeof parsed.heartbeatAt !== "number") return null;
		return parsed;
	} catch {
		return null; // corrupt lock = stale
	}
}

export class SchedulerScopeLock {
	private readonly path: string;
	private readonly now: () => number;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private held = false;
	/** Called when the heartbeat discovers the lock was taken over (e.g.
	 * after a long process suspend). The engine wires this to demote itself
	 * to passive so it stops dispatching timers. */
	public onLost: (() => void) | null = null;

	constructor(schedulerDir: string, now: () => number = Date.now) {
		this.path = join(schedulerDir, "engine.lock");
		this.now = now;
	}

	/**
	 * Try to become the active engine for this scope.
	 * Returns true when acquired (or already held by this instance);
	 * false when another live process holds the lock.
	 */
	tryAcquire(): boolean {
		if (this.held) return true;
		// Exclusive create is the ONLY acquisition path — `wx` fails with
		// EEXIST when the file exists, so two processes can never both
		// "read stale → overwrite" (the TOCTOU the old read-then-write had).
		// A stale lock is first renamed away: rename is atomic, exactly one
		// contender succeeds, the loser re-reads and sees the winner's lock.
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.tryExclusiveCreate()) {
				this.held = true;
				this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
				this.heartbeatTimer.unref?.();
				return true;
			}
			const existing = readLock(this.path);
			// Corrupt lock (readLock null but file exists) counts as stale and
			// falls through to the rename-away below. A vanished file (deleted
			// between create attempt and read) just retries the create.
			if (!existing && !existsSync(this.path)) continue;
			if (existing && existing.pid !== process.pid) {
				const fresh = this.now() - existing.heartbeatAt < STALE_MS;
				if (fresh && isPidAlive(existing.pid)) return false;
			}
			// Stale, dead, or our own leftover from a previous run: claim the
			// right to replace it by renaming it away. Only one process can
			// rename the same file — the loser hits ENOENT and retries.
			try {
				const tomb = `${this.path}.stale.${process.pid}`;
				renameSync(this.path, tomb);
				try { unlinkSync(tomb); } catch { /* best-effort */ }
			} catch {
				// Someone else claimed it first — loop and re-evaluate.
			}
		}
		return false;
	}

	/** Attempt to create the lock file exclusively. True on success. */
	private tryExclusiveCreate(): boolean {
		try {
			mkdirSync(join(this.path, ".."), { recursive: true });
			const data: LockFile = { pid: process.pid, acquiredAt: this.now(), heartbeatAt: this.now() };
			writeFileSync(this.path, JSON.stringify(data), { encoding: "utf-8", flag: "wx" });
			return true;
		} catch {
			return false; // EEXIST (or fs error) — not acquired
		}
	}

	/**
	 * Heartbeat: refresh heartbeatAt — but only while the lock file still
	 * belongs to this process. After a long suspend (laptop lid) another
	 * engine may have legitimately taken over; blindly overwriting would
	 * steal the lock back and resurrect double-dispatch.
	 */
	private heartbeat(): void {
		const existing = readLock(this.path);
		if (!existing || existing.pid !== process.pid) {
			// Lost the lock (takeover or deletion) — demote to passive.
			this.held = false;
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = undefined;
			}
			this.onLost?.();
			return;
		}
		try {
			const data: LockFile = { pid: process.pid, acquiredAt: existing.acquiredAt, heartbeatAt: this.now() };
			writeFileSync(this.path, JSON.stringify(data), "utf-8");
		} catch {
			/* best-effort — a failed heartbeat only risks a takeover */
		}
	}

	/** Pid of the current holder, when someone else owns the lock. */
	holderPid(): number | null {
		const existing = readLock(this.path);
		return existing && existing.pid !== process.pid ? existing.pid : null;
	}

	get isHeld(): boolean {
		return this.held;
	}

	release(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		if (!this.held) return;
		this.held = false;
		const existing = readLock(this.path);
		if (existing?.pid === process.pid) {
			try {
				unlinkSync(this.path);
			} catch {
				/* best-effort */
			}
		}
	}

}