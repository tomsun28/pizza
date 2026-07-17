import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [tick, setTick] = useState(0);
	const fnRef = useRef(fn);
	fnRef.current = fn;

	const reload = useCallback(() => setTick((t) => t + 1), []);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(null);
		fnRef
			.current()
			.then((d) => alive && setData(d))
			.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
			.finally(() => alive && setLoading(false));
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tick, ...deps]);

	return { data, loading, error, reload };
}
