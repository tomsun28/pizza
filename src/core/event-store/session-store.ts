import type { SessionIndex } from "../projection/types.js";
import type { EventStore } from "./store.js";

/**
 * SessionStore - persistence layer for the session index (threads + sessions).
 *
 * Implementations are responsible for storing SessionDescriptor/ThreadDescriptor
 * metadata and providing it to SessionManager. Messages are not stored here;
 * they live in the EventStore.
 */
export interface SessionStore {
	/** Load the full session index, or undefined if none exists. */
	getSessionIndex(): SessionIndex | undefined;

	/** Persist the full session index. */
	saveSessionIndex(index: SessionIndex): void;
}

export function isSessionStore(store: EventStore): store is EventStore & SessionStore {
	return (
		typeof (store as unknown as SessionStore).getSessionIndex === "function" &&
		typeof (store as unknown as SessionStore).saveSessionIndex === "function"
	);
}
