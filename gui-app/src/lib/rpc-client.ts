export {
	sendCommandRaw as sendCommand,
	sendCommandAwait,
	type RpcResponse,
} from "./transport";

export async function startSidecar(_cwd: string): Promise<void> {
	// No-op in browser mode; Tauri handles this via init_sidecar
}

export async function stopSidecar(): Promise<void> {
	// No-op in browser mode
}

