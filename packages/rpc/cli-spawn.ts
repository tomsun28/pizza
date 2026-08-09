/**
 * Resolve the CLI entry point for spawning a Pizza process — either a pooled
 * sub-agent or the gateway daemon.
 *
 * In node mode `process.argv[1]` is the absolute path to the running `cli.js`,
 * so the process is spawned as `node <cli.js>`. In binary mode (a bun
 * `--compile` build) `process.execPath` is the compiled executable itself and
 * `process.argv[1]` does not end in `.js` — the binary must be spawned directly
 * without a `node` prefix.
 *
 * Shared by the gateway server (spawning pooled sub-agents) and the gateway
 * lifecycle module (spawning the daemon). The RPC client consumes the resolved
 * `cliPath`/`binary` via its options.
 */
export function resolveCliSpawn(): { cliPath: string; binary: boolean } {
	const argv1 = process.argv[1] ?? "";
	const isBinary = !argv1.endsWith(".js");
	return {
		cliPath: isBinary ? process.execPath : argv1,
		binary: isBinary,
	};
}
