import { useCallback, useState } from "react";

/**
 * useState mirror backed by localStorage under the `pizza:` namespace.
 * Reads once on mount; writes on every change. Failures are swallowed so a
 * blocked localStorage (private mode, etc.) never breaks the UI.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
	const storageKey = key.startsWith("pizza:") ? key : `pizza:${key}`;
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(storageKey);
			if (raw != null) return JSON.parse(raw) as T;
		} catch { /* ignore */ }
		return initial;
	});

	const set = useCallback(
		(next: T | ((prev: T) => T)) => {
			setValue((prev) => {
				const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
				try { localStorage.setItem(storageKey, JSON.stringify(resolved)); } catch { /* ignore */ }
				return resolved;
			});
		},
		[storageKey],
	);

	return [value, set];
}
