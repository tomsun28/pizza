/**
 * RPC protocol types — shared between the agent (src/) and consumers (apps/web/).
 *
 * This package is dependency-free. Types that reference agent internals
 * (AgentMessage, CompactionResult, BashResult, SessionStats, SourceInfo)
 * are declared as `unknown` here so consumers don't need to install the
 * full agent core. The agent side re-exports a typed version from
 * src/modes/rpc/rpc-types.ts with proper type parameters filled in.
 */

// ============================================================================
// Primitives (dependency-free)
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Minimal model info — enough for UI rendering without pulling in
 * @earendil-works/pi-ai's Model<any> type.
 */
export interface ModelInfo {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	/** Whether the user has configured auth (API key / OAuth) for this model. */
	hasAuth?: boolean;
}

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: unknown[] }
	| { id?: string; type: "follow_up"; message: string; images?: unknown[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "rewind"; targetEventId?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// History tree / event forensics (web docks)
	| { id?: string; type: "history_tree"; action: "list"; query?: string }
	| { id?: string; type: "history_tree"; action: "view"; sessionId: string; maxMessages?: number }
	| { id?: string; type: "history_tree"; action: "jump"; sessionId: string; reason?: string }
	| { id?: string; type: "history_tree"; action: "fork"; sessionId: string }
	| { id?: string; type: "history_tree"; action: "rename"; sessionId: string; name: string }
	| { id?: string; type: "get_events"; eventTypes?: string[]; limit?: number; sessionScoped?: boolean };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: unknown;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	/** Local WebSocket PTY server port for the Terminal pane (0/undefined = unavailable). */
	ptyPort?: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "rewind"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| { id?: string; type: "response"; command: "set_model"; success: true; data: ModelInfo }
	| { id?: string; type: "response"; command: "cycle_model"; success: true; data: { model: ModelInfo; thinkingLevel: ThinkingLevel; isScoped: boolean } | null }
	| { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: ModelInfo[] } }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| { id?: string; type: "response"; command: "cycle_thinking_level"; success: true; data: { level: ThinkingLevel } | null }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "get_fork_messages"; success: true; data: { messages: Array<{ entryId: string; text: string }> } }
	| { id?: string; type: "response"; command: "get_last_assistant_text"; success: true; data: { text: string | null } }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: unknown[] } }

	// Commands
	| { id?: string; type: "response"; command: "get_commands"; success: true; data: { commands: RpcSlashCommand[] } }

	// History tree / event forensics
	| { id?: string; type: "response"; command: "history_tree"; success: true; data: RpcHistoryTreeResult }
	| { id?: string; type: "response"; command: "get_events"; success: true; data: { events: RpcForensicEvent[] } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// History Tree / Event Forensics payloads (shared with web docks)
// ============================================================================

/** A flattened history-tree node (one session), as returned by `history_tree list`. */
export interface RpcHistoryTreeNode {
	session_id: string;
	thread_id: string;
	name?: string;
	created_at: number;
	created_by: string;
	parent_session_id?: string;
	depth: number;
	child_count: number;
	is_active: boolean;
	closed: boolean;
	snippet?: string;
	/** Event id the branch was forked at (present when it has a parent). */
	fork_at_event_id?: string;
}

/** One session's message previews, as returned by `history_tree view`. */
export interface RpcHistorySessionView {
	session_id: string;
	name?: string;
	messages: string[];
	message_count: number;
}

/** Discriminated result of the `history_tree` command by action. */
export type RpcHistoryTreeResult =
	| { action: "list"; nodes: RpcHistoryTreeNode[] }
	| { action: "view"; view: RpcHistorySessionView | null }
	| { action: "jump"; session_id: string; reopened: boolean }
	| { action: "fork"; session_id: string }
	| { action: "rename"; ok: boolean };

/** A raw event projected for the timeline dock. */
export interface RpcForensicEvent {
	event_id: string;
	type: string;
	timestamp: number;
	actor_id: string;
	caused_by?: string;
	thread_id?: string;
	payload: unknown;
}

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
	| { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Typed events (stdout, raw EventBase forwarded by the bridge)
// ============================================================================

export interface TypedEvent {
	type: string;
	event_id: string;
	payload: unknown;
	[key: string]: unknown;
}

// ============================================================================
// Discriminator for stdout lines
// ============================================================================

export type StdoutLine =
	| { kind: "response"; data: RpcResponse }
	| { kind: "extension_ui_request"; data: RpcExtensionUIRequest }
	| { kind: "event"; data: TypedEvent };

export function classifyLine(raw: Record<string, unknown>): StdoutLine {
	if (raw.type === "response") {
		return { kind: "response", data: raw as unknown as RpcResponse };
	}
	if (raw.type === "extension_ui_request") {
		return { kind: "extension_ui_request", data: raw as unknown as RpcExtensionUIRequest };
	}
	return { kind: "event", data: raw as unknown as TypedEvent };
}

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];

// ============================================================================
// Protocol version
// ============================================================================

export const PROTOCOL_VERSION = 1;
