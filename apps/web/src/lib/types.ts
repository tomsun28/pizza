/**
 * Web app types — re-exports shared protocol types from @pizza/protocol
 * and adds web-specific types (WorkspaceMeta, AgentMessage subset).
 */

export {
	type RpcCommand,
	type RpcResponse,
	type RpcSessionState,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcCommandType,
	type TypedEvent,
	type StdoutLine,
	type ModelInfo,
	type ThinkingLevel,
	type RpcSlashCommand,
	type RpcHistoryTreeNode,
	type RpcHistorySessionView,
	type RpcHistoryTreeResult,
	type RpcForensicEvent,
	classifyLine,
	PROTOCOL_VERSION,
} from "@pizza/protocol";

// ---- AgentMessage (subset, for get_messages) ----
export interface AgentMessage {
	role: string;
	content: unknown;
	timestamp?: number;
	[key: string]: unknown;
}

// ---- Workspace metadata (from ~/.pizza/agent/workspaces/*/meta.json) ----
export interface WorkspaceMeta {
	workspace_id: string;
	cwd: string;
	created_at: number;
	last_accessed_at: number;
}
