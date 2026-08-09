/**
 * JSONL line reader / serializer — a thin, dependency-free copy of
 * packages/rpc/jsonl.ts so the gateway package stays self-contained.
 *
 * Used by both the gateway server (reading client connections) and the gateway
 * client (reading the server's responses).
 */

/** Serialize a value as a single JSON line (no trailing newline in the return; caller appends \n). */
export function serializeJsonLine(value: unknown): string {
	return JSON.stringify(value);
}

/**
 * Attach a line-buffered reader to a readable stream. Calls `onLine` for every
 * complete newline-terminated line. Returns a detach function that removes the
 * listener and flushes partial buffers. Blank lines are ignored.
 */
export function attachJsonlLineReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): () => void {
	let buffer = "";
	const onData = (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.length > 0) {
				onLine(line);
			}
		}
	};
	const onEnd = () => {
		const line = buffer.trim();
		if (line.length > 0) {
			onLine(line);
		}
		buffer = "";
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}