/**
 * Global test isolation: point every path that Pizza writes at run time
 * (~/.pizza and ~/.pizza/agent) into a per-worker temp directory.
 *
 * Without this, any test that touches SqliteEventStore / SchedulerEngine /
 * SettingsManager with default paths silently litters the REAL user home:
 * we once accumulated 39 ~/.pizza/workspaces/rpc-facade-* scheduler dirs and
 * 246 empty ~/.pizza/agent/workspaces/rpc-facade-* dirs from test runs.
 *
 * Individual tests may still override these vars (they save/restore in
 * their own beforeEach/afterEach), which is fine — the value here is just
 * the safe default.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `pizza-test-home-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(root, "agent"), { recursive: true });

process.env.PIZZA_HOME = root;
// config.ts: ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`
process.env.PIZZA_CODING_AGENT_DIR = join(root, "agent");

// Best-effort cleanup when the worker exits.
process.on("exit", () => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		/* temp dir cleanup is best-effort */
	}
});