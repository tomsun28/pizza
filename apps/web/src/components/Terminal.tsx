import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { runBash, abortBash } from "@/lib/transport";
import { cn } from "@/lib/utils";

interface TermEntry {
	id: number;
	command: string;
	output: string;
	exitCode?: number;
	cancelled?: boolean;
	running?: boolean;
}

/**
 * Terminal — front-end for the sidecar `bash` / `abort_bash` RPC, scoped to
 * the active workspace. Request/response model: each command runs to
 * completion and its combined output is appended to the log.
 */
export default function Terminal({ workspace }: { workspace?: string | null }) {
	const { t } = useTranslation();
	const [entries, setEntries] = useState<TermEntry[]>([]);
	const [input, setInput] = useState("");
	const [running, setRunning] = useState(false);
	const history = useRef<string[]>([]);
	const histIndex = useRef<number>(-1);
	const nextId = useRef(0);
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// Reset the log when the workspace changes (data is workspace-scoped).
	useEffect(() => {
		setEntries([]);
		setInput("");
		setRunning(false);
		history.current = [];
		histIndex.current = -1;
	}, [workspace]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [entries]);

	const submit = useCallback(async () => {
		const command = input.trim();
		if (!command || running) return;
		const id = nextId.current++;
		history.current.push(command);
		histIndex.current = history.current.length;
		setEntries((prev) => [...prev, { id, command, output: "", running: true }]);
		setInput("");
		setRunning(true);
		try {
			const result = await runBash(command);
			setEntries((prev) => prev.map((e) => e.id === id ? {
				...e,
				output: result.output,
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				running: false,
			} : e));
		} catch (err) {
			setEntries((prev) => prev.map((e) => e.id === id ? {
				...e,
				output: err instanceof Error ? err.message : String(err),
				exitCode: 1,
				running: false,
			} : e));
		} finally {
			setRunning(false);
		}
	}, [input, running]);

	const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") { e.preventDefault(); void submit(); return; }
		if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
			if (running) void abortBash();
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			if (history.current.length === 0) return;
			histIndex.current = Math.max(0, histIndex.current - 1);
			setInput(history.current[histIndex.current] ?? "");
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			if (history.current.length === 0) return;
			histIndex.current = Math.min(history.current.length, histIndex.current + 1);
			setInput(history.current[histIndex.current] ?? "");
		}
	}, [submit, running]);

	return (
		<div className="flex h-full flex-col bg-bg font-mono text-xs" onClick={() => inputRef.current?.focus()}>
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
				{entries.length === 0 && (
					<div className="text-muted">{t("terminal.hint")}</div>
				)}
				{entries.map((e) => (
					<div key={e.id} className="mb-1">
						<div className="flex items-center gap-1.5">
							<span className="text-success">$</span>
							<span className="text-fg">{e.command}</span>
							{e.running && <span className="text-muted">…</span>}
							{!e.running && e.exitCode != null && e.exitCode !== 0 && (
								<span className="text-danger">[{e.exitCode}]</span>
							)}
						</div>
						{e.output && (
							<pre className="whitespace-pre-wrap break-all text-muted">{e.output}</pre>
						)}
					</div>
				))}
			</div>
			<div className="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-1.5">
				<span className={cn(running ? "text-muted" : "text-success")}>$</span>
				<input
					ref={inputRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={onKeyDown}
					disabled={running}
					spellCheck={false}
					autoCapitalize="off"
					autoComplete="off"
					placeholder={running ? t("terminal.running") : t("terminal.prompt")}
					className="flex-1 bg-transparent text-fg placeholder:text-muted focus:outline-none disabled:opacity-50"
				/>
			</div>
		</div>
	);
}
