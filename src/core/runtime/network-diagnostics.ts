import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * Network-level failure diagnostics.
 *
 * Provider SDKs collapse every transport failure into a vague message like
 * "Connection error." with no status code and no body — the user cannot tell a
 * DNS outage from a TLS error from a refused connection. This module wraps the
 * fetch used for LLM API calls, records the real cause when the transport
 * fails, and lets callers annotate vague provider error messages with it.
 */

export interface NetworkErrorRecord {
	timestamp: number;
	/** Host the failing request targeted. */
	host: string;
	/** Human-readable cause, e.g. "ENOTFOUND (getaddrinfo api.z.ai) — DNS lookup failed". */
	cause: string;
}

/** Most recent transport failure (best effort; concurrent calls may overwrite). */
let lastRecord: NetworkErrorRecord | undefined;

/** Cause codes worth surfacing, mapped to short human explanations. */
const CAUSE_EXPLANATIONS: Record<string, string> = {
	ENOTFOUND: "DNS lookup failed — domain does not resolve (check network/DNS)",
	EAI_AGAIN: "DNS lookup timed out (check network/DNS)",
	ECONNREFUSED: "connection refused by server (nothing listening / firewall)",
	ECONNRESET: "connection reset by peer (proxy/VPN drop or server closed it)",
	ETIMEDOUT: "connection timed out",
	UND_ERR_CONNECT_TIMEOUT: "connection timed out",
	EHOSTUNREACH: "host unreachable",
	ENETUNREACH: "network unreachable",
	EPIPE: "connection broken (write on closed socket)",
};

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Walk an error chain and produce a compact human-readable cause string. */
function describeCauseChain(error: unknown): string | undefined {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth++) {
		if (!(current instanceof Error)) {
			const text = String(current).trim();
			if (text) parts.push(text);
			break;
		}
		const code = (current as NodeJS.ErrnoException).code;
		const syscall = (current as NodeJS.ErrnoException).syscall;
		const hostname = (current as NodeJS.ErrnoException & { hostname?: string }).hostname;

		if (code) {
			const explanation = CAUSE_EXPLANATIONS[code];
			const context = [syscall, hostname].filter(Boolean).join(" ");
			parts.push(explanation ? `${code} (${context}) — ${explanation}` : `${code}${context ? ` (${context})` : ""}`);
		} else if (current.message && current.message !== "fetch failed" && parts.length === 0) {
			// Keep a real message (e.g. TLS errors surface as messages), but skip
			// undici's generic wrapper — its cause is the interesting part.
			parts.push(current.message);
		}
		current = (current as Error & { cause?: unknown }).cause;
	}
	return parts.length > 0 ? parts.join(" ← ") : undefined;
}

function requestHost(input: Parameters<FetchFunction>[0]): string {
	try {
		return new URL(
			typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url,
		).host;
	} catch {
		return "unknown host";
	}
}

/**
 * Wrap a fetch implementation so transport-level failures are recorded for
 * {@link annotateVagueError}. Failures are re-thrown unchanged.
 */
export function wrapFetchWithDiagnostics(fetchFn: FetchFunction = globalThis.fetch): FetchFunction {
	return async (input, init) => {
		try {
			return await fetchFn(input, init);
		} catch (error) {
			if (!isAbort(error)) {
				const cause = describeCauseChain(error);
				if (cause) {
					lastRecord = {
						timestamp: Date.now(),
						host: requestHost(input),
						cause,
					};
				}
			}
			throw error;
		}
	};
}

/** Records older than this are considered stale and are not attached. */
const MAX_RECORD_AGE_MS = 30_000;

/**
 * Append the recorded network cause to vague provider error messages
 * ("Connection error.", "fetch failed", ...). Returns the message unchanged
 * when it is already specific or no fresh record exists. The detail is
 * appended after a newline so UIs can render it as secondary small text.
 */
export function annotateVagueError(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return errorMessage;
	if (!/connection error|fetch failed|network error|failed to fetch|network request failed/i.test(errorMessage)) {
		return errorMessage;
	}
	if (!lastRecord || Date.now() - lastRecord.timestamp > MAX_RECORD_AGE_MS) {
		return errorMessage;
	}
	if (errorMessage.includes(lastRecord.cause)) {
		return errorMessage;
	}
	return `${errorMessage}\ncause: ${lastRecord.cause}${lastRecord.host ? ` [${lastRecord.host}]` : ""} (${new Date(
		lastRecord.timestamp,
	).toLocaleTimeString()})`;
}

/** Test helper: reset recorded state. */
export function resetNetworkDiagnostics(): void {
	lastRecord = undefined;
}

/** Test helper: read the current record. */
export function getLastNetworkError(): NetworkErrorRecord | undefined {
	return lastRecord;
}
