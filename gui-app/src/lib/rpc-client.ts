import { invoke } from "@tauri-apps/api/core";
import type { RpcCommand, RpcResponseBase } from "./types";

/**
 * Send an RPC command to the pizza sidecar via the Rust bridge.
 * Returns the command id used for response correlation.
 */
export async function sendCommand(command: RpcCommand): Promise<string> {
	const id = await invoke<string>("rpc_command", { command });
	return id;
}

/**
 * Send a command and await its matching response (matched by id).
 */
export async function sendCommandAwait<T = unknown>(
	command: RpcCommand,
	timeoutMs = 15000,
): Promise<RpcResponseBase & { data?: T }> {
	const { listen } = await import("@tauri-apps/api/event");
	const id = await sendCommand(command);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unlisten.then((fn) => fn()).catch(() => {});
			reject(new Error(`Command "${command.type}" timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const unlisten = listen<RpcResponseBase>("rpc_response", (event) => {
			const payload = event.payload;
			if (payload.id === id) {
				clearTimeout(timer);
				unlisten.then((fn) => fn()).catch(() => {});
				if (payload.success) {
					resolve(payload as RpcResponseBase & { data?: T });
				} else {
					reject(new Error(payload.error ?? `Command "${command.type}" failed`));
				}
			}
		});
	});
}

export async function startSidecar(cwd: string): Promise<void> {
	await invoke("start_sidecar", { cwd });
}

export async function stopSidecar(): Promise<void> {
	await invoke("stop_sidecar");
}
