/**
 * Session Boundary Inferrer
 *
 * Automatically infers session boundaries based on signals like:
 * - Time gaps
 * - User message semantic shifts
 * - File set drift
 * - Tool usage pattern changes
 */

import type { EventBase } from "../event-store/types.js";

// ============================================================================
// Boundary Decision
// ============================================================================

/** Boundary inference decision */
export interface BoundaryDecision {
	should_split: boolean;
	reason?: "intent_shift" | "file_drift" | "time_gap" | "tool_pattern_change";
	suggested_name?: string;
	confidence?: number;
}

// ============================================================================
// Boundary Configuration
// ============================================================================

export interface BoundaryConfig {
	/** Time gap threshold in milliseconds */
	time_gap_ms: number;
	/** File drift threshold (0-1, fraction of new files) */
	file_drift_threshold: number;
	/** Minimum events for a session */
	min_events_for_session: number;
	/** Enable file drift detection */
	enable_file_drift: boolean;
	/** Enable intent shift detection */
	enable_intent_shift: boolean;
	/** Enable tool pattern change detection */
	enable_tool_pattern_change: boolean;
}

const DEFAULT_BOUNDARY_CONFIG: BoundaryConfig = {
	time_gap_ms: 2 * 60 * 60 * 1000, // 2 hours
	file_drift_threshold: 0.8,
	min_events_for_session: 3,
	enable_file_drift: false, // Phase 2
	enable_intent_shift: false, // Phase 3
	enable_tool_pattern_change: false, // Phase 2
};

// ============================================================================
// Session Boundary Inferrer
// ============================================================================

/**
 * Automatically infers session boundaries.
 *
 * Phase 1: Time gap only
 * Phase 2: + File drift, tool pattern change
 * Phase 3: + Intent shift (semantic comparison)
 */
export class SessionBoundaryInferrer {
	constructor(private config: BoundaryConfig = DEFAULT_BOUNDARY_CONFIG) {}

	/**
	 * Evaluate whether to create a new session boundary.
	 *
	 * @param recentEvents Recent events in the current session (most recent last)
	 * @param newEvent The new event being added
	 * @returns Decision whether to split
	 */
	evaluate(recentEvents: EventBase[], newEvent: EventBase): BoundaryDecision {
		// Don't split if we don't have enough events yet
		if (recentEvents.length < this.config.min_events_for_session) {
			return { should_split: false };
		}

		// 1. Time gap check
		if (this._hasTimeGap(recentEvents, newEvent)) {
			return {
				should_split: true,
				reason: "time_gap",
				confidence: 1.0,
			};
		}

		// 2. File drift check (Phase 2)
		if (this.config.enable_file_drift && this._hasFileDrift(recentEvents, newEvent)) {
			return {
				should_split: true,
				reason: "file_drift",
				confidence: 0.7,
			};
		}

		// 3. Intent shift check (Phase 3)
		if (this.config.enable_intent_shift && this._hasIntentShift(recentEvents, newEvent)) {
			return {
				should_split: true,
				reason: "intent_shift",
				confidence: 0.6,
			};
		}

		// 4. Tool pattern change (Phase 2)
		if (this.config.enable_tool_pattern_change && this._hasToolPatternChange(recentEvents, newEvent)) {
			return {
				should_split: true,
				reason: "tool_pattern_change",
				confidence: 0.5,
			};
		}

		return { should_split: false };
	}

	/**
	 * Update configuration.
	 */
	updateConfig(updates: Partial<BoundaryConfig>): void {
		Object.assign(this.config, updates);
	}

	// =========================================================================
	// Private Detection Methods
	// =========================================================================

	private _hasTimeGap(recent: EventBase[], next: EventBase): boolean {
		if (recent.length === 0) return false;
		const last = recent[recent.length - 1];
		return next.timestamp - last.timestamp > this.config.time_gap_ms;
	}

	private _hasFileDrift(recent: EventBase[], _next: EventBase): boolean {
		// Phase 2: Compare file sets in recent tool executions vs new event
		const recentFiles = new Set<string>();
		for (const event of recent) {
			if (event.type === "TOOL_EXECUTION_END") {
				const payload = event.payload as { file_mutations?: Array<{ path: string }> };
				if (payload.file_mutations) {
					for (const mutation of payload.file_mutations) {
						recentFiles.add(mutation.path);
					}
				}
			}
		}

		// If no files recently, no drift
		if (recentFiles.size === 0) return false;

		// Phase 2: implement actual drift detection
		// For now, return false to avoid false positives
		return false;
	}

	private _hasIntentShift(_recent: EventBase[], _next: EventBase): boolean {
		// Phase 3: Semantic comparison of user messages
		// Requires LLM-based topic comparison
		return false;
	}

	private _hasToolPatternChange(_recent: EventBase[], _next: EventBase): boolean {
		// Phase 2: Compare tool usage patterns
		return false;
	}
}
