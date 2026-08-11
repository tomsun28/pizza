/**
 * Gateway client — connects to the gateway daemon's Unix socket and provides a
 * typed `tell()` method for sending a message to another agent's workspace and
 * awaiting its reply.
 *
 * Used by the `_tell` built-in cli command (src/core/tools/tell.ts). The
 * lifecycle module ({@link ensureGateway}) guarantees the daemon is running
 * before the client connects.
 */

import { connect, type Socket } from "node:net";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import {
	type GatewayResponse,
	type GatewayTellResult,
	type MessageSource,
	GATEWAY_ASYNC_ACK_TIMEOUT,
	GATEWAY_DEFAULT_TELL_TIMEOUT,
} from "./protocol.js";

/** Options for {@link GatewayClient}. */
export interface GatewayClientOptions {
	/** Socket path to connect to. */
	socketPath: string;
	/** Connect timeout (ms), default 5000. */
	connectTimeout?: number;
}

/** A short-lived gateway client: connect → tell → disconnect. */
export class GatewayClient {
	private socket: Socket | null = null;
	private readonly socketPath: string;
	private readonly connectTimeout: number;
	private pending: Map<string, { resolve: (r: GatewayResponse) => void; reject: (e: Error) => void }> = new Map();
	private requestId = 0;
	private detachReader: (() => void) | null = null;

	constructor(options: GatewayClientOptions) {
		this.socketPath = options.socketPath;
		this.connectTimeout = options.connectTimeout ?? 5_000;
	}

	/** Connect to the gateway socket. */
	async connect(): Promise<void> {
		if (this.socket) return;
		await new Promise<void>((resolve, reject) => {
			const socket = connect(this.socketPath);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`gateway connect timeout (${this.socketPath})`));
			}, this.connectTimeout);

			socket.once("connect", () => {
				clearTimeout(timer);
				this.socket = socket;
				this.detachReader = attachJsonlLineReader(socket, (line) => this.handleLine(line));
				resolve();
			});
			socket.once("error", (err: Error) => {
				clearTimeout(timer);
				reject(new Error(`Failed to connect to gateway at ${this.socketPath}: ${err.message}`));
			});
		});
	}

	private handleLine(line: string): void {
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			return; // ignore malformed lines
		}
		const response = data as GatewayResponse;
		// tell_result carries an id we can correlate; pong/error are not correlated.
		if (response.type === "tell_result") {
			const id = response.id;
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				pending.resolve(response);
			}
		}
		// pong and error are not expected for the tell-only client.
	}

	/**
	 * Write a `tell` frame and resolve with the gateway's `tell_result`.
	 * `timeoutMs` bounds the wait for that result — the gateway enforces its own
	 * turn timeout, this only stops the client hanging if a response is lost.
	 */
	private sendTell(payload: Record<string, unknown>, id: string, timeoutMs: number, label: string): Promise<GatewayTellResult> {
		return new Promise<GatewayTellResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(label));
				}
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r as GatewayTellResult);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			try {
				this.socket!.write(`${serializeJsonLine(payload)}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/**
	 * Send a `tell` message to another agent workspace and wait for the reply.
	 * `from` carries the sender provenance ({@link MessageSource}); the gateway
	 * attaches it to the delivered prompt so the receiving agent knows who
	 * messaged it and can reply.
	 * Resolves with the target agent final assistant text. Throws on error.
	 */
	async tell(
		to: string,
		message: string,
		from: MessageSource,
		timeout: number = GATEWAY_DEFAULT_TELL_TIMEOUT,
	): Promise<string> {
		if (!this.socket) {
			throw new Error("GatewayClient is not connected — call connect() first");
		}
		const id = `t_${++this.requestId}`;
		const result = await this.sendTell(
			{ type: "tell", id, to, message, from, timeout },
			id,
			timeout + 5_000, // grace window beyond the gateway's own timeout
			`tell to "${to}" timed out after ${timeout}ms`,
		);
		if (!result.ok) {
			throw new Error(result.error);
		}
		if (!("reply" in result)) {
			// An async ack should not reach the sync tell path; stay defensive.
			throw new Error("unexpected async delivery ack on a synchronous tell");
		}
		return result.reply;
	}

	/**
	 * Send a tell without waiting for the target agent to finish its turn. The
	 * gateway acks as soon as the target has accepted the prompt and resolves
	 * with the assigned messageId (the receiver is expected to reply on its own
	 * via a tell back to `from`). Symmetric, non-blocking messaging.
	 */
	async tellAsync(to: string, message: string, from: MessageSource): Promise<string> {
		if (!this.socket) {
			throw new Error("GatewayClient is not connected — call connect() first");
		}
		const id = `t_${++this.requestId}`;
		const result = await this.sendTell(
			{ type: "tell", id, to, message, from, async: true },
			id,
			GATEWAY_ASYNC_ACK_TIMEOUT,
			`tellAsync to "${to}" timed out waiting for the delivery ack`,
		);
		if (!result.ok) {
			throw new Error(result.error);
		}
		if (!("messageId" in result)) {
			// A sync reply should not reach the async path; stay defensive.
			throw new Error("unexpected synchronous reply on an async tell");
		}
		return result.messageId;
	}

	/** Close the connection. Safe to call multiple times. */
	async disconnect(): Promise<void> {
		this.detachReader?.();
		this.detachReader = null;
		// Reject any in-flight requests.
		for (const [, pending] of this.pending) {
			pending.reject(new Error("gateway client disconnected"));
		}
		this.pending.clear();
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
	}
}