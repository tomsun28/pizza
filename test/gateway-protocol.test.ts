/**
 * Smoke test for the gateway protocol layer — verifies the wire types,
 * JSONL serialization, and request/response helpers without spawning any
 * real agent processes.
 */

import { describe, it, expect } from "vitest";
import {
	isGatewayRequest,
	isGatewayResponse,
	GATEWAY_DEFAULT_TELL_TIMEOUT,
	GATEWAY_PROTOCOL_VERSION,
	type GatewayTellRequest,
	type GatewayTellResult,
} from "../packages/gateway/protocol.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";

describe("gateway protocol", () => {
	it("has a protocol version", () => {
		expect(GATEWAY_PROTOCOL_VERSION).toBe(1);
		expect(GATEWAY_DEFAULT_TELL_TIMEOUT).toBe(120_000);
	});

	it("serializes JSON lines correctly", () => {
		expect(serializeJsonLine({ type: "ping" })).toBe('{"type":"ping"}');
		const tell: GatewayTellRequest = {
			type: "tell",
			id: "req_1",
			to: "web",
			message: "hello",
		};
		expect(serializeJsonLine(tell)).toBe('{"type":"tell","id":"req_1","to":"web","message":"hello"}');
	});

	it("validates GatewayRequest shapes", () => {
		expect(isGatewayRequest({ type: "ping" })).toBe(true);
		expect(isGatewayRequest({ type: "tell", id: "x", to: "y", message: "z" })).toBe(true);
		expect(isGatewayRequest({ type: "unknown" })).toBe(false);
		expect(isGatewayRequest(null)).toBe(false);
		expect(isGatewayRequest({})).toBe(false);
	});

	it("validates GatewayResponse shapes", () => {
		expect(isGatewayResponse({ type: "pong" })).toBe(true);
		const okResult: GatewayTellResult = { type: "tell_result", id: "x", ok: true, reply: "hi" };
		expect(isGatewayResponse(okResult)).toBe(true);
		expect(isGatewayResponse({ type: "tell_result", id: "x", ok: false, error: "boom" })).toBe(true);
		expect(isGatewayResponse({ type: "error", message: "bad" })).toBe(true);
		expect(isGatewayResponse({ type: "unknown" })).toBe(false);
	});
});