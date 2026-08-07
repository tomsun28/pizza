/**
 * Gateway package — the agent-to-agent messaging daemon.
 *
 * Public API:
 *   - {@link createGatewayServer} / {@link gatewaySocketPath} — the daemon.
 *   - {@link GatewayClient} — connect to the daemon and `tell` another agent.
 *   - {@link ensureGateway} — auto-start the daemon if it isn't running.
 *   - Protocol types ({@link GatewayRequest}, {@link GatewayResponse}, …).
 */

export {
	createGatewayServer,
	gatewaySocketPath,
	type GatewayServer,
	type GatewayServerOptions,
	type GatewayServerEvents,
} from "./gateway-server.js";

export { GatewayClient, type GatewayClientOptions } from "./gateway-client.js";

export {
	type ChannelTransport,
	type ChannelFrame,
	type ChannelEvent,
	DirectTransport,
	GatewayTransport,
	type GatewayTransportOptions,
} from "./channel-client.js";

export { ensureGateway } from "./gateway-lifecycle.js";

export {
	type GatewayRequest,
	type GatewayTellRequest,
	type GatewayPingRequest,
	type GatewayResponse,
	type GatewayTellResult,
	type GatewayPong,
	type GatewayError,
	type GatewayChannelRequest,
	type GatewayAttachRequest,
	type GatewayDetachRequest,
	type GatewayRpcRequest,
	type GatewayListRequest,
	type GatewayChannelResponse,
	type GatewayAttachOk,
	type GatewayRpcDelivery,
	type GatewayRpcFrame,
	type GatewayWorkspaceInfo,
	type GatewayListResult,
	GATEWAY_DEFAULT_TELL_TIMEOUT,
	GATEWAY_PROTOCOL_VERSION,
	isGatewayRequest,
	isGatewayResponse,
} from "./protocol.js";

export { serializeJsonLine, attachJsonlLineReader } from "./jsonl.js";