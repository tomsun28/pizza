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
} from "./protocol.js";

/** Options for {@link GatewayClient}. */
export interface GatewayClientOptions {
	/** Socket path to connect to. */
	socketPath: string;
	/** Connect timeout (ms), default 5000. */
	connectTimeout?: number;
}

/** The outcome of a delivered tell: a delivery ack (current gateways) or,
 * for legacy gateways that answered synchronously, the reply itself. */
export type TellDelivery = { messageId: string; reply?: undefined } | { reply: string; messageId?: undefined };

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
	 * Deliver a `tell` message to another agent workspace. Delivery is always
	 * asynchronous: the gateway acks as soon as the target has accepted the
	 * message (prompted or queued as a follow-up) and resolves here with the
	 * assigned messageId. The target agent's final reply is relayed back to the
	 * sender automatically by the gateway as an inbound `<message>` turn.
	 *
	 * `from` carries the sender provenance ({@link MessageSource}); the gateway
	 * attaches it to the delivered prompt so the receiving agent knows who
	 * messaged it (and where to reply).
	 */
	async tell(to: string, message: string, from: MessageSource): Promise<TellDelivery> {
		if (!this.socket) {
			throw new Error("GatewayClient is not connected — call connect() first");
		}
		const id = `t_${++this.requestId}`;
		const result = await this.sendTell(
			{ type: "tell", id, to, message, from },
			id,
			GATEWAY_ASYNC_ACK_TIMEOUT,
			`tell to "${to}" timed out after ${GATEWAY_ASYNC_ACK_TIMEOUT}ms — the message may still have been delivered (the target agent may be busy with a long turn); do not blindly resend`,
		);
		if (!result.ok) {
			throw new Error(result.error);
		}
		if ("messageId" in result) {
			return { messageId: result.messageId };
		}
		// Legacy gateway that still answers synchronously with the reply text.
		return { reply: result.reply };
	}

	/**
	 * @deprecated Delivery is always asynchronous now — identical to
	 * {@link tell}. Kept so older callers keep compiling.
	 */
	async tellAsync(to: string, message: string, from: MessageSource): Promise<TellDelivery> {
		return this.tell(to, message, from);
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