import { useEffect, useRef, useState, useCallback } from "react";
import { sendCommandAwait, stopSidecar } from "./lib/rpc-client";
import { subscribeEvents, subscribeSidecarExit } from "./lib/event-stream";
import type { RpcSessionState, TypedEvent } from "./lib/types";

interface TimelineItem {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	title: string;
	text: string;
	status: string;
	streaming?: boolean;
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as Record<string, unknown>;
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return (msg.content as Array<Record<string, unknown>>)
			.map((block) => {
				if (!block || typeof block !== "object") return "";
				if (block.type === "text") return String(block.text ?? "");
				if (block.type === "thinking") return "";
				if (block.type === "toolCall") return "Tool call: " + String(block.name ?? "tool");
				if (block.type === "image") return "[image]";
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export default function App() {
	const [state, setState] = useState<RpcSessionState | null>(null);
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [input, setInput] = useState("");
	const [error, setError] = useState("");
	const [sidecarReady, setSidecarReady] = useState(false);
	const [sidecarExitCode, setSidecarExitCode] = useState<number | null>(null);
	const activeAssistantRef = useRef<string | null>(null);
	const timelineRef = useRef<HTMLDivElement>(null);
	const sidecarStartedRef = useRef(false);

	// Start sidecar on mount. Single init_sidecar call spawns sidecar + sends get_state.
	// Guard against React StrictMode double-invocation.
	useEffect(() => {
		if (sidecarStartedRef.current) return;
		sidecarStartedRef.current = true;
		let cancelled = false;
		(async () => {
			try {
				const core = await import("@tauri-apps/api/core");
				const result = await core.invoke("init_sidecar");
				console.log("[init] init_sidecar raw result:", result, typeof result);
				if (cancelled) return;
				// Be robust: result may be a string (JSON text) or already an object.
				let parsed = result;
				if (typeof parsed === "string") {
					parsed = JSON.parse(parsed);
				}
				console.log("[init] parsed:", parsed);
				// Accept either { data: {...} } (response wrapper) or bare state object.
				const state = (parsed as any)?.data ?? parsed ?? null;
				console.log("[init] state:", state);
				setState(state);
				setSidecarReady(true);
				console.log("[init] sidecarReady set to true");
			} catch (e) {
				console.error("[init] FAILED:", e);
				setError(`Failed to start sidecar: ${e instanceof Error ? e.message : String(e)}`);
			}
		})();
		return () => {
			cancelled = true;
			// NOTE: do NOT call stopSidecar() here. React StrictMode unmounts
			// and remounts effects once on mount in dev, which would kill the
			// sidecar immediately after it starts, and the remount is guarded
			// out by sidecarStartedRef so it would never restart -> stuck on
			// "starting". The sidecar is owned by the OS process and is cleaned
			// up when the Tauri window/process exits.
		};
	}, []);

	// Subscribe to events.
	useEffect(() => {
		if (!sidecarReady) return;
		const unlisteners: Array<() => void> = [];
		(async () => {
			const un1 = await subscribeEvents((event) => handleEvent(event));
			unlisteners.push(un1);
			const un2 = await subscribeSidecarExit((code) => {
				setSidecarExitCode(code);
				setSidecarReady(false);
			});
			unlisteners.push(un2);
		})();
		return () => unlisteners.forEach((fn) => fn());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sidecarReady]);

	// Auto-scroll.
	useEffect(() => {
		if (timelineRef.current) {
			timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
		}
	}, [items]);

	const handleEvent = useCallback((event: TypedEvent) => {
		switch (event.type) {
			case "USER_MESSAGE": {
				const text = messageText(event.payload);
				setItems((prev) => [
					...prev,
					{ id: event.event_id, role: "user", title: "You", text, status: "" },
				]);
				break;
			}
			case "AGENT_TURN_START": {
				const id = event.event_id;
				activeAssistantRef.current = id;
				setItems((prev) => [
					...prev,
					{ id, role: "assistant", title: "Pizza", text: "", status: "STREAMING", streaming: true },
				]);
				break;
			}
			case "AGENT_TURN_COMPLETED": {
				const id = activeAssistantRef.current;
				if (id) {
					setItems((prev) =>
						prev.map((it) => (it.id === id ? { ...it, status: "DONE", streaming: false } : it)),
					);
					activeAssistantRef.current = null;
				}
				void sendCommandAwait<{ state?: RpcSessionState }>({ type: "get_state" })
					.then((r) => setState(r.data?.state ?? null))
					.catch(() => {});
				break;
			}
			case "ASSISTANT_MESSAGE": {
				const text = messageText(event.payload);
				const id = activeAssistantRef.current;
				if (id) {
					setItems((prev) =>
						prev.map((it) => (it.id === id ? { ...it, text, status: "DONE", streaming: false } : it)),
					);
				} else {
					setItems((prev) => [
						...prev,
						{ id: event.event_id, role: "assistant", title: "Pizza", text, status: "DONE" },
					]);
				}
				break;
			}
			case "MODEL_CHANGED":
			case "THINKING_LEVEL_CHANGED":
				void sendCommandAwait<{ state?: RpcSessionState }>({ type: "get_state" })
					.then((r) => setState(r.data?.state ?? null))
					.catch(() => {});
				break;
			default:
				break;
		}
	}, []);

	const handleSend = useCallback(async () => {
		const message = input.trim();
		if (!message || !sidecarReady) return;
		setInput("");
		setError("");
		try {
			if (state?.isStreaming) {
				await sendCommandAwait({ type: "follow_up", message });
			} else {
				await sendCommandAwait({ type: "prompt", message });
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [input, sidecarReady, state?.isStreaming]);

	const handleAbort = useCallback(async () => {
		try {
			await sendCommandAwait({ type: "abort" });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const isRunning = state?.isStreaming ?? false;

	return (
		<div className="app">
			<header className="topbar">
				<div className="brand">
					<div className="logo" />
					<div>
						<div className="title">Pizza</div>
						<div className="path">{state?.sessionFile ?? "—"}</div>
					</div>
				</div>
				<div className="meta">
					<span className="pill">
						{state?.model ? `${state.model.provider}/${state.model.id}` : "no model"}
					</span>
					<span className={`pill ${isRunning ? "running" : ""}`}>
						{isRunning ? "● running" : "○ idle"}
					</span>
					<button onClick={handleAbort} disabled={!isRunning} className="danger">
						Stop
					</button>
				</div>
			</header>

			<main className="timeline-wrap">
				<div className="timeline" ref={timelineRef}>
					{items.length === 0 && (
						<div className="empty">
							<div className="empty-logo" />
							<div className="empty-title">PIZZA</div>
							<div className="empty-sub">
								{sidecarReady
									? "> ready. ask anything about this project."
									: sidecarExitCode !== null
										? `x sidecar exited (code ${sidecarExitCode})`
										: "> starting..."}
							</div>
							<div className="empty-hint">[ ENTER ] to send · [ SHIFT+ENTER ] newline</div>
						</div>
					)}
					{items.map((item) => (
						<div key={item.id} className={`item ${item.role}`}>
							<div className="item-head">
								<span className="item-title">
									<span className="avatar" />
									{item.title}
								</span>
								<span className="item-status">{item.status}</span>
							</div>
							<div className={`item-body ${item.streaming ? "streaming-caret" : ""}`}>
								{item.text || (item.streaming ? "" : "")}
							</div>
						</div>
					))}
				</div>
			</main>

			<footer className="composer">
				<form
					className="composer-inner"
					onSubmit={(e) => {
						e.preventDefault();
						void handleSend();
					}}
				>
					<textarea
						placeholder={sidecarReady ? "> ask pizza to work on this project" : "> waiting for sidecar..."}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						disabled={!sidecarReady}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void handleSend();
							}
						}}
					/>
					<button type="submit" className="primary" disabled={!sidecarReady || !input.trim()}>
						Send
					</button>
				</form>
				{error && <div className="error-line">! {error}</div>}
			</footer>
		</div>
	);
}
