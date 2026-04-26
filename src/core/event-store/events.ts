/**
 * Concrete Event Payload Types
 *
 * Typed payloads for each EventType defined in types.ts.
 */

import type { EventBase } from "./types.js";

// ============================================================================
// User Events
// ============================================================================

/** User sends a message */
export interface UserMessageEvent extends EventBase {
	type: "USER_MESSAGE";
	payload: {
		content: string | import("./types.js").ContentBlock[];
		images?: import("./types.js").ImageContent[];
		/** Raw input before expansion */
		raw_input?: string;
	};
}

/** User approves a pending intent */
export interface UserApprovalEvent extends EventBase {
	type: "USER_APPROVAL";
	payload: {
		/** Approved intent event_id */
		intent_event_id: string;
	};
}

/** User rejects a pending intent */
export interface UserRejectionEvent extends EventBase {
	type: "USER_REJECTION";
	payload: {
		/** Rejected intent event_id */
		intent_event_id: string;
		reason?: string;
	};
}

/** User interrupts current execution */
export interface UserInterruptEvent extends EventBase {
	type: "USER_INTERRUPT";
	payload: {
		content?: string | import("./types.js").ContentBlock[];
		reason?: string;
	};
}

/** User changes configuration */
export interface UserConfigChangeEvent extends EventBase {
	type: "USER_CONFIG_CHANGE";
	payload: {
		key: string;
		old_value: unknown;
		new_value: unknown;
	};
}

// ============================================================================
// Agent Events (LLM Output)
// ============================================================================

/** LLM thinking starts */
export interface AgentThinkingStartEvent extends EventBase {
	type: "AGENT_THINKING_START";
	payload: {
		model?: string;
	};
}

/** LLM thinking ends */
export interface AgentThinkingEndEvent extends EventBase {
	type: "AGENT_THINKING_END";
	payload: {
		duration_ms?: number;
	};
}

/** LLM message starts streaming */
export interface AgentMessageStartEvent extends EventBase {
	type: "AGENT_MESSAGE_START";
	payload: {
		model: { provider: string; model_id: string };
	};
}

/** LLM message chunk (streaming) */
export interface AgentMessageChunkEvent extends EventBase {
	type: "AGENT_MESSAGE_CHUNK";
	payload: {
		chunk: string | import("./types.js").ContentBlock;
	};
}

/** LLM produces assistant message (final, after streaming completes) */
export interface AgentMessageEndEvent extends EventBase {
	type: "AGENT_MESSAGE_END";
	payload: {
		content: import("./types.js").ContentBlock[];
		model: { provider: string; model_id: string };
		usage: import("./types.js").TokenUsage;
		stop_reason: "stop" | "tool_use" | "length" | "error" | "aborted";
		error_message?: string;
	};
}

/** Agent turn starts */
export interface AgentTurnStartEvent extends EventBase {
	type: "AGENT_TURN_START";
	payload: {
		message_count: number;
	};
}

/** Agent turn ends */
export interface AgentTurnEndEvent extends EventBase {
	type: "AGENT_TURN_END";
	payload: {
		tool_calls_count: number;
		duration_ms?: number;
	};
}

// ============================================================================
// Intent Events
// ============================================================================

/** LLM proposes a tool call (intent, not yet executed) */
export interface IntentToolCallEvent extends EventBase {
	type: "INTENT_TOOL_CALL";
	payload: {
		tool_call_id: string;
		tool_name: string;
		arguments: Record<string, unknown>;
		/** Whether user approval is required */
		requires_approval: boolean;
		/** Classification result */
		classification?: import("../intent/types.js").IntentClassification;
	};
}

/** LLM proposes a file edit (intent, not yet executed) */
export interface IntentFileEditEvent extends EventBase {
	type: "INTENT_FILE_EDIT";
	payload: {
		path: string;
		old_text: string;
		new_text: string;
		requires_approval: boolean;
	};
}

/** LLM proposes a command execution (intent, not yet executed) */
export interface IntentCommandExecEvent extends EventBase {
	type: "INTENT_COMMAND_EXEC";
	payload: {
		command: string;
		requires_approval: boolean;
	};
}

// ============================================================================
// Execution Events (Runtime Deterministic)
// ============================================================================

/** Runtime starts tool execution */
export interface ToolExecutionStartEvent extends EventBase {
	type: "TOOL_EXECUTION_START";
	payload: {
		tool_call_id: string;
		tool_name: string;
		arguments: Record<string, unknown>;
	};
}

