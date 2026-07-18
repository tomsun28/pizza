import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Square, Mic, Plus, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { sendCommandAwait } from "@/lib/transport";
import type { RpcSessionState, ModelInfo } from "@/lib/types";

interface SpeechRecognitionAlternative {
	transcript: string;
	confidence?: number;
	readonly [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResult {
	readonly length: number;
	readonly isFinal: boolean;
	readonly [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
	readonly length: number;
	readonly [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
}

export function Composer({
	sidecarReady,
	isRunning,
	state,
	onSend,
	onAbort,
}: {
	sidecarReady: boolean;
	isRunning: boolean;
	state: RpcSessionState | null;
	onSend: (message: string) => void;
	onAbort: () => void;
}) {
	const [input, setInput] = useState("");
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [recording, setRecording] = useState(false);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const recognitionRef = useRef<SpeechRecognition | null>(null);
	const modelMenuRef = useRef<HTMLDivElement>(null);

	const hasSpeechSupport =
		typeof window !== "undefined" &&
		("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait<{ models: ModelInfo[] }>({
					type: "get_available_models",
				});
				if (cancelled) return;
				setModels(r.data?.models ?? []);
			} catch (e) {
				console.error("[composer] get_available_models failed:", e);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sidecarReady]);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
	}, [input]);

	useEffect(() => {
		return () => {
			recognitionRef.current?.stop();
		};
	}, []);

	// Close model menu on outside click.
	useEffect(() => {
		if (!modelMenuOpen) return;
		const onClick = (e: MouseEvent) => {
			if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
				setModelMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [modelMenuOpen]);

	const currentModelKey = useMemo(() => {
		const model = state?.model;
		return model ? `${model.provider}:${model.id}` : "";
	}, [state?.model]);

	const currentModelLabel = state?.model?.name ?? state?.model?.id ?? "Model";

	const handleModelSelect = useCallback(async (m: ModelInfo) => {
		setModelMenuOpen(false);
		try {
			await sendCommandAwait({ type: "set_model", provider: m.provider, modelId: m.id });
		} catch (e) {
			console.error("[composer] set_model failed:", e);
		}
	}, []);

	const startRecording = useCallback(() => {
		const win = window as unknown as {
			SpeechRecognition?: new () => SpeechRecognition;
			webkitSpeechRecognition?: new () => SpeechRecognition;
		};
		const SR = win.SpeechRecognition ?? win.webkitSpeechRecognition;
		if (!SR) return;

		const recognition = new SR();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = navigator.language || "en-US";

		recognition.onresult = (event: SpeechRecognitionEvent) => {
			let final = "";
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				const text = result[0]?.transcript ?? "";
				if (result.isFinal && text) {
					final += (final ? " " : "") + text;
				}
			}
			if (final) {
				setInput((prev) => (prev ? prev.trimEnd() + " " : "") + final);
			}
		};

		recognition.onerror = () => setRecording(false);
		recognition.onend = () => setRecording(false);

		recognitionRef.current = recognition;
		setRecording(true);
		recognition.start();
	}, []);

	const stopRecording = useCallback(() => {
		recognitionRef.current?.stop();
	}, []);

	const handleSend = () => {
		const message = input.trim();
		if (!message || !sidecarReady) return;
		if (recording) stopRecording();
		onSend(message);
		setInput("");
	};

	const canSend = sidecarReady && !!input.trim();

	return (
		<div className="bg-surface px-6 py-4">
			<div className="mx-auto max-w-3xl">
				<div
					className={cn(
						"rounded-3xl border border-border bg-surface-2 px-4 pt-3 pb-2 shadow-sm transition-colors focus-within:border-accent/60",
						!sidecarReady && "opacity-60",
					)}
				>
					<textarea
						ref={textareaRef}
						className="w-full resize-none bg-transparent px-1 py-1 text-sm text-fg outline-none placeholder:text-muted min-h-[2.5rem] max-h-80"
						placeholder={sidecarReady ? "随心输入" : "waiting for sidecar..."}
						value={input}
						disabled={!sidecarReady}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								handleSend();
							}
						}}
					/>
					<div className="mt-1 flex items-center justify-between gap-2">
						{/* Left cluster */}
						<div className="flex items-center gap-1">
							<button
								type="button"
								disabled={!sidecarReady}
								className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-40"
								title="Add"
							>
								<Plus className="h-4 w-4" />
							</button>
						</div>

						{/* Right cluster */}
						<div className="flex items-center gap-1">
							{/* Model selector */}
							<div className="relative" ref={modelMenuRef}>
								<button
									type="button"
									disabled={!sidecarReady || models.length === 0}
									onClick={() => setModelMenuOpen((o) => !o)}
									className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-40"
									title="Select model"
								>
									<span className="max-w-[10rem] truncate">{currentModelLabel}</span>
									<ChevronDown className="h-3.5 w-3.5" />
								</button>
								{modelMenuOpen && models.length > 0 && (
									<div className="absolute bottom-full right-0 z-20 mb-2 max-h-72 w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg">
										{models.map((m) => {
											const key = `${m.provider}:${m.id}`;
											const selected = key === currentModelKey;
											return (
												<button
													key={key}
													type="button"
													onClick={() => handleModelSelect(m)}
													className={cn(
														"flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-surface-2",
														selected ? "text-fg" : "text-muted",
													)}
												>
													<span className="min-w-0 flex-1">
														<span className="block truncate text-fg">{m.name}</span>
														<span className="block truncate font-mono text-[10px] text-muted">
															{m.provider}
														</span>
													</span>
													{selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
												</button>
											);
										})}
									</div>
								)}
							</div>

							{/* Mic */}
							<button
								type="button"
								disabled={!hasSpeechSupport || !sidecarReady}
								onClick={recording ? stopRecording : startRecording}
								className={cn(
									"flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40",
									recording
										? "bg-danger/10 text-danger"
										: "text-muted hover:bg-surface hover:text-fg",
								)}
								title={recording ? "Stop dictation" : "Voice input"}
							>
								<Mic className="h-4 w-4" />
							</button>

							{/* Send / Stop */}
							{isRunning ? (
								<button
									type="button"
									onClick={onAbort}
									className="flex h-8 w-8 items-center justify-center rounded-full bg-danger text-white transition-colors hover:opacity-90"
									title="Stop"
								>
									<Square className="h-3.5 w-3.5" />
								</button>
							) : (
								<button
									type="button"
									onClick={handleSend}
									disabled={!canSend}
									className={cn(
										"flex h-8 w-8 items-center justify-center rounded-full transition-colors",
										canSend
											? "bg-accent text-accent-fg hover:opacity-90"
											: "bg-border text-muted",
									)}
									title="Send"
								>
									<ArrowUp className="h-4 w-4" />
								</button>
							)}
						</div>
					</div>
				</div>
				<div className="mt-2 text-center font-mono text-[10px] uppercase tracking-widest text-muted">
					enter to send · shift+enter for newline
				</div>
			</div>
		</div>
	);
}
