// Shared RPC types — mirror of src/modes/rpc/rpc-types.ts (kept in sync manually for P0).
// Long-term these will be generated from the TS source.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelInfo {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
}

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
}

// ---- Commands (stdin) ----
export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: unknown[] }
	| { id?: string; type: "follow_up"; message: string; images?: unknown[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel };

// ---- Responses (stdout) ----
export interface RpcResponseBase {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

// ---- Typed events (stdout, raw EventBase) ----
// We keep it loose: the bridge forwards every non-response line as an event.
export interface TypedEvent {
	type: string;
	event_id: string;
	payload: unknown;
	[key: string]: unknown;
}

// ---- Discriminator for stdout lines ----
export type StdoutLine =
	| { kind: "response"; data: RpcResponseBase }
	| { kind: "extension_ui_request"; data: { type: "extension_ui_request"; id: string; method: string; [k: string]: unknown } }
	| { kind: "event"; data: TypedEvent };

export function classifyLine(raw: Record<string, unknown>): StdoutLine {
	if (raw.type === "response") {
		return { kind: "response", data: raw as unknown as RpcResponseBase };
	}
	if (raw.type === "extension_ui_request") {
		return { kind: "extension_ui_request", data: raw as never };
	}
	return { kind: "event", data: raw as unknown as TypedEvent };
}

// ---- AgentMessage (subset, for get_messages) ----
export interface AgentMessage {
	role: string;
	content: unknown;
	timestamp?: number;
	[key: string]: unknown;
}
