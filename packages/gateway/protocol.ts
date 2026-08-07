/**
 * Gateway wire protocol — dependency-free types shared by the gateway server
 * (a long-running daemon) and its clients (the `_tell` tool inside an agent,
 * and eventually the desktop bridge / CLI).
 *
 * The gateway is a single Unix-socket (or Windows named-pipe) server that:
 *   1. Owns a pool of agent processes (one per workspace cwd), reusing the
 *      existing {@link RpcClient} infrastructure so a repeat `_tell` to the
 *      same workspace does NOT spawn a fresh agent each time.
 *   2. Routes messages between agents (the router pattern): no agent talks to
 *      another agent directly — every message flows through the gateway.
 *
 * Protocol: newline-delimited JSON (JSONL) over a single connection.
 *
 *   Client → Gateway:
 *     { "type": "tell",  "id": "req_1", "to": "<cwd|name>", "message": "...", "timeout": 60000 }
 *     { "type": "ping" }
 *
 *   Gateway → Client:
 *     { "type": "tell_result", "id": "req_1", "ok": true, "reply": "..." }
 *     { "type": "tell_result", "id": "req_1", "ok": false, "error": "..." }
 *     { "type": "pong" }
 *     { "type": "error",  "message": "..." }
 */

/** Base shape every message on the wire shares. */
export interface GatewayMessageBase {
	type: string;
}

// ── Client → Gateway ─────────────────────────────────────────────────────

/**
 * `tell` — send a message to the agent for workspace `to` and wait for its
 * reply. The gateway resolves `to` (a cwd or workspace name) to a workspace
 * cwd, finds-or-spawns the agent, prompts it, and returns the agent's final
 * assistant text. This is synchronous from the client's perspective: the
 * gateway holds the connection open and emits one {@link GatewayTellResult}
 * back.
 */
export interface GatewayTellRequest extends GatewayMessageBase {
	type: "tell";
	/** Correlation id echoed back in the matching {@link GatewayTellResult}. */
	id: string;
	/**
	 * Destination: a workspace cwd (absolute path) or a workspace name (the
	 * last path component, resolved via known workspaces — case-insensitive).
	 */
	to: string;
	/** The message text to deliver to the target agent as its prompt. */
	message: string;
	/** Optional timeout in ms (default: 120000). */
	timeout?: number;
}

/** `ping` — health check; the gateway replies with `{ type: "pong" }`. */
export interface GatewayPingRequest extends GatewayMessageBase {
	type: "ping";
}

export type GatewayRequest = GatewayTellRequest | GatewayPingRequest;

// ── Gateway → Client ─────────────────────────────────────────────────────

/** The result of a {@link GatewayTellRequest}. */
export type GatewayTellResult =
	| (GatewayMessageBase & {
			type: "tell_result";
			id: string;
			ok: true;
			/** The target agent's final assistant text. */
			reply: string;
	  })
	| (GatewayMessageBase & {
			type: "tell_result";
			id: string;
			ok: false;
			/** Human-readable failure reason. */
			error: string;
	  });

/** Health-check reply to {@link GatewayPingRequest}. */
export interface GatewayPong extends GatewayMessageBase {
	type: "pong";
}

/** A generic, connection-level error (e.g. malformed message). */
export interface GatewayError extends GatewayMessageBase {
	type: "error";
	message: string;
}

export type GatewayResponse = GatewayTellResult | GatewayPong | GatewayError;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Is the value a valid {@link GatewayRequest}? Structural check. */
export function isGatewayRequest(value: unknown): value is GatewayRequest {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "tell" || type === "ping";
}

/** Is the value a valid {@link GatewayResponse}? Structural check. */
export function isGatewayResponse(value: unknown): value is GatewayResponse {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "tell_result" || type === "pong" || type === "error";
}

/** Default tell timeout (ms) when the client omits one. */
export const GATEWAY_DEFAULT_TELL_TIMEOUT = 120_000;

/** Protocol version — bump on breaking wire changes. */
export const GATEWAY_PROTOCOL_VERSION = 1;