import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Square, Mic, Plus, ChevronDown, Check, X, Loader2, Shield, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { sendCommandAwait, setSafeMode } from "@/lib/transport";
import type { RpcSessionState, RpcContextUsage, RpcTokenUsage, ModelInfo } from "@/lib/types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Format a token count compactly (e.g. 12.3k, 1.2M). */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

/** Small circular progress ring showing context window usage. */
function ContextRing({
	contextUsage,
	tokenUsage,
}: {
	contextUsage?: RpcContextUsage;
	tokenUsage?: RpcTokenUsage;
}) {
	const { t } = useTranslation();
	const [hover, setHover] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	const percent = contextUsage?.percent ?? null;
	const tokens = contextUsage?.tokens ?? null;
	const contextWindow = contextUsage?.contextWindow ?? 0;

	// Clamp for the arc; null → show as 0 (unknown).
	const pct = percent !== null ? Math.min(100, Math.max(0, percent)) : 0;
	const known = percent !== null && tokens !== null;

	// Color based on usage level.
	const color = !known
		? "var(--color-muted, #888)"
		: pct > 90
			? "var(--color-danger, #ef4444)"
			: pct > 70
				? "var(--color-warning, #f59e0b)"
				: "var(--color-success, #22c55e)";

	// SVG arc geometry.
	const size = 16;
	const stroke = 2.5;
	const r = (size - stroke) / 2;
	const circumference = 2 * Math.PI * r;
	const dashOffset = circumference * (1 - pct / 100);

	const inputTokens = tokenUsage?.totalInput ?? 0;
	const outputTokens = tokenUsage?.totalOutput ?? 0;
	const cacheRead = tokenUsage?.totalCacheRead ?? 0;
	const cacheWrite = tokenUsage?.totalCacheWrite ?? 0;
	const cost = tokenUsage?.totalCost ?? 0;

	const tooltipLines = known
		? [
				`${t("composer.contextUsed")}: ${formatTokens(tokens!)} / ${formatTokens(contextWindow)} (${percent!.toFixed(1)}%)`,
				`${t("composer.inputTokens")}: ${formatTokens(inputTokens)}`,
				`${t("composer.outputTokens")}: ${formatTokens(outputTokens)}`,
			]
		: [
				`${t("composer.contextUsed")}: ? / ${formatTokens(contextWindow)}`,
				`${t("composer.inputTokens")}: ${formatTokens(inputTokens)}`,
				`${t("composer.outputTokens")}: ${formatTokens(outputTokens)}`,
			];
	if (cacheRead > 0) tooltipLines.push(`${t("composer.cacheRead")}: ${formatTokens(cacheRead)}`);
	if (cacheWrite > 0) tooltipLines.push(`${t("composer.cacheWrite")}: ${formatTokens(cacheWrite)}`);
	if (cost > 0) tooltipLines.push(`${t("composer.cost")}: $${cost.toFixed(3)}`);

	return (
		<div
			ref={wrapRef}
			className="relative flex items-center"
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke="var(--color-border, #333)"
					strokeWidth={stroke}
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={dashOffset}
					transform={`rotate(-90 ${size / 2} ${size / 2})`}
				/>
			</svg>
			{hover && (
				<div className="absolute bottom-full right-0 z-30 mb-2 w-max max-w-[16rem] rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-fg shadow-lg">
					{tooltipLines.map((line, i) => (
						<div key={i} className={i === 0 ? "font-medium" : "text-muted"}>
							{line}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export interface ComposerImage {
	/** base64-encoded payload (no data URL prefix) */
	data: string;
	mimeType: string;
	/** original file name, for display */
	name: string;
	/** data URL for preview thumbnail */
	preview: string;
}

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
	onRefreshState,
}: {
	sidecarReady: boolean;
	isRunning: boolean;
	state: RpcSessionState | null;
	onSend: (message: string, images?: ComposerImage[]) => void;
	onAbort: () => void;
	onRefreshState?: () => void;
}) {
	const [input, setInput] = useState("");
	const [images, setImages] = useState<ComposerImage[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [recording, setRecording] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
	const { t } = useTranslation();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const recognitionRef = useRef<SpeechRecognition | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const audioChunksRef = useRef<Blob[]>([]);
	const mediaStreamRef = useRef<MediaStream | null>(null);
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const approvalMenuRef = useRef<HTMLDivElement>(null);

	// Only show models whose provider has valid auth. Models without auth
	// (hasAuth === false) are hidden from the selector entirely — they can't
	// be used until the user configures an API key in Settings.
	const visibleModels = models.filter((m) => m.hasAuth !== false);

	const hasSpeechSupport =
		typeof window !== "undefined" &&
		(isTauri() ||
			"SpeechRecognition" in window ||
			"webkitSpeechRecognition" in window);

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		(async () => {
			try {
				const r = await sendCommandAwait<{ models: ModelInfo[] }>(
					{ type: "get_available_models" },
					30000,
				);
				if (cancelled) return;
				setModels(r.data?.models ?? []);
			} catch {
				// Silently ignore — models list will be empty until sidecar recovers.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sidecarReady, state?.sessionId]);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
	}, [input]);

	useEffect(() => {
		return () => {
			recognitionRef.current?.stop();
			mediaRecorderRef.current?.stop();
			mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
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

	// Close approval policy menu on outside click.
	useEffect(() => {
		if (!approvalMenuOpen) return;
		const onClick = (e: MouseEvent) => {
			if (approvalMenuRef.current && !approvalMenuRef.current.contains(e.target as Node)) {
				setApprovalMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [approvalMenuOpen]);

	// Optimistic local override — set immediately on user selection so the
	// trigger label updates without waiting for the MODEL_CHANGED round-trip.
	// Cleared whenever state.model catches up to it.
	const [optimisticModel, setOptimisticModel] = useState<ModelInfo | null>(null);
	useEffect(() => {
		if (!optimisticModel || !state?.model) return;
		if (state.model.provider === optimisticModel.provider && state.model.id === optimisticModel.id) {
			setOptimisticModel(null);
		}
	}, [state?.model, optimisticModel]);

	const displayedModel = optimisticModel ?? state?.model ?? null;
	const currentModelLabel = displayedModel?.name ?? displayedModel?.id ?? t("composer.model");

	const handleModelSelect = useCallback(async (m: ModelInfo) => {
		setModelMenuOpen(false);
		setOptimisticModel(m);
		try {
			await sendCommandAwait({ type: "set_model", provider: m.provider, modelId: m.id });
		} catch (e) {
			console.error("[composer] set_model failed:", e);
			// Revert on failure.
			setOptimisticModel(null);
		}
	}, []);

	// Approval policy for the current session (safe mode). Selected inline in
	// the composer so the user can choose per-session without visiting Settings.
	const safeMode = state?.safeMode ?? false;
	const handleApprovalPolicyChange = useCallback(async (enabled: boolean) => {
		setApprovalMenuOpen(false);
		try {
			await setSafeMode(enabled);
			onRefreshState?.();
		} catch (e) {
			console.error("[composer] set_safe_mode failed:", e);
		}
	}, [onRefreshState]);

	const startRecording = useCallback(() => {
		if (isTauri()) {
			// Desktop (Tauri): use MediaRecorder to capture audio, then
			// transcribe via the Rust backend (OpenAI Whisper API).
			void (async () => {
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					mediaStreamRef.current = stream;
					const mimeType = MediaRecorder.isTypeSupported("audio/webm")
						? "audio/webm"
						: "audio/mp4";
					const recorder = new MediaRecorder(stream, { mimeType });
					audioChunksRef.current = [];
					recorder.ondataavailable = (e) => {
						if (e.data.size > 0) audioChunksRef.current.push(e.data);
					};
					recorder.onstop = () => {
						// Stop all audio tracks.
						mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
						mediaStreamRef.current = null;

						const blob = new Blob(audioChunksRef.current, { type: mimeType });
						audioChunksRef.current = [];
						if (blob.size === 0) {
							setTranscribing(false);
							return;
						}
						// Convert to base64 and invoke Tauri transcribe command.
						const reader = new FileReader();
						reader.onload = async () => {
							const result = reader.result;
							if (typeof result !== "string") {
								setTranscribing(false);
								return;
							}
							const comma = result.indexOf(",");
							const b64 = comma >= 0 ? result.slice(comma + 1) : result;
							try {
								const { invoke } = await import("@tauri-apps/api/core");
								const text = await invoke<string>("transcribe_audio", {
									audioB64: b64,
									mimeType,
								});
								if (text) {
									setInput((prev) => (prev ? prev.trimEnd() + " " : "") + text);
								}
							} catch (e) {
								console.error("[composer] transcribe failed:", e);
								const msg = e instanceof Error ? e.message : String(e);
								// Show error as a brief placeholder — user will see it.
								setInput((prev) => prev + (prev ? " " : "") + `[${msg}]`);
							} finally {
								setTranscribing(false);
							}
						};
						reader.onerror = () => setTranscribing(false);
						reader.readAsDataURL(blob);
					};
					mediaRecorderRef.current = recorder;
					setRecording(true);
					recorder.start();
				} catch (e) {
					console.error("[composer] mic access failed:", e);
					setRecording(false);
					setTranscribing(false);
				}
			})();
			return;
		}

		// Browser: use Web Speech API for real-time dictation.
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
		if (isTauri()) {
			const recorder = mediaRecorderRef.current;
			if (recorder && recorder.state !== "inactive") {
				setRecording(false);
				setTranscribing(true);
				recorder.stop();
			}
			return;
		}
		recognitionRef.current?.stop();
	}, []);

	const addFiles = useCallback(async (files: FileList | File[]) => {
		const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
		const loaded = await Promise.all(
			imageFiles.map(
				(file) =>
					new Promise<ComposerImage | null>((resolve) => {
						const reader = new FileReader();
						reader.onload = () => {
							const result = reader.result;
							if (typeof result !== "string") {
								resolve(null);
								return;
							}
							// result is a data URL: "data:<mime>;base64,<data>"
							const comma = result.indexOf(",");
							const data = comma >= 0 ? result.slice(comma + 1) : result;
							resolve({
								data,
								mimeType: file.type || "image/png",
								name: file.name,
								preview: result,
							});
						};
						reader.onerror = () => resolve(null);
						reader.readAsDataURL(file);
					}),
			),
		);
		const valid = loaded.filter((i): i is ComposerImage => i !== null);
		if (valid.length > 0) setImages((prev) => [...prev, ...valid]);
	}, []);

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			if (e.target.files) void addFiles(e.target.files);
			e.target.value = "";
		},
		[addFiles],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const files = Array.from(e.clipboardData.files);
			if (files.length > 0) {
				e.preventDefault();
				void addFiles(files);
			}
		},
		[addFiles],
	);

	const removeImage = useCallback((index: number) => {
		setImages((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const handleSend = () => {
		const message = input.trim();
		if ((!message && images.length === 0) || !sidecarReady) return;
		if (recording) stopRecording();
		onSend(message, images.length > 0 ? images : undefined);
		setInput("");
		setImages([]);
	};

	const canSend = sidecarReady && (!!input.trim() || images.length > 0);

	return (
		<div className="bg-surface px-6 py-4">
			<div className="mx-auto max-w-3xl">
				<div
					className={cn(
						"rounded-3xl border border-border bg-surface-2 px-4 pt-3 pb-2 shadow-sm transition-colors focus-within:border-accent/60",
						!sidecarReady && "opacity-60",
					)}
				>
					{images.length > 0 && (
						<div className="mb-2 flex flex-wrap gap-2">
							{images.map((img, i) => (
								<div
									key={`${img.name}-${i}`}
									className="group relative h-16 w-16 overflow-hidden rounded-lg border border-border"
								>
									<img
										src={img.preview}
										alt={img.name}
										className="h-full w-full object-cover"
									/>
									<button
										type="button"
										onClick={() => removeImage(i)}
										className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
										title={t("common.remove")}
									>
										<X className="h-3 w-3" />
									</button>
								</div>
							))}
						</div>
					)}
					<textarea
						ref={textareaRef}
						className="w-full resize-none bg-transparent px-1 py-1 text-sm text-fg outline-none placeholder:text-muted min-h-[2.5rem] max-h-80"
						placeholder={sidecarReady ? t("composer.placeholder") : t("composer.waitingForSidecar")}
						value={input}
						disabled={!sidecarReady}
						onChange={(e) => setInput(e.target.value)}
						onPaste={handlePaste}
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
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								multiple
								className="hidden"
								onChange={handleFileChange}
							/>
							<button
								type="button"
								disabled={!sidecarReady}
								onClick={() => fileInputRef.current?.click()}
								className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-40"
								title={t("composer.attachImage")}
							>
								<Plus className="h-4 w-4" />
							</button>

							{/* Approval policy selector — chooses safe mode for the current session */}
							<div className="relative" ref={approvalMenuRef}>
								<button
									type="button"
									disabled={!sidecarReady}
									onClick={() => setApprovalMenuOpen((o) => !o)}
									className={cn(
										"flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-40",
										safeMode
											? "text-warning hover:bg-surface"
											: "text-muted hover:bg-surface hover:text-fg",
									)}
									title={t("composer.approvalPolicy")}
								>
									{safeMode ? (
										<Shield className="h-3.5 w-3.5" />
									) : (
										<ShieldCheck className="h-3.5 w-3.5" />
									)}
									<span>{safeMode ? t("composer.approvalOn") : t("composer.approvalOff")}</span>
									<ChevronDown className="h-3 w-3" />
								</button>
								{approvalMenuOpen && (
									<div className="absolute bottom-full left-0 z-20 mb-2 w-56 rounded-xl border border-border bg-surface p-1 shadow-lg">
										<button
											type="button"
											onClick={() => void handleApprovalPolicyChange(false)}
											className={cn(
												"flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-2",
												!safeMode ? "text-fg" : "text-muted",
											)}
										>
											<ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
											<span className="min-w-0 flex-1">
												<span className="block text-fg">{t("composer.approvalOff")}</span>
												<span className="block text-[10px] text-muted">{t("composer.approvalOffHint")}</span>
											</span>
											{!safeMode && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
										</button>
										<button
											type="button"
											onClick={() => void handleApprovalPolicyChange(true)}
											className={cn(
												"flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-2",
												safeMode ? "text-fg" : "text-muted",
											)}
										>
											<Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
											<span className="min-w-0 flex-1">
												<span className="block text-fg">{t("composer.approvalOn")}</span>
												<span className="block text-[10px] text-muted">{t("composer.approvalOnHint")}</span>
											</span>
											{safeMode && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
										</button>
									</div>
								)}
							</div>
						</div>

						{/* Right cluster */}
						<div className="flex items-center gap-1">
							{/* Context usage ring — shows current context window occupancy */}
							<ContextRing
								contextUsage={state?.contextUsage}
								tokenUsage={state?.tokenUsage}
							/>

							{/* Model selector */}
							<div className="relative" ref={modelMenuRef}>
								<button
									type="button"
									disabled={!sidecarReady || visibleModels.length === 0}
									onClick={() => setModelMenuOpen((o) => !o)}
									className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-40"
									title={visibleModels.length === 0 ? t("composer.noModelsAvailable") : t("composer.selectModel")}
								>
									<span className="max-w-[10rem] truncate">{currentModelLabel}</span>
									<ChevronDown className="h-3.5 w-3.5" />
								</button>
								{modelMenuOpen && visibleModels.length > 0 && (
									<div className="absolute bottom-full right-0 z-20 mb-2 max-h-72 w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg">
										{visibleModels.map((m) => {
											const key = `${m.provider}:${m.id}`;
											const selected = displayedModel
												? m.provider === displayedModel.provider && m.id === displayedModel.id
												: false;
											return (
												<button
													key={key}
													type="button"
													onClick={() => handleModelSelect(m)}
													className={cn(
														"flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
														"hover:bg-surface-2",
														selected ? "text-fg" : "text-muted",
													)}
												>
													<span className="min-w-0 flex-1">
														<span className="block truncate text-fg">{m.name}</span>
														<span className="block truncate font-mono text-[10px] text-muted">
															{m.provider}
														</span>
													</span>
													{selected ? (
														<Check className="h-3.5 w-3.5 shrink-0 text-accent" />
													) : null}
												</button>
											);
										})}
									</div>
								)}
								{modelMenuOpen && visibleModels.length === 0 && models.length > 0 && (
									<div className="absolute bottom-full right-0 z-20 mb-2 w-64 rounded-xl border border-border bg-surface p-1 shadow-lg">
										<a
											href="/#/settings"
											className="block rounded-lg bg-surface-2 px-2.5 py-1.5 text-center text-[11px] text-accent hover:opacity-80"
										>
											{t("composer.configureApiKey")}
										</a>
									</div>
								)}
							</div>

							{/* Mic */}
							<button
								type="button"
								disabled={!hasSpeechSupport || !sidecarReady || transcribing}
								onClick={recording ? stopRecording : startRecording}
								className={cn(
									"flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40",
									recording
										? "bg-danger/10 text-danger"
										: transcribing
											? "text-accent"
											: "text-muted hover:bg-surface hover:text-fg",
								)}
								title={
									transcribing
										? t("composer.transcribing")
										: recording
											? t("composer.stopDictation")
											: t("composer.voiceInput")
								}
							>
								{transcribing ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<Mic className="h-4 w-4" />
								)}
							</button>

							{/* Send / Stop */}
							{isRunning ? (
								<button
									type="button"
									onClick={onAbort}
									className="flex h-8 w-8 items-center justify-center rounded-full bg-danger text-white transition-colors hover:opacity-90"
									title={t("composer.stop")}
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
									title={t("composer.send")}
								>
									<ArrowUp className="h-4 w-4" />
								</button>
							)}
						</div>
					</div>
				</div>
				<div className="mt-2 text-center font-mono text-[10px] uppercase tracking-widest text-muted">
					{t("composer.sendHint")}
				</div>
			</div>
		</div>
	);
}
