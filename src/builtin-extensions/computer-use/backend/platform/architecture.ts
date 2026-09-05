import type { PlatformDiagnostics } from "./types.js";

export const PLATFORM_ARCHITECTURE_VERSION = 1;
export const REQUIRED_PLATFORM_INVARIANTS = [
	"state-scoped-observations",
	"bounded-observation-history",
	"multi-root-forest",
	"progressive-disclosure",
	"atomic-physical-input",
	"concurrent-requests",
	"transactional-batching",
] as const;

export function assertPlatformArchitecture(platform: string, diagnostics: PlatformDiagnostics): void {
	if (diagnostics.architectureVersion !== PLATFORM_ARCHITECTURE_VERSION) {
		throw new Error(`${platform} helper architecture mismatch: expected ${PLATFORM_ARCHITECTURE_VERSION}, got ${diagnostics.architectureVersion ?? "unknown"}. Rebuild and restart the helper.`);
	}
	const reported = new Set(diagnostics.invariants ?? []);
	const missing = REQUIRED_PLATFORM_INVARIANTS.filter((invariant) => !reported.has(invariant));
	if (missing.length > 0) {
		throw new Error(`${platform} helper does not satisfy the shared computer-use contract: ${missing.join(", ")}.`);
	}
}
