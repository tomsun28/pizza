/**
 * Intent Classifier
 *
 * Classifies LLM-proposed tool calls by risk level and approval requirements.
 */

import type { IntentClassification, IntentCategory, IntentRisk } from "./types.js";

// ============================================================================
// Classifier Configuration
// ============================================================================

export interface ClassifierConfig {
	/** Require user approval before file writes. */
	require_approval_writes?: boolean;
	/** Require user approval before file edits. */
	require_approval_edits?: boolean;
	/** Require user approval before moderate shell commands. */
	require_approval_shell_moderate?: boolean;
	/** Require user approval before unknown tools. */
	require_approval_unknown?: boolean;

	/** @deprecated Use require_approval_writes. Historical alias. */
	approve_writes?: boolean;
	/** @deprecated Use require_approval_edits. Historical alias. */
	approve_edits?: boolean;
	/** @deprecated Use require_approval_shell_moderate. Historical alias. */
	approve_shell_moderate?: boolean;
	/** @deprecated Use require_approval_unknown. Historical alias. */
	approve_unknown?: boolean;
}

interface ResolvedClassifierConfig {
	require_approval_writes: boolean;
	require_approval_edits: boolean;
	require_approval_shell_moderate: boolean;
	require_approval_unknown: boolean;
}

const DEFAULT_CLASSIFIER_CONFIG: ResolvedClassifierConfig = {
	require_approval_writes: true,
	require_approval_edits: true,
	require_approval_shell_moderate: false,
	require_approval_unknown: true,
};

// ============================================================================
// Intent Classifier
// ============================================================================

/**
 * Classifies tool calls by risk level and approval requirements.
 *
 * Default policy:
 * - file_read, shell_safe: auto-approve
 * - file_write, network, unknown: require approval (configurable)
 * - shell_moderate: auto-approve by default (configurable)
 * - file_delete, shell_dangerous: always require approval
 */
export class IntentClassifier {
	private config: ResolvedClassifierConfig;

	constructor(config: ClassifierConfig = {}) {
		this.config = resolveClassifierConfig(config);
	}

	/**
	 * Classify a tool call by name and arguments.
	 */
	classify(toolName: string, args: Record<string, unknown>): IntentClassification {
		// Built-in tool classification
		switch (toolName) {
			case "read":
			case "find":
			case "grep":
			case "ls":
			case "path_utils":
				return {
					risk: "safe",
					requires_approval: false,
					category: "file_read",
					description: `Read ${args.path ?? ""}`,
				};

			case "write":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_writes,
					category: "file_write",
					affected_files: [String(args.path)],
					description: `Write to ${args.path}`,
				};

			case "edit":
			case "edit_diff":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_edits,
					category: "file_write",
					affected_files: [String(args.path)],
					description: `Edit ${args.path}`,
				};

			case "cli":
			case "bash":
				return this._classifyBashCommand(String(args.command ?? ""));

			case "truncate":
				return {
					risk: "dangerous",
					requires_approval: true,
					category: "file_delete",
					description: `Truncate ${args.path ?? ""}`,
				};

			case "builtin":
				return this._classifyBuiltinCommand(String(args.command ?? ""));

