import { describe, expect, it } from "vitest";
import {
	annotateVagueError,
	getLastNetworkError,
	resetNetworkDiagnostics,
	wrapFetchWithDiagnostics,
} from "../src/core/runtime/network-diagnostics.js";

function dnsError(): Error {
	const inner = Object.assign(new Error("getaddrinfo ENOTFOUND api.z.ai"), {
		code: "ENOTFOUND",
		syscall: "getaddrinfo",
		hostname: "api.z.ai",
	});
	return inner;
}

describe("network-diagnostics", () => {
	it("records transport failures with human-readable cause", async () => {
		resetNetworkDiagnostics();
		const failing: typeof fetch = (() =>
			Promise.reject(new TypeError("fetch failed", { cause: dnsError() }))) as typeof fetch;
		const wrapped = wrapFetchWithDiagnostics(failing);
		await expect(wrapped("https://api.z.ai/v1/chat/completions")).rejects.toThrow();
		const record = getLastNetworkError();
		expect(record).toBeDefined();
		expect(record!.host).toBe("api.z.ai");
		expect(record!.cause).toContain("ENOTFOUND");
		expect(record!.cause).toContain("DNS");
	});

	it("annotates vague errors but leaves specific ones unchanged", () => {
		resetNetworkDiagnostics();
		const failing: typeof fetch = (() =>
			Promise.reject(
				Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
					code: "ECONNREFUSED",
					syscall: "connect",
				}),
			)) as typeof fetch;
		const wrapped = wrapFetchWithDiagnostics(failing);
		// biome-ignore lint: intentional rejection
		void wrapped("http://localhost:8080/x").catch(() => {});

		// Synchronous-ish check after a microtask flush.
		return Promise.resolve().then(() => {
			const annotated = annotateVagueError("Connection error.");
			expect(annotated).toContain("Connection error.");
			expect(annotated).toContain("ECONNREFUSED");
			expect(annotated).toContain("\n");

			// Specific messages pass through untouched.
			expect(annotateVagueError("429: too many requests")).toBe("429: too many requests");
			// No record → unchanged.
			resetNetworkDiagnostics();
			expect(annotateVagueError("Connection error.")).toBe("Connection error.");
		});
	});

	it("does not record aborts", async () => {
		resetNetworkDiagnostics();
		const abort = new DOMException("The operation was aborted.", "AbortError") as unknown as Error;
		const failing: typeof fetch = (() => Promise.reject(abort)) as typeof fetch;
		await expect(wrapFetchWithDiagnostics(failing)("https://x.test/")).rejects.toThrow();
		expect(getLastNetworkError()).toBeUndefined();
	});
});
