/**
 * The GUI HTTP bridge has no authentication and drives an agent with full shell
 * access, so it must not be reachable from a web page the user happens to visit.
 *
 * Two regressions are covered here:
 *
 *  1. `readJsonBody` ignored Content-Type entirely, so `text/plain` containing
 *     JSON was accepted. `text/plain` is a CORS-"simple" content type, meaning a
 *     cross-origin POST carrying it is sent WITHOUT a preflight — the browser
 *     would deliver the attacker's prompt and the agent would execute it.
 *  2. Neither `Origin` nor `Host` was validated, leaving the bridge open to
 *     cross-origin POSTs and to DNS rebinding (evil.com → 127.0.0.1).
 */

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { checkJsonContentType, checkRequestOrigin, isLoopbackHostname } from "../packages/http-bridge/server.js";

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
	return { headers } as unknown as IncomingMessage;
}

describe("http-bridge — loopback detection", () => {
	it("recognises local hostnames", () => {
		for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
			expect(isLoopbackHostname(h)).toBe(true);
		}
	});

	it("rejects remote hostnames", () => {
		for (const h of ["evil.com", "10.0.0.5", "192.168.1.4", "0.0.0.0", "1270.0.1", "127.0.0.1.evil.com"]) {
			expect(isLoopbackHostname(h)).toBe(false);
		}
	});
});

describe("http-bridge — Content-Type gate", () => {
	it("rejects the CORS-simple content types used to bypass preflight", () => {
		for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
			expect(checkJsonContentType(fakeReq({ "content-type": ct }))).toBeDefined();
		}
	});

	it("rejects a missing Content-Type", () => {
		expect(checkJsonContentType(fakeReq({}))).toBeDefined();
	});

	it("accepts application/json, with or without parameters", () => {
		expect(checkJsonContentType(fakeReq({ "content-type": "application/json" }))).toBeUndefined();
		expect(checkJsonContentType(fakeReq({ "content-type": "application/json; charset=utf-8" }))).toBeUndefined();
		expect(checkJsonContentType(fakeReq({ "content-type": "APPLICATION/JSON" }))).toBeUndefined();
	});
});

describe("http-bridge — Origin / Host gate", () => {
	it("blocks a cross-origin request from a malicious page", () => {
		const err = checkRequestOrigin(
			fakeReq({ host: "127.0.0.1:8123", origin: "https://evil.com" }),
			"127.0.0.1",
		);
		expect(err).toBe("Cross-origin request blocked");
	});

	it("blocks DNS rebinding via a spoofed Host header", () => {
		const err = checkRequestOrigin(fakeReq({ host: "evil.com:8123" }), "127.0.0.1");
		expect(err).toBe("Invalid Host header");
	});

	it("allows the bundled UI talking to itself", () => {
		expect(
			checkRequestOrigin(
				fakeReq({ host: "127.0.0.1:8123", origin: "http://127.0.0.1:8123" }),
				"127.0.0.1",
			),
		).toBeUndefined();
		expect(
			checkRequestOrigin(
				fakeReq({ host: "localhost:8123", origin: "http://localhost:8123" }),
				"127.0.0.1",
			),
		).toBeUndefined();
	});

	it("allows non-browser clients that send no Origin", () => {
		expect(checkRequestOrigin(fakeReq({ host: "127.0.0.1:8123" }), "127.0.0.1")).toBeUndefined();
	});

	it("allows the host the server was explicitly bound to", () => {
		expect(
			checkRequestOrigin(
				fakeReq({ host: "dev-box.local:8123", origin: "http://dev-box.local:8123" }),
				"dev-box.local",
			),
		).toBeUndefined();
	});

	it("rejects a malformed Origin rather than failing open", () => {
		expect(checkRequestOrigin(fakeReq({ host: "127.0.0.1:8123", origin: "not a url" }), "127.0.0.1")).toBe(
			"Invalid Origin header",
		);
	});

	it("tolerates the literal \"null\" origin (sandboxed iframe / file://)", () => {
		expect(checkRequestOrigin(fakeReq({ host: "127.0.0.1:8123", origin: "null" }), "127.0.0.1")).toBeUndefined();
	});
});