			default:
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_unknown,
					category: "unknown",
					description: `Execute ${toolName}`,
				};
		}
	}

	/**
	 * Classify a bash command by its content.
	 */
	private _classifyBashCommand(command: string): IntentClassification {
		const trimmed = command.trim();
		const builtin = parseBuiltinInvocation(trimmed);
		if (builtin) {
			if (builtin.command === "read") {
				return {
					risk: "safe",
					requires_approval: false,
					category: "file_read",
					affected_files: builtin.path ? [builtin.path] : undefined,
					description: `Read ${builtin.path ?? ""}`,
				};
			}
			if (builtin.command === "write") {
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_writes,
					category: "file_write",
					affected_files: builtin.path ? [builtin.path] : undefined,
					description: `Write to ${builtin.path ?? ""}`,
				};
			}
			if (builtin.command === "edit") {
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_edits,
					category: "file_write",
					affected_files: builtin.path ? [builtin.path] : undefined,
					description: `Edit ${builtin.path ?? ""}`,
				};
			}
		}

		// Dangerous patterns
		const dangerousPatterns: Array<{ pattern: RegExp; description: string }> = [
			{ pattern: /\brm\s+-[a-z]*r/i, description: "Recursive delete" },
			{ pattern: /\brm\s+-[a-z]*[rf]\s+\/(?:\s|$|\*)/i, description: "Delete from root" },
			{ pattern: /\bsudo\s+/i, description: "Elevated privileges" },
			{ pattern: /\bcurl\b.*\|\s*bash/i, description: "Download and execute" },
			{ pattern: /\bwget\b.*\|\s*bash/i, description: "Download and execute" },
			{ pattern: /\bchmod\s+777/i, description: "World-writable permissions" },
			{ pattern: /\b>\s*\/dev\/(?!null\b)/i, description: "Redirect to device" },
			{ pattern: /\n\s*rm\s+/i, description: "Embedded delete command" },
			{ pattern: /\bdd\b/i, description: "Direct disk access" },
			{ pattern: /\bmkfs\b/i, description: "Filesystem format" },
		];

		for (const { pattern, description } of dangerousPatterns) {
			if (pattern.test(trimmed)) {
				return {
					risk: "dangerous",
					requires_approval: true,
					category: "shell_dangerous",
					description: `DANGEROUS: ${description}`,
				};
			}
		}

		const redirectedPath = getNonNullRedirectPath(trimmed);
		if (redirectedPath) {
			return {
				risk: "moderate",
				requires_approval: this.config.require_approval_writes,
				category: "file_write",
				affected_files: [redirectedPath],
				description: `Shell redirection to ${redirectedPath}`,
			};
		}

		// Safe patterns
		const safePatterns: RegExp[] = [
			/^(echo|cat|pwd|ls|find|grep|head|tail|wc|date|whoami|id|uname)\b/,
			/^git\s+(status|log|diff|branch|show|remote)\b/,
			/^npm\s+(list|config|root)\b/,
			/^yarn\s+(info|list)\b/,
			/^pnpm\s+(list|root)\b/,
			/^docker\s+(ps|images|logs)\b/,
		];

		if (isSingleSafeShellCommand(trimmed)) {
			for (const pattern of safePatterns) {
				if (!pattern.test(trimmed)) continue;
				return {
					risk: "safe",
					requires_approval: false,
					category: "shell_safe",
					description: trimmed.length > 50 ? trimmed.slice(0, 50) + "..." : trimmed,
				};
			}
		}

		// Moderate (default for shell)
		return {
			risk: "moderate",
			requires_approval: this.config.require_approval_shell_moderate,
			category: "shell_moderate",
			description: trimmed.length > 50 ? trimmed.slice(0, 50) + "..." : trimmed,
		};
	}

	/**
	 * Classify a builtin command.
	 */
	private _classifyBuiltinCommand(command: string): IntentClassification {
		const trimmed = command.trim().toLowerCase();

		// Safe builtin commands
		const safeCommands = ["help", "version", "list", "ls", "status"];

		if (safeCommands.includes(trimmed)) {
			return {
				risk: "safe",
				requires_approval: false,
				category: "shell_safe",
				description: `Builtin: ${command}`,
			};
		}

		// Everything else is moderate
		return {
			risk: "moderate",
			requires_approval: false,
			category: "shell_moderate",
			description: `Builtin: ${command}`,
		};
	}

	/**
	 * Classify by intent category directly.
	 */
	classifyByCategory(
		category: IntentCategory,
		args: Record<string, unknown>,
	): IntentClassification {
		const toolName = String(args.tool_name ?? "unknown");

		switch (category) {
			case "file_read":
				return {
					risk: "safe",
					requires_approval: false,
					category,
					description: `Read ${args.path ?? ""}`,
				};
			case "file_write":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_writes,
					category,
					affected_files: [String(args.path)],
					description: `Write to ${args.path}`,
				};
			case "file_delete":
				return {
					risk: "dangerous",
					requires_approval: true,
					category,
					description: `Delete ${args.path ?? ""}`,
				};
			case "shell_safe":
				return {
					risk: "safe",
					requires_approval: false,
					category,
					description: toolName,
				};
			case "shell_moderate":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_shell_moderate,
					category,
					description: toolName,
				};
			case "shell_dangerous":
				return {
					risk: "dangerous",
					requires_approval: true,
					category,
					description: `DANGEROUS: ${toolName}`,
				};
			case "network":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_unknown,
					category,
					description: `Network: ${args.url ?? toolName}`,
				};
			case "unknown":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_unknown,
					category,
					description: toolName,
				};
		}
	}
}

function resolveClassifierConfig(config: ClassifierConfig): ResolvedClassifierConfig {
	return {
		require_approval_writes:
			config.require_approval_writes ?? config.approve_writes ?? DEFAULT_CLASSIFIER_CONFIG.require_approval_writes,
		require_approval_edits:
			config.require_approval_edits ?? config.approve_edits ?? DEFAULT_CLASSIFIER_CONFIG.require_approval_edits,
		require_approval_shell_moderate:
			config.require_approval_shell_moderate ??
			config.approve_shell_moderate ??
			DEFAULT_CLASSIFIER_CONFIG.require_approval_shell_moderate,
		require_approval_unknown:
			config.require_approval_unknown ?? config.approve_unknown ?? DEFAULT_CLASSIFIER_CONFIG.require_approval_unknown,
	};
}

function parseBuiltinInvocation(command: string): { command: "read" | "write" | "edit"; path?: string } | undefined {
	const firstLine = command.split("\n", 1)[0]?.trim() ?? "";
	const parts = splitShellWords(firstLine);
	const builtin = parts[0]?.toLowerCase();
	if (builtin !== "read" && builtin !== "write" && builtin !== "edit") return undefined;

	let path: string | undefined;
	for (let i = 1; i < parts.length; i++) {
		const arg = parts[i]!;
		if ((arg === "--path" || arg === "-p") && parts[i + 1]) {
			path = parts[i + 1];
			break;
		}
		if (!arg.startsWith("-") && !path) {
			path = arg;
			break;
		}
	}

	return { command: builtin, path };
}

function splitShellWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) words.push(current);
	return words;
}

function getNonNullRedirectPath(command: string): string | undefined {
	const matches = command.matchAll(/(?:^|[\s;|&])(?:\d*)>>?\s*(['"]?)([^'"\s;&|]+)\1/g);
	for (const match of matches) {
		const path = match[2];
		if (!path || path === "/dev/null") continue;
		return path;
	}
	return undefined;
}

function isSingleSafeShellCommand(command: string): boolean {
	const withoutNullRedirects = command.replace(/\s+\d*>\/dev\/null\b/g, "");
	return !/[|;&<>`$()]/.test(withoutNullRedirects);
}
