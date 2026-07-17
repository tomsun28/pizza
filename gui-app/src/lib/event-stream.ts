import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TypedEvent } from "./types";

/**
 * Subscribe to the raw TypedEvent stream from the sidecar.
 * Returns an unsubscribe function.
 */
export async function subscribeEvents(handler: (event: TypedEvent) => void): Promise<UnlistenFn> {
	return listen<TypedEvent>("rpc_event", (event) => handler(event.payload));
}

export async function subscribeSidecarExit(handler: (code: number | null) => void): Promise<UnlistenFn> {
	return listen<{ code: number | null }>("sidecar_exit", (event) => handler(event.payload.code));
}
