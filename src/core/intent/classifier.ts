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
	/** Auto-approve file writes */
	approve_writes: boolean;
	/** Auto-approve file edits */
	approve_edits: boolean;
	/** Auto-approve moderate shell commands */
	approve_shell_moderate: boolean;
	/** Require approval for unknown tools */
	approve_unknown: boolean;
}

const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
	approve_writes: false,
	approve_edits: false,
	approve_shell_moderate: false,
	approve_unknown: true,
};

// ============================================================================
// Intent Classifier
// ============================================================================

/**
 * Classifies tool calls by risk level and approval requirements.
 *
 * Default policy:
 * - file_read, shell_safe: auto-approve
 * - file_write, shell_moderate, network: auto-approve (configurable)
 * - file_delete, shell_dangerous: always require approval
 */
export class IntentClassifier {
	constructor(private config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG) {}

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
					requires_approval: this.config.approve_writes,
					category: "file_write",
					affected_files: [String(args.path)],
					description: `Write to ${args.path}`,
				};

			case "edit":
			case "edit_diff":
				return {
					risk: "moderate",
					requires_approval: this.config.approve_edits,
					category: "file_write",
					affected_files: [String(args.path)],
					description: `Edit ${args.path}`,
				};

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
					requires_approval: this.config.approve_unknown,
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

		// Dangerous patterns
		const dangerousPatterns: Array<{ pattern: RegExp; description: string }> = [
			{ pattern: /\brm\s+-[a-z]*r/i, description: "Recursive delete" },
			{ pattern: /\brm\s+-[rf]\s+\//i, description: "Delete from root" },
			{ pattern: /\bsudo\s+/i, description: "Elevated privileges" },
			{ pattern: /\bcurl\b.*\|\s*bash/i, description: "Download and execute" },
			{ pattern: /\bwget\b.*\|\s*bash/i, description: "Download and execute" },
			{ pattern: /\bchmod\s+777/i, description: "World-writable permissions" },
			{ pattern: /\b>\s*\/dev\//i, description: "Redirect to device" },
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

		// Safe patterns
		const safePatterns: RegExp[] = [
			/^(echo|cat|pwd|ls|find|grep|head|tail|wc|date|whoami|id|uname)\b/,
			/^git\s+(status|log|diff|branch|show|remote)\b/,
			/^npm\s+(list|config|root)\b/,
			/^yarn\s+(info|list)\b/,
			/^pnpm\s+(list|root)\b/,
			/^docker\s+(ps|images|logs)\b/,
		];

		for (const pattern of safePatterns) {
			if (pattern.test(trimmed)) {
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
			requires_approval: this.config.approve_shell_moderate,
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
					requires_approval: this.config.approve_writes,
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
					requires_approval: this.config.approve_shell_moderate,
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
					requires_approval: this.config.approve_unknown,
					category,
					description: `Network: ${args.url ?? toolName}`,
				};
			case "unknown":
				return {
					risk: "moderate",
					requires_approval: this.config.approve_unknown,
					category,
					description: toolName,
				};
		}
	}
}
