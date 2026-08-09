/**
 * Integration test for the gateway server — verifies socket binding, ping/pong
 * health check, and clean shutdown. Does NOT test agent spawning (that requires
 * a real LLM); the tell path is exercised by the manual smoke test.
 */

import { describe, it, expect, afterEach } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, type GatewayServer } from "../packages/gateway/gateway-server.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";

function uniqueSocketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pizza-gw-"));
	return join(dir, "gateway.sock");
}

async function sendAndWait(socketPath: string, message: object, timeoutMs = 3000): Promise<string> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath);
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("timeout waiting for gateway response"));
		}, timeoutMs);
		sock.once("connect", () => {
			sock.write(`${serializeJsonLine(message)}\n`);
		});
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			if (buf.includes("\n")) {
				clearTimeout(timer);
				sock.destroy();
				resolve(buf.trim());
			}
		});
		sock.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

describe("gateway server", () => {
	let server: GatewayServer | undefined;
	const sockets: string[] = [];

	afterEach(async () => {
		if (server) {
			await server.stop().catch(() => {});
			server = undefined;
		}
		for (const sock of sockets) {
			rmSync(sock, { recursive: true, force: true });
		}
		sockets.length = 0;
	});

	it("binds a socket and responds to ping with pong", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();

		const response = await sendAndWait(socketPath, { type: "ping" });
		expect(JSON.parse(response)).toEqual({ type: "pong" });
	});

	it("returns an error for unknown message types", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();

		const response = await sendAndWait(socketPath, { type: "bogus" });
		const parsed = JSON.parse(response);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("bogus");
	});

	it("rejects tell without an id", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();

		const response = await sendAndWait(socketPath, { type: "tell", to: "x", message: "y" });
		const parsed = JSON.parse(response);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("id");
	});

	it("stops cleanly and removes the socket file", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();
		await server.stop();
		server = undefined;
		// After stop, a new connection should fail.
		await expect(sendAndWait(socketPath, { type: "ping" })).rejects.toThrow();
	});
});