/** Runtime tool execution update */
export interface ToolExecutionUpdateEvent extends EventBase {
	type: "TOOL_EXECUTION_UPDATE";
	payload: {
		tool_call_id: string;
		update: string;
		progress?: number;
	};
}

/** Runtime completes tool execution */
export interface ToolExecutionEndEvent extends EventBase {
	type: "TOOL_EXECUTION_END";
	payload: {
		tool_call_id: string;
		tool_name: string;
		result: import("./types.js").ContentBlock[];
		is_error: boolean;
		duration_ms: number;
		/** File mutations produced by this execution */
		file_mutations?: import("./types.js").FileMutation[];
	};
}

/** File mutation applied */
export interface FileMutationAppliedEvent extends EventBase {
	type: "FILE_MUTATION_APPLIED";
	payload: {
		mutation: import("./types.js").FileMutation;
		tool_call_id?: string;
	};
}

/** Command executed */
export interface CommandExecutedEvent extends EventBase {
	type: "COMMAND_EXECUTED";
	payload: {
		command: string;
		exit_code: number;
		output: string;
		duration_ms: number;
	};
}

// ============================================================================
// Session Lifecycle Events
// ============================================================================

/** Session created */
export interface SessionCreatedEvent extends EventBase {
	type: "SESSION_CREATED";
	payload: {
		session_id: string;
		name?: string;
		created_by: "user_explicit" | "auto_inferred" | "fork";
	};
}

/** Session boundary inferred */
export interface SessionBoundaryInferredEvent extends EventBase {
	type: "SESSION_BOUNDARY_INFERRED";
	payload: {
		reason: "intent_shift" | "file_drift" | "time_gap" | "user_explicit";
		new_session_id: string;
	};
}

/** Session forked */
export interface SessionForkedEvent extends EventBase {
	type: "SESSION_FORKED";
	payload: {
		new_session_id: string;
		parent_session_id?: string;
		fork_at_event_id: string;
	};
}

// ============================================================================
// Compaction Events
// ============================================================================

/** Compaction starts */
export interface CompactionStartEvent extends EventBase {
	type: "COMPACTION_START";
	payload: {
		token_count: number;
		target_tokens?: number;
	};
}

/** Compaction completed */
export interface CompactionEndEvent extends EventBase {
	type: "COMPACTION_END";
	payload: {
		summary: string;
		first_kept_event_id: string;
		tokens_before: number;
		tokens_after?: number;
		/** Structured memory nodes extracted */
		memory_nodes?: import("./types.js").MemoryNodeRef[];
	};
}

// ============================================================================
// Runtime Events
// ============================================================================

/** Checkpoint created */
export interface CheckpointCreatedEvent extends EventBase {
	type: "CHECKPOINT_CREATED";
	payload: {
		checkpoint_id: string;
		event_count: number;
	};
}

/** Model changed */
export interface ModelChangedEvent extends EventBase {
	type: "MODEL_CHANGED";
	payload: {
		provider: string;
		model_id: string;
		previous_provider?: string;
		previous_model_id?: string;
	};
}

/** Thinking level changed */
export interface ThinkingLevelChangedEvent extends EventBase {
	type: "THINKING_LEVEL_CHANGED";
	payload: {
		level: string;
		previous_level?: string;
	};
}

/** Runtime error */
export interface RuntimeErrorEvent extends EventBase {
	type: "RUNTIME_ERROR";
	payload: {
		error: string;
		stack?: string;
		/** Event that caused the error */
		causing_event_id?: string;
	};
}

// ============================================================================
// Type Exports
// ============================================================================

/** All event types with their payloads */
export type TypedEvent =
	| UserMessageEvent
	| UserApprovalEvent
	| UserRejectionEvent
	| UserInterruptEvent
	| UserConfigChangeEvent
	| AgentThinkingStartEvent
	| AgentThinkingEndEvent
	| AgentMessageStartEvent
	| AgentMessageChunkEvent
	| AgentMessageEndEvent
	| AgentTurnStartEvent
	| AgentTurnEndEvent
	| IntentToolCallEvent
	| IntentFileEditEvent
	| IntentCommandExecEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| FileMutationAppliedEvent
	| CommandExecutedEvent
	| SessionCreatedEvent
	| SessionBoundaryInferredEvent
	| SessionForkedEvent
	| CompactionStartEvent
	| CompactionEndEvent
	| CheckpointCreatedEvent
	| ModelChangedEvent
	| ThinkingLevelChangedEvent
	| RuntimeErrorEvent;
