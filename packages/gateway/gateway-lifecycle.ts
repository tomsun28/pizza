/**
 * Gateway lifecycle — ensure the gateway daemon is running before a client
 * connects, auto-starting it on demand (like `ssh-agent`).
 *
 * The flow from the client side (e.g. the `_tell` tool):
 *   1. Check if the socket exists and a gateway responds to `ping`.
 *   2. If not, spawn `pizza --mode gateway` as a detached background process
 *      and wait for the socket to appear.
 *   3. Return the socket path so the client can connect.
 *
 * The gateway daemon itself is implemented in gateway-server.ts and started by
 * main.ts when invoked with `--mode gateway`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { serializeJsonLine } from "./jsonl.js";
import { gatewaySocketPath } from "./gateway-server.js";

/** How long to wait for a freshly-spawned gateway to bind its socket (ms). */
const GATEWAY_BOOT_TIMEOUT = 15_000;
/** How often to poll for the socket / ping the gateway (ms). */
const GATEWAY_POLL_INTERVAL = 100;

/**
 * Resolve the CLI entry point for spawning the gateway daemon. Same logic as
 * delegate-agent.ts and gateway-server.ts.
 */
function resolveCliSpawn(): { cliPath: string; binary: boolean } {
	const argv1 = process.argv[1] ?? "";
	const isBinary = !argv1.endsWith(".js");
	return {
		cliPath: isBinary ? process.execPath : argv1,
		binary: isBinary,
	};
}

/** PING the gateway at `socketPath`. Returns true if it responds with pong. */
async function pingGateway(socketPath: string, timeoutMs = 2_000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);

		socket.once("connect", () => {
			try {
				socket.write(`${serializeJsonLine({ type: "ping" })}\n`);
			} catch {
				clearTimeout(timer);
				socket.destroy();
				resolve(false);
			}
		});
		socket.once("error", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(false);
		});
		// Read the first line; if it's pong we're good.
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex);
				clearTimeout(timer);
				socket.destroy();
				try {
					const parsed = JSON.parse(line) as { type?: string };
					resolve(parsed.type === "pong");
				} catch {
					resolve(false);
				}
			}
		});
	});
}

/**
 * Spawn the gateway as a detached background process. Returns the
 * ChildProcess; the caller does not wait for it.
 *
 * The gateway inherits PIZZA_AGENT_DIR from the environment so spawned
 * sub-agents share the caller's auth/models.
 */
function spawnGateway(socketPath: string, agentDir: string): ChildProcess {
	const { cliPath, binary } = resolveCliSpawn();
	const args = ["--mode", "gateway"];
	// Pass the socket path via env so the daemon picks it up.
	const env: Record<string, string> = {
		...process.env,
		PIZZA_AGENT_DIR: agentDir,
		PIZZA_GATEWAY_SOCKET: socketPath,
	} as Record<string, string>;
	const command = binary ? cliPath : "node";
	const commandArgs = binary ? args : [cliPath, ...args];

	const child = spawn(command, commandArgs, {
		detached: true,
		stdio: "ignore",
		env,
	});
	// Detach so the gateway outlives the parent process.
	child.unref();
	return child;
}

/**
 * Ensure the gateway daemon is running and reachable. If it's not, spawn it
 * and wait for the socket to become responsive. Returns the socket path.
 *
 * @param agentDir The agent config directory (shared with sub-agents).
 * @param socketPath Optional explicit socket path (default: standard location).
 */
export async function ensureGateway(agentDir: string, socketPath?: string): Promise<string> {
	const sock = socketPath ?? gatewaySocketPath();

	// Fast path: already running?
	if (existsSync(sock) && (await pingGateway(sock))) {
		return sock;
	}

	// Spawn the daemon and wait for it to bind.
	spawnGateway(sock, agentDir);

	const deadline = Date.now() + GATEWAY_BOOT_TIMEOUT;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, GATEWAY_POLL_INTERVAL));
		if (existsSync(sock) && (await pingGateway(sock))) {
			return sock;
		}
	}

	throw new Error(
		`Gateway failed to start within ${GATEWAY_BOOT_TIMEOUT / 1000}s (socket: ${sock}). ` +
			"Try running `pizza --mode gateway` manually to see the error.",
	);
}