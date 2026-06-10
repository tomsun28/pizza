import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ContextUsage } from "../../../core/extensions/index.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts (similar to web-ui)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Minimal interface for footer data access.
 * Supported by SessionFacade-based adapters.
 */
export interface FooterSessionInfo {
	/** Model info: id, provider, reasoning, contextWindow */
	getModel(): { id: string; provider: string; reasoning?: boolean; contextWindow?: number } | undefined;
	/** Current thinking level */
	getThinkingLevel(): string | undefined;
	/** Cumulative token usage from all assistant messages */
	getTokenUsage(): {
		totalInput: number;
		totalOutput: number;
		totalCacheRead: number;
		totalCacheWrite: number;
		totalCost: number;
	};
	/** Context window usage */
	getContextUsage(): ContextUsage | undefined;
	/** Working directory */
	getCwd(): string;
	/** Session name (if set) */
	getSessionName(): string | undefined;
	/** Whether the current model uses OAuth subscription */
	isUsingOAuthSubscription(): boolean;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	constructor(
		private session: FooterSessionInfo,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setSession(session: FooterSessionInfo): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		// Extract session info via unified interface
		const modelInfo = this.getFromSession("model");
		const thinkingLevel = this.getFromSession("thinkingLevel");
		const tokenUsage = this.getFromSession("tokenUsage");
		const contextUsage = this.getFromSession("contextUsage");
		const pwd = this.getFromSession("cwd");
		const sessionName = this.getFromSession("sessionName");
		const usingSubscription = this.getFromSession("usingOAuth");

		const contextWindow = contextUsage?.contextWindow ?? modelInfo?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let displayPwd = pwd;
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && displayPwd.startsWith(home)) {
			displayPwd = `~${displayPwd.slice(home.length)}`;
		}

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			displayPwd = `${displayPwd} (${branch})`;
		}

		// Add session name if set
		if (sessionName) {
			displayPwd = `${displayPwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		if (tokenUsage.totalInput) statsParts.push(`↑${formatTokens(tokenUsage.totalInput)}`);
		if (tokenUsage.totalOutput) statsParts.push(`↓${formatTokens(tokenUsage.totalOutput)}`);
		if (tokenUsage.totalCacheRead) statsParts.push(`R${formatTokens(tokenUsage.totalCacheRead)}`);
		if (tokenUsage.totalCacheWrite) statsParts.push(`W${formatTokens(tokenUsage.totalCacheWrite)}`);

		// Show cost with "(sub)" indicator if using OAuth subscription
		if (tokenUsage.totalCost || usingSubscription) {
			const costStr = `$${tokenUsage.totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = modelInfo?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (modelInfo?.reasoning) {
			const level = thinkingLevel || "off";
			rightSideWithoutProvider =
				level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && modelInfo) {
			rightSide = `(${modelInfo.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", displayPwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	/**
	 * Accessor that reads from FooterSessionInfo.
	 */
	private getFromSession(field: "model" | "thinkingLevel" | "tokenUsage" | "contextUsage" | "cwd" | "sessionName" | "usingOAuth"): any {
		switch (field) {
			case "model": return this.session.getModel();
			case "thinkingLevel": return this.session.getThinkingLevel();
			case "tokenUsage": return this.session.getTokenUsage();
			case "contextUsage": return this.session.getContextUsage();
			case "cwd": return this.session.getCwd();
			case "sessionName": return this.session.getSessionName();
			case "usingOAuth": return this.session.isUsingOAuthSubscription();
		}
	}
